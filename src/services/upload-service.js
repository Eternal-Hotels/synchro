"use strict";

// "fs" gives us file-system operations: read, write, check existence, stream.
const fs = require("fs");

// "path" gives us cross-platform path manipulation.
const path = require("path");

// Configuration: the 25 MB upload cap and the storage folder root.
const { MAX_UPLOAD_BYTES, STORAGE_DIR } = require("../config");

// File utilities: create missing directories, sanitize user-supplied paths.
const { ensureDirectory, sanitizeRelativePath } = require("../utils/files");

// HTTP utilities: read the raw request body into memory, send JSON responses.
const { readRequestBuffer, sendJson } = require("../utils/http");

// Security: verify the supplied API key against the stored hash.
const { verifyApiKey } = require("../utils/security");

// Called by the upload route for every POST /api/upload/:slug request.
// This function does all the work: authenticate, parse, write, respond.
async function handleUpload(req, res, slug, storage) {
  // Look up the endpoint record by its slug in the database.
  // If the slug doesn't exist, there's nothing to upload to.
  const keyRecord = await storage.findKeyBySlug(slug);
  if (!keyRecord) {
    return sendJson(res, 404, { error: "Unknown upload endpoint." });
  }

  // A revoked endpoint rejects uploads even if the API key is still valid.
  // Revocation is useful when you need to stop a client without deleting its history.
  if (keyRecord.revoked) {
    return sendJson(res, 403, { error: "This endpoint key has been revoked." });
  }

  // Pull the API key out of the request (either X-API-Key header or Bearer token).
  const suppliedKey = extractApiKey(req);

  // Verify the key against the stored hash. We never store the plaintext key.
  // verifyApiKey uses scrypt + timingSafeEqual so it can't be exploited by timing.
  if (!suppliedKey || !verifyApiKey(suppliedKey, keyRecord.apiKeyHash, keyRecord.apiKeySalt)) {
    return sendJson(res, 401, { error: "Invalid or missing API key." });
  }

  // Record the current timestamp as this endpoint's "last used" time.
  // Useful for auditing which endpoints are active.
  await storage.recordKeyUsage(keyRecord.slug);

  // Multipart/form-data is the format browsers use to upload files in HTML forms.
  // The Python companion also uses this format. The boundary is a random string
  // that separates one "part" (one file) from another in the request body.
  // Example Content-Type header:
  //   multipart/form-data; boundary=----SynchroBoundaryABC123
  const contentType = req.headers["content-type"] || "";

  // This regex extracts the boundary value from the Content-Type header.
  // The boundary can optionally be quoted (boundary="foo") or unquoted (boundary=foo).
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    return sendJson(res, 400, { error: "Expected multipart/form-data upload." });
  }

  // boundaryMatch[1] is the quoted form; boundaryMatch[2] is the unquoted form.
  const boundary = boundaryMatch[1] || boundaryMatch[2];

  // Read the entire request body into a Buffer (raw bytes), up to 25 MB.
  // readRequestBuffer streams the body in chunks and enforces the size cap.
  const body = await readRequestBuffer(req, MAX_UPLOAD_BYTES);

  // Parse the multipart body to extract the uploaded file's name and content.
  const upload = parseMultipartUpload(body, boundary);
  if (!upload) {
    return sendJson(res, 400, { error: "Could not parse uploaded file." });
  }

  // Make sure the endpoint's storage folder exists.
  // path.join builds "storage/warehouse-laptop" etc.
  const endpointDir = path.join(STORAGE_DIR, keyRecord.slug);
  ensureDirectory(endpointDir);

  // Decide where on disk to save this file.
  // Priority: the X-Relative-Path header (set by the Python sync_client for folder syncs).
  // Fallback: the filename extracted from the multipart body.
  // sanitizeRelativePath rejects ".." path-traversal attempts.
  const relativePath = sanitizeRelativePath(
    req.headers["x-relative-path"] || upload.filename
  );
  if (!relativePath) {
    return sendJson(res, 400, { error: "Invalid filename or relative path." });
  }

  // Combine the endpoint directory + the relative path.
  // Example: "storage/warehouse-laptop/menus/daily.htm"
  const targetPath = path.join(endpointDir, relativePath);

  // Create any intermediate directories that don't exist yet.
  // path.dirname("storage/warehouse-laptop/menus/daily.htm") → "storage/warehouse-laptop/menus"
  ensureDirectory(path.dirname(targetPath));

  // Write the file to disk synchronously (blocking).
  // upload.content is a Buffer containing the raw file bytes.
  fs.writeFileSync(targetPath, upload.content);

  // Send a success response back to the Python client.
  return sendJson(res, 201, {
    message: "Upload successful.",
    endpoint: keyRecord.slug,
    storedAs: relativePath,
    bytes: upload.content.length
  });
}

