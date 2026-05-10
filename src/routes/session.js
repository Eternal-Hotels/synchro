"use strict";

// Import the HTTP helpers we need for this route module.
const {
  clearSessionCookie,  // Removes the session cookie from the browser (used on logout).
  readJsonBody,        // Reads and parses the request body as JSON.
  sendJson,            // Sends a JSON response with the appropriate headers.
  setSessionCookie     // Writes the Set-Cookie header so the browser stores the token.
} = require("../utils/http");

// This function handles all /api/session/** routes.
// Returns true if it handled the request, false if it didn't.
async function tryHandleSessionRoute(req, res, pathname, sessionManager, storage) {
  // POST /api/session/login — the user has submitted the sign-in form.
  if (req.method === "POST" && pathname === "/api/session/login") {
    // Read the username and password from the JSON request body.
    const body = await readJsonBody(req);

    // sessionManager.loginUser verifies the credentials against the database.
    // It throws an httpError if the user doesn't exist, is disabled, or the
    // password is wrong. server.js's catch block will handle those errors.
    const session = await sessionManager.loginUser(body.username, body.password);

    // Set the session cookie in the response so the browser stores it.
    // After this, the browser will automatically include the cookie in every
    // subsequent request to this server.
    setSessionCookie(res, session.token);

    // Return the safe user object (no password hash) so the browser knows
    // who is logged in and what permissions they have.
    sendJson(res, 200, { user: storage.sanitizeUserForClient(session.user) });
    return true;
  }

  // POST /api/session/logout — the user clicked the logout button.
  if (req.method === "POST" && pathname === "/api/session/logout") {
    // Remove the session from the in-memory Map so the token becomes invalid.
    sessionManager.logout(req);

    // Overwrite the browser's cookie with one that expires immediately.
    clearSessionCookie(res);

    sendJson(res, 200, { loggedOut: true });
    return true;
  }

  // GET /api/session/me — the browser asks "am I still logged in?"
  // The admin-client.js calls this on page load to restore the logged-in state
  // without requiring the user to sign in again after a page refresh.
  if (req.method === "GET" && pathname === "/api/session/me") {
    // requireSession validates the cookie and re-hydrates the user from the database.
    // Throws 401 if the cookie is missing, invalid, or expired.
    const session = await sessionManager.requireSession(req);

    // Return the safe user shape so the browser can build the correct UI.
    sendJson(res, 200, { user: storage.sanitizeUserForClient(session.user) });
    return true;
  }

  // This is not a session route. Tell server.js to try the next handler.
  return false;
}

module.exports = {
  tryHandleSessionRoute
};
