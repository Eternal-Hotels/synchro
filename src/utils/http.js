"use strict";

// Pull in session constants — the cookie name and how long sessions live.
const { SESSION_COOKIE, SESSION_TTL_MS } = require("../config");

// Convert a raw byte count into a human-readable string.
// E.g.: 500 → "500 B", 2048 → "2.0 KB", 5242880 → "5.0 MB"
// Used in directory listings and error messages about upload size limits.
function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    // .toFixed(1) formats to one decimal place, e.g. 1536 → "1.5 KB"
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Create an Error object that carries an HTTP status code.
// Route handlers throw these, and the catch block in server.js picks
// the right HTTP status code from error.statusCode.
// Without this, all crashes would produce a 500 error, even for user mistakes.
function httpError(statusCode, message) {
  // Route handlers throw these so the shared catch block can pick the right HTTP status.
  const error = new Error(message);
  // Attach the status code directly to the error object as a custom property.
  error.statusCode = statusCode;
  return error;
}

// Read a specific cookie from an incoming HTTP request.
// Cookies arrive in a single "Cookie: name1=val1; name2=val2" header string.
// We have to split and parse it ourselves because Node's raw http module
// does not do that for us.
function getCookie(req, name) {
  // req.headers.cookie is the raw cookie header, e.g. "synchro_session=abc123; theme=dark"
  const header = req.headers.cookie || "";

  // Split on ";" to get individual "key=value" strings, trim whitespace, drop empty strings.
  const parts = header.split(";").map((item) => item.trim()).filter(Boolean);

  for (const part of parts) {
    // Find the position of the first "=" sign.
    const index = part.indexOf("=");
    if (index === -1) {
      continue; // Malformed cookie with no "=" — skip it.
    }
    // Everything before the first "=" is the key.
    const key = part.slice(0, index);
    // Everything after is the value.
    const value = part.slice(index + 1);
    if (key === name) {
      // decodeURIComponent reverses any percent-encoding (e.g. %3D → =).
      return decodeURIComponent(value);
    }
  }
  // Return empty string (falsy) if the cookie wasn't found.
  return "";
}

// Set the session cookie on the HTTP response.
// This tells the browser to store the token and send it back automatically
// with every future request to this server.
function setSessionCookie(res, token) {
  // Check if we are running in production so we can add the Secure flag.
  // The Secure flag tells the browser to only send the cookie over HTTPS.
  const isSecure = process.env.NODE_ENV === "production";

  // Build the cookie string. Each attribute is separated by "; ".
  const attributes = [
    // The actual name=value pair. encodeURIComponent handles any special chars in the token.
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    // Path=/ means the browser sends the cookie for ALL paths on this origin.
    "Path=/",
    // HttpOnly means JavaScript running in the browser CANNOT read this cookie.
    // This protects the session token from XSS (cross-site scripting) attacks.
    "HttpOnly",
    // SameSite=Strict means the browser will NOT send this cookie when the
    // request originates from a different website. Protects against CSRF attacks.
    "SameSite=Strict",
    // Max-Age tells the browser how long (in seconds) to keep the cookie.
    // SESSION_TTL_MS is in milliseconds, so we divide by 1000.
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  // Add Secure flag only in production (HTTP + Secure would break local dev).
  if (isSecure) {
    attributes.push("Secure");
  }
  // res.setHeader writes one HTTP response header.
  res.setHeader("Set-Cookie", attributes.join("; "));
}

// Instruct the browser to immediately delete the session cookie.
// Max-Age=0 means "expire right now."
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

// Read the entire request body as raw bytes (a Buffer), up to maxBytes.
// In Node.js, request bodies come in as a "stream" — chunks of data
// that arrive over time. We have to collect all the chunks ourselves.
function readRequestBuffer(req, maxBytes) {
  // We return a Promise so callers can "await" it — they pause here until
  // the full body has arrived (or an error occurs).
  return new Promise((resolve, reject) => {
    // "chunks" will accumulate each piece of the body as it arrives.
    const chunks = [];
    // "total" tracks how many bytes we've received so far.
    let total = 0;

    // The "data" event fires whenever a chunk of the request body arrives.
    req.on("data", (chunk) => {
      total += chunk.length;
      // Reject immediately if the request is too large.
      // req.destroy() forcibly closes the underlying TCP connection.
      if (total > maxBytes) {
        reject(httpError(413, `Upload exceeds ${formatBytes(maxBytes)}.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    // The "end" event fires when the entire body has been received.
    // Buffer.concat merges all chunks into one single Buffer.
    req.on("end", () => resolve(Buffer.concat(chunks)));

    // The "error" event fires if the connection drops or something goes wrong.
    req.on("error", reject);
  });
}

// Read and parse the request body as JSON.
// Used for small admin API requests (creating keys, managing users, etc.).
async function readJsonBody(req) {
  // 1 MB limit for JSON bodies — much smaller than the 25 MB upload limit.
  const buffer = await readRequestBuffer(req, 1024 * 1024);

  // If the body is empty, return an empty object rather than throwing.
  if (!buffer.length) {
    return {};
  }

  try {
    // buffer.toString("utf8") converts the raw bytes to a string.
    // JSON.parse converts the JSON string to a JavaScript object.
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    // If the body isn't valid JSON, throw a 400 (Bad Request) error.
    throw httpError(400, "Invalid JSON body.");
  }
}

// Send a JSON response. Every JSON API endpoint uses this helper to ensure
// consistent headers and encoding.
function sendJson(res, statusCode, payload) {
  // JSON.stringify converts the payload object to a JSON string.
  // null, 2 means "pretty-print with 2-space indentation" (makes responses readable).
  const body = JSON.stringify(payload, null, 2);

  // res.writeHead() sends the HTTP status code and response headers.
  res.writeHead(statusCode, {
    // Tell the browser that the body is JSON text encoded as UTF-8.
    "Content-Type": "application/json; charset=utf-8",
    // Tell the browser exactly how many bytes are in the body.
    // Buffer.byteLength counts bytes, not characters (important for multi-byte unicode).
    "Content-Length": Buffer.byteLength(body)
  });

  // res.end() sends the body and finishes the HTTP response.
  res.end(body);
}

// Send an HTML page as the response. Used to serve the admin panel.
function sendHtml(res, html) {
  // The content type tells the browser to render this response as a web page.
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

// Send JavaScript source code. Used to serve /app.js.
function sendJavascript(res, source) {
  // The admin page loads this as a normal script asset from /app.js.
  res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
  res.end(source);
}

// Send CSS source code. Used to serve /app.css.
function sendCss(res, source) {
  // Serving CSS separately makes the admin panel easier to style and maintain.
  res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
  res.end(source);
}

// Export every function that other modules will use.
module.exports = {
  formatBytes,
  httpError,
  getCookie,
  setSessionCookie,
  clearSessionCookie,
  readRequestBuffer,
  readJsonBody,
  sendJson,
  sendHtml,
  sendCss,
  sendJavascript
};
