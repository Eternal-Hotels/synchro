"use strict";

// This is the route for file uploads from the Python companion client.
// It is intentionally separate from the admin routes because it uses
// API key authentication (not session cookies).
async function tryHandleUploadRoute(req, res, pathname, storage, uploadService) {
  // Use a regular expression to match POST /api/upload/<anything> where
  // <anything> is the endpoint slug (e.g. "warehouse-laptop").
  // [^/]+ means "one or more characters that are NOT a forward slash."
  // The parentheses capture the slug so we can extract it.
  const uploadMatch = pathname.match(/^\/api\/upload\/([^/]+)$/);

  if (req.method === "POST" && uploadMatch) {
    // uploadMatch[1] is the captured group — the endpoint slug from the URL.
    // We pass the full req and res objects so uploadService can read the body
    // and write the response directly.
    await uploadService.handleUpload(req, res, uploadMatch[1], storage);
    return true;
  }

  const configMatch = pathname.match(/^\/api\/upload\/([^/]+)\/config$/);
  if (req.method === "GET" && configMatch) {
    await uploadService.handleCompanionConfig(req, res, configMatch[1], storage);
    return true;
  }

  // Not an upload request — return false so the next handler can try.
  return false;
}

module.exports = {
  tryHandleUploadRoute
};
