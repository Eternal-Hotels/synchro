"use strict";

const fs = require("fs");
const path = require("path");

const { MAX_UPLOAD_BYTES, STORAGE_DIR } = require("../config");
const { ensureDirectory, sanitizeRelativePath } = require("../utils/files");
const { readRequestBuffer, sendJson } = require("../utils/http");
const { verifyApiKey } = require("../utils/security");

async function handleUpload(req, res, slug, storage) {
  const keyRecord = await storage.findKeyBySlug(slug);
  if (!keyRecord) {
    return sendJson(res, 404, { error: "Unknown upload endpoint." });
  }

  if (keyRecord.revoked) {
    return sendJson(res, 403, { error: "This endpoint key has been revoked." });
  }

  const suppliedKey = extractApiKey(req);
  if (!suppliedKey || !verifyApiKey(suppliedKey, keyRecord.apiKeyHash, keyRecord.apiKeySalt)) {
    return sendJson(res, 401, { error: "Invalid or missing API key." });
  }

  await storage.recordKeyUsage(keyRecord.slug);

  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    return sendJson(res, 400, { error: "Expected multipart/form-data upload." });
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const body = await readRequestBuffer(req, MAX_UPLOAD_BYTES);
  const upload = parseMultipartUpload(body, boundary);
  if (!upload) {
    return sendJson(res, 400, { error: "Could not parse uploaded file." });
  }

  const endpointDir = path.join(STORAGE_DIR, keyRecord.slug);
  ensureDirectory(endpointDir);

  const relativePath = sanitizeRelativePath(req.headers["x-relative-path"] || upload.filename);
  if (!relativePath) {
    return sendJson(res, 400, { error: "Invalid filename or relative path." });
  }

  const targetPath = path.join(endpointDir, relativePath);
  ensureDirectory(path.dirname(targetPath));
  fs.writeFileSync(targetPath, upload.content);

  return sendJson(res, 201, {
    message: "Upload successful.",
    endpoint: keyRecord.slug,
    storedAs: relativePath,
    bytes: upload.content.length
  });
}

async function sendStoredFile(res, slug, requestedFilename, storage) {
  let fileInfo;
  try {
    fileInfo = await resolveStoredFile(slug, requestedFilename, storage);
  } catch (error) {
    const statusCode = error.message === "Endpoint key not found."
      ? 404
      : error.message === "File not found."
        ? 404
        : 400;
    return sendJson(res, statusCode, { error: error.message });
  }

  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${fileInfo.filename.replace(/"/g, "")}"`,
    "Content-Length": fs.statSync(fileInfo.fullPath).size
  });

  fs.createReadStream(fileInfo.fullPath).pipe(res);
}

async function resolveStoredFile(slug, requestedFilename, storage) {
  const keyRecord = await storage.findKeyBySlug(slug);
  if (!keyRecord) {
    throw new Error("Endpoint key not found.");
  }

  const relativePath = sanitizeRelativePath(requestedFilename);
  if (!relativePath) {
    throw new Error("Invalid file path.");
  }

  const filename = path.basename(relativePath);
  const fullPath = path.join(STORAGE_DIR, slug, relativePath);

  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    throw new Error("File not found.");
  }

  return {
    slug,
    relativePath,
    filename,
    fullPath
  };
}

function extractApiKey(req) {
  const headerKey = req.headers["x-api-key"];
  if (headerKey) {
    return String(headerKey);
  }

  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function parseMultipartUpload(bodyBuffer, boundary) {
  const marker = `--${boundary}`;
  const parts = bodyBuffer.toString("binary").split(marker);

  for (const part of parts) {
    if (!part || part === "--\r\n" || part === "--") {
      continue;
    }

    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      continue;
    }

    const rawHeaders = part.slice(0, headerEnd);
    const dispositionMatch = rawHeaders.match(/filename="([^"]+)"/i);
    if (!dispositionMatch) {
      continue;
    }

    let contentSection = part.slice(headerEnd + 4);
    if (contentSection.endsWith("\r\n")) {
      contentSection = contentSection.slice(0, -2);
    }
    if (contentSection.endsWith("--")) {
      contentSection = contentSection.slice(0, -2);
    }

    return {
      filename: dispositionMatch[1],
      content: Buffer.from(contentSection, "binary")
    };
  }

  return null;
}

module.exports = {
  handleUpload,
  sendStoredFile,
  resolveStoredFile
};
