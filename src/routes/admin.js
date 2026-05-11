"use strict";

// These are the two HTTP utilities this file needs:
//   readJsonBody — reads the request body and parses it as JSON
//   sendJson     — writes a JSON HTTP response with the right Content-Type header
const { readJsonBody, sendJson } = require("../utils/http");
const { parseReportFile } = require("../services/report-parser");

// This function handles all /api/admin/** routes.
// Every route here requires a valid session cookie AND the appropriate permission.
// Returns true if a route matched, false if nothing matched (so server.js can try next).
async function tryHandleAdminRoute(req, res, pathname, requestUrl, sessionManager, storage, uploadService) {

  // -----------------------------------------------------------------------
  // GET /api/admin/keys — list all endpoints the signed-in user can see
  // Managers see every endpoint; viewers see only their assigned scopes.
  // -----------------------------------------------------------------------
  if (req.method === "GET" && pathname === "/api/admin/keys") {
    // requireSession validates the cookie and refreshes the user from the database.
    // Throws 401 if the session is missing, expired, or the user is disabled.
    const session = await sessionManager.requireSession(req);
    sendJson(res, 200, await storage.listKeysForUser(session.user));
    return true;
  }

  // -----------------------------------------------------------------------
  // POST /api/admin/keys — create a new endpoint and generate its first API key
  // Only api_manager accounts are allowed.
  // -----------------------------------------------------------------------
  if (req.method === "POST" && pathname === "/api/admin/keys") {
    const session = await sessionManager.requireSession(req);
    // assertPermission throws 403 if the user doesn't have manage_keys permission.
    sessionManager.assertPermission(session.user, "manage_keys");
    const body = await readJsonBody(req);
    // body.name is optional — if missing or empty, storage will generate a default name.
    const created = await storage.createKeyRecord(body && body.name ? String(body.name) : "");
    // 201 Created is the correct status code when a new resource has been created.
    sendJson(res, 201, created);
    return true;
  }

  // -----------------------------------------------------------------------
  // POST /api/admin/keys/:slug/revoke — disable an endpoint so it rejects uploads
  // The endpoint record stays in the database; uploads just get a 403 response.
  // -----------------------------------------------------------------------
  // .match() runs a regular expression on the pathname string.
  // [^/]+ means "one or more characters that are NOT a forward slash" (the slug).
  // The $ at the end means the pattern must match the ENTIRE path, not just a prefix.
  const revokeMatch = pathname.match(/^\/api\/admin\/keys\/([^/]+)\/revoke$/);
  if (req.method === "POST" && revokeMatch) {
    const session = await sessionManager.requireSession(req);
    sessionManager.assertPermission(session.user, "manage_keys");
    // revokeMatch[1] is the captured group — the slug from the URL.
    // updateKeyStatus(slug, true) sets revoked = 1 in the database.
    const updated = await storage.updateKeyStatus(revokeMatch[1], true);
    sendJson(res, 200, updated);
    return true;
  }

  // -----------------------------------------------------------------------
  // POST /api/admin/keys/:slug/restore — re-enable a previously revoked endpoint
  // -----------------------------------------------------------------------
  const restoreMatch = pathname.match(/^\/api\/admin\/keys\/([^/]+)\/restore$/);
  if (req.method === "POST" && restoreMatch) {
    const session = await sessionManager.requireSession(req);
    sessionManager.assertPermission(session.user, "manage_keys");
    // updateKeyStatus(slug, false) sets revoked = 0 in the database.
    const updated = await storage.updateKeyStatus(restoreMatch[1], false);
    sendJson(res, 200, updated);
    return true;
  }

  // -----------------------------------------------------------------------
  // POST /api/admin/keys/:slug/rotate — invalidate the current key, issue a new one
  // The new key is returned once in the response and then only the hash is kept.
  // -----------------------------------------------------------------------
  const rotateMatch = pathname.match(/^\/api\/admin\/keys\/([^/]+)\/rotate$/);
  if (req.method === "POST" && rotateMatch) {
    const session = await sessionManager.requireSession(req);
    sessionManager.assertPermission(session.user, "manage_keys");
    const rotated = await storage.rotateKeyRecord(rotateMatch[1]);
    sendJson(res, 200, rotated);
    return true;
  }

  // -----------------------------------------------------------------------
  // GET /api/admin/keys/:slug/browse — list files in an endpoint's storage folder
  // Managers can browse any endpoint; viewers can only browse their assigned scopes.
  // -----------------------------------------------------------------------
  const browseMatch = pathname.match(/^\/api\/admin\/keys\/([^/]+)\/browse$/);
  if (req.method === "GET" && browseMatch) {
    const session = await sessionManager.requireSession(req);
    // assertEndpointAccess checks that viewers have this slug in their endpointScopes.
    // Managers always pass this check.
    sessionManager.assertEndpointAccess(session.user, browseMatch[1]);
    const listing = await storage.listDirectoryForKey(
      browseMatch[1],
      // requestUrl.searchParams.get("path") reads the ?path= query parameter.
      // || "" means "default to the root directory if no path is provided."
      requestUrl.searchParams.get("path") || ""
    );
    sendJson(res, 200, listing);
    return true;
  }

  // -----------------------------------------------------------------------
  // DELETE /api/admin/keys/:slug — remove the endpoint record from the database
  // NOTE: the files stored under storage/<slug>/ are intentionally kept on disk.
  // -----------------------------------------------------------------------
  const deleteMatch = pathname.match(/^\/api\/admin\/keys\/([^/]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    const session = await sessionManager.requireSession(req);
    sessionManager.assertPermission(session.user, "manage_keys");
    const removed = await storage.deleteKeyRecord(deleteMatch[1]);
    sendJson(res, 200, removed);
    return true;
  }

  // -----------------------------------------------------------------------
  // GET /api/admin/keys/:slug/file-download — stream a file to the browser
  // The admin panel uses this to let users download individual synced files.
  // -----------------------------------------------------------------------
  const downloadMatch = pathname.match(/^\/api\/admin\/keys\/([^/]+)\/file-download$/);
  if (req.method === "GET" && downloadMatch) {
    const session = await sessionManager.requireSession(req);
    sessionManager.assertEndpointAccess(session.user, downloadMatch[1]);
    // uploadService.sendStoredFile streams the file directly to the response.
    await uploadService.sendStoredFile(
      res,
      downloadMatch[1],
      requestUrl.searchParams.get("path") || "",
      storage
    );
    return true;
  }

  const fileDeleteMatch = pathname.match(/^\/api\/admin\/keys\/([^/]+)\/file-delete$/);
  if (req.method === "DELETE" && fileDeleteMatch) {
    const session = await sessionManager.requireSession(req);
    sessionManager.assertPermission(session.user, "manage_keys");
    const deleted = await storage.deleteStoredEntryForKey(
      fileDeleteMatch[1],
      requestUrl.searchParams.get("path") || ""
    );
    sendJson(res, 200, deleted);
    return true;
  }

  const reportMatch = pathname.match(/^\/api\/admin\/keys\/([^/]+)\/report$/);
  if (req.method === "GET" && reportMatch) {
    const session = await sessionManager.requireSession(req);
    sessionManager.assertEndpointAccess(session.user, reportMatch[1]);

    let fileInfo;
    try {
      fileInfo = await uploadService.resolveStoredFile(
        reportMatch[1],
        requestUrl.searchParams.get("path") || "",
        storage
      );
    } catch (error) {
      const statusCode = error.message === "Endpoint key not found."
        ? 404
        : error.message === "File not found."
          ? 404
          : 400;
      sendJson(res, statusCode, { error: error.message });
      return true;
    }

    if (!/\.(html?|pdf)$/i.test(fileInfo.filename)) {
      sendJson(res, 400, { error: "Only .html, .htm, and .pdf reports can be parsed." });
      return true;
    }

    sendJson(res, 200, parseReportFile(fileInfo.fullPath));
    return true;
  }

  // -----------------------------------------------------------------------
  // GET /api/admin/users — list all user accounts (managers only)
  // -----------------------------------------------------------------------
  if (req.method === "GET" && pathname === "/api/admin/users") {
    const session = await sessionManager.requireSession(req);
    sessionManager.assertPermission(session.user, "manage_users");
    sendJson(res, 200, await storage.listUsersForClient());
    return true;
  }

  // -----------------------------------------------------------------------
  // POST /api/admin/users — create a new user account (managers only)
  // The request body must include username, password, role, and (for viewers) endpointScopes.
  // -----------------------------------------------------------------------
  if (req.method === "POST" && pathname === "/api/admin/users") {
    const session = await sessionManager.requireSession(req);
    sessionManager.assertPermission(session.user, "manage_users");
    const body = await readJsonBody(req);
    const created = await storage.createUserRecord(body);
    sendJson(res, 201, created);
    return true;
  }

  // -----------------------------------------------------------------------
  // PATCH /api/admin/users/:id — update an existing user account
  // Can change: disabled status, password, or viewer endpoint scopes.
  // -----------------------------------------------------------------------
  const userUpdateMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (req.method === "PATCH" && userUpdateMatch) {
    const session = await sessionManager.requireSession(req);
    sessionManager.assertPermission(session.user, "manage_users");
    const body = await readJsonBody(req);
    const updated = await storage.updateUserRecord(userUpdateMatch[1], body);
    // If the account was just disabled, immediately kill all its active sessions.
    // This prevents disabled users from continuing to use an unexpired session token.
    if (updated.disabled) {
      sessionManager.dropUserSessions(updated.id);
    }
    sendJson(res, 200, updated);
    return true;
  }

  // -----------------------------------------------------------------------
  // DELETE /api/admin/users/:id — permanently remove a user account
  // The current user cannot delete their own account (storage enforces this).
  // -----------------------------------------------------------------------
  const userDeleteMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (req.method === "DELETE" && userDeleteMatch) {
    const session = await sessionManager.requireSession(req);
    sessionManager.assertPermission(session.user, "manage_users");
    // Pass the actor's own ID so storage can prevent self-deletion.
    const deleted = await storage.deleteUserRecord(userDeleteMatch[1], session.user.id);
    // Drop any active sessions for the deleted user immediately.
    sessionManager.dropUserSessions(deleted.userId);
    sendJson(res, 200, deleted);
    return true;
  }

  // None of the patterns above matched — not an admin route.
  return false;
}

module.exports = {
  tryHandleAdminRoute
};