// Stream a file from storage back to the browser as a download.
// Called by the admin panel when a user clicks a download link.
async function sendStoredFile(res, slug, requestedFilename, storage) {
  // Verify the endpoint still exists in the database.
  const keyRecord = await storage.findKeyBySlug(slug);
  if (!keyRecord) {
    return sendJson(res, 404, { error: "Endpoint key not found." });
  }

  // Sanitize the path argument so malicious URLs can't escape the storage folder.
  const relativePath = sanitizeRelativePath(requestedFilename);
  if (!relativePath) {
    return sendJson(res, 400, { error: "Invalid file path." });
  }

  // Extract just the filename part for the download prompt.
  // E.g.: "menus/daily.htm" → "daily.htm"
  const filename = path.basename(relativePath);

  // Build the full absolute path to the file on disk.
  const fullPath = path.join(STORAGE_DIR, slug, relativePath);

  // Check that the file actually exists and is a regular file (not a directory).
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return sendJson(res, 404, { error: "File not found." });
  }

  // Send HTTP headers that tell the browser to download the file.
  res.writeHead(200, {
    // application/octet-stream means "generic binary file" — the browser will
    // prompt the user to save it rather than trying to display it.
    "Content-Type": "application/octet-stream",
    // Content-Disposition: attachment tells the browser to download, not display.
    // The filename= part suggests what to name the saved file.
    // We strip double-quotes from the filename to prevent header injection.
    "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
    // Tell the browser the exact file size so it can show a progress bar.
    "Content-Length": fs.statSync(fullPath).size
  });

  // fs.createReadStream reads the file in chunks (memory-efficient for large files).
  // .pipe(res) sends each chunk to the HTTP response as it's read,
  // and automatically closes the response when the file is fully sent.
  fs.createReadStream(fullPath).pipe(res);
}

// Extract the API key from the incoming request.
// The Python companion can send it in two ways:
//   1. X-API-Key: <key>               (custom header — simpler)
//   2. Authorization: Bearer <key>    (standard Bearer token format)
function extractApiKey(req) {
  // Check the custom header first.
  const headerKey = req.headers["x-api-key"];
  if (headerKey) {
    return String(headerKey);
  }

  // Fall back to parsing a Bearer token from the Authorization header.
  const authHeader = req.headers.authorization || "";
  // This regex matches "Bearer <token>" and captures the token part.
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

// Parse a multipart/form-data body and extract the first file part.
// Multipart bodies look like:
//
//   --<boundary>\r\n
//   Content-Disposition: form-data; name="file"; filename="daily.htm"\r\n
//   Content-Type: text/html\r\n
//   \r\n
//   <file content bytes>\r\n
//   --<boundary>--\r\n
//
// We only need to handle a single file upload (one part per request).
function parseMultipartUpload(bodyBuffer, boundary) {
  // We have to parse the body as binary (latin-1) to handle non-UTF-8 file content.
  // "binary" in Node.js is an alias for "latin1" (ISO-8859-1), which is a 1:1
  // byte-to-character mapping and is safe for arbitrary binary data.
  const marker = `--${boundary}`;
  const parts = bodyBuffer.toString("binary").split(marker);

  // Iterate over every part in the body.
  for (const part of parts) {
    // Skip the empty string before the first boundary and the final "--" terminator.
    if (!part || part === "--\r\n" || part === "--") {
      continue;
    }

    // Find the blank line (\r\n\r\n) that separates part headers from part content.
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      continue;
    }

    // Everything before the blank line is the part's headers.
    const rawHeaders = part.slice(0, headerEnd);

    // Look for a Content-Disposition header that names a file.
    // E.g.: Content-Disposition: form-data; name="file"; filename="daily.htm"
    const dispositionMatch = rawHeaders.match(/filename="([^"]+)"/i);
    if (!dispositionMatch) {
      // This part has no filename — not the file part, skip it.
      continue;
    }

    // Everything after the blank line is the actual file content.
    // headerEnd + 4 skips past the "\r\n\r\n" blank line.
    let contentSection = part.slice(headerEnd + 4);

    // Strip the trailing \r\n added by the multipart format.
    if (contentSection.endsWith("\r\n")) {
      contentSection = contentSection.slice(0, -2);
    }
    // Strip the trailing "--" that marks the end of the boundary.
    if (contentSection.endsWith("--")) {
      contentSection = contentSection.slice(0, -2);
    }

    // Return the filename and file content.
    // Buffer.from(..., "binary") converts the binary string back to raw bytes.
    return {
      filename: dispositionMatch[1],
      content: Buffer.from(contentSection, "binary")
    };
  }

  // No file part found in the body.
  return null;
}

// Export the two public functions.
module.exports = {
  handleUpload,
  sendStoredFile
};
