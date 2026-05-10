"use strict";

// "crypto" is Node's built-in cryptography module.
// We use it here to generate random, unguessable session tokens.
const crypto = require("crypto");

// Import configuration constants.
const { SESSION_COOKIE, SESSION_TTL_MS } = require("../config");

// Import helpers: getCookie reads a named cookie from the request headers,
// httpError creates an Error with an HTTP status code attached.
const { getCookie, httpError } = require("../utils/http");

// Import the password/key verification function (uses scrypt under the hood).
const { verifyPassword } = require("../utils/security");

// createSessionManager is a "factory function" — a function that creates and
// returns an object. This pattern is used instead of a class here.
// The storage object is passed in so the session manager can look up users
// from the database (dependency injection — no tight coupling to storage).
function createSessionManager(storage) {
  // sessions is a JavaScript Map. Think of it like a dictionary or hash table.
  // Key: the session token (a 64-character hex string)
  // Value: { token, user, expiresAt } — the session data
  //
  // IMPORTANT: This lives in Node.js process memory, NOT in the database.
  // That means if the server restarts, ALL sessions are lost and everyone
  // must log in again. This is a deliberate simplicity trade-off.
  const sessions = new Map();

  // Verify credentials and create a new session if they are valid.
  // Called when the user submits the login form.
  async function loginUser(username, password) {
    // Guard against empty inputs before touching the database.
    if (!username || !password) {
      throw httpError(400, "Username and password are required.");
    }

    // Ask the database for a user record matching this username.
    // String() and .trim() prevent subtle bugs from extra whitespace or non-string inputs.
    const user = await storage.findUserByUsername(String(username).trim());

    // If the user doesn't exist OR is disabled, reject with the SAME generic message.
    // Giving different messages for "wrong username" vs "wrong password" would let an
    // attacker enumerate which usernames exist on the system.
    if (!user || user.disabled) {
      throw httpError(401, "Invalid username or password.");
    }

    // Hash the supplied password with the stored salt and compare to the stored hash.
    // verifyPassword uses crypto.timingSafeEqual to prevent timing attacks.
    const valid = verifyPassword(password, user.passwordHash, user.passwordSalt);
    if (!valid) {
      throw httpError(401, "Invalid username or password.");
    }

    // Generate a 32-byte (256-bit) random session token.
    // crypto.randomBytes is cryptographically strong — an attacker cannot predict
    // or guess the next token even if they know previous ones.
    // .toString("hex") converts the raw bytes to a 64-character hexadecimal string.
    const token = crypto.randomBytes(32).toString("hex");

    // Calculate when this session should expire (current time + 12 hours in ms).
    const expiresAt = Date.now() + SESSION_TTL_MS;

    // hydrateUserForPermissions adds the computed "permissions" object to the user
    // so route handlers don't have to recompute it every time.
    const sessionUser = storage.hydrateUserForPermissions(user);

    // Store the session in memory so future requests can look it up by token.
    sessions.set(token, {
      token,
      user: sessionUser,
      expiresAt
    });

    // Return the token and user to the login route so it can set the cookie
    // and send the user's details back to the browser.
    return { token, user: sessionUser };
  }

  // Look up the session from the cookie in the incoming request.
  // Used by every admin route that requires authentication.
  async function requireSession(req) {
    // getCookie reads the named cookie from the "Cookie:" request header.
    const token = getCookie(req, SESSION_COOKIE);

    // If there's no cookie, or the token isn't in our Map, reject immediately.
    if (!token || !sessions.has(token)) {
      throw httpError(401, "Please sign in.");
    }

    const session = sessions.get(token);

    // Check if this session has expired (the current time is past the expiry).
    if (session.expiresAt < Date.now()) {
      // Remove the expired entry so the Map doesn't grow unboundedly.
      sessions.delete(token);
      throw httpError(401, "Your session expired. Please sign in again.");
    }

    // Re-fetch the user from the database every request.
    // This ensures that if an admin disables a user, their next request is rejected —
    // even if they have a valid session token.
    const freshUser = await storage.findUserById(session.user.id);
    if (!freshUser || freshUser.disabled) {
      sessions.delete(token);
      throw httpError(401, "Your account is unavailable.");
    }

    // Slide the expiry window forward — each successful request extends the session
    // by another 12 hours (so active users never get logged out mid-work).
    session.expiresAt = Date.now() + SESSION_TTL_MS;

    // Re-hydrate the user in case their role or scopes were changed since login.
    session.user = storage.hydrateUserForPermissions(freshUser);

    return session;
  }

  // Invalidate the session associated with the current request (log out).
  function logout(req) {
    const sessionToken = getCookie(req, SESSION_COOKIE);
    if (sessionToken) {
      // Removing the token from the Map means future requests with that token
      // will get a 401 response.
      sessions.delete(sessionToken);
    }
  }

  // Check that the currently authenticated user has a specific permission.
  // Throws a 403 (Forbidden) error if not.
  // "permission" is a snake_case string like "manage_keys" or "manage_users".
  function assertPermission(user, permission) {
    // Convert "manage_keys" → "manageKeys" (camelCase) to match the permissions object.
    // The regex finds "_" followed by a lowercase letter and replaces them with
    // just the uppercase letter.
    const normalized = permission
      .replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

    // user.permissions is an object like { manageKeys: true, manageUsers: true }.
    // If the permission is falsy (false or undefined), the user doesn't have it.
    if (!user.permissions[normalized]) {
      throw httpError(403, "You do not have permission for this action.");
    }
  }

  // Check whether a user can access a specific endpoint's files.
  // api_manager accounts can access everything; viewer accounts can only
  // access endpoints explicitly listed in their endpointScopes.
  function assertEndpointAccess(user, slug) {
    // Managers bypass the scope check entirely.
    if (user.permissions.manageKeys) {
      return;
    }
    // user.endpointScopes is an array of slugs the viewer is allowed to see.
    if (!user.endpointScopes.includes(slug)) {
      throw httpError(403, "You do not have access to this endpoint.");
    }
  }

  // Immediately invalidate all sessions for a specific user ID.
  // Called when a user is disabled or deleted so they cannot keep using
  // sessions they created before the change took effect.
  function dropUserSessions(userId) {
    // Iterate over every entry in the Map using destructuring.
    // sessions.entries() gives us [token, sessionData] pairs.
    for (const [token, session] of sessions.entries()) {
      if (session.user.id === userId) {
        sessions.delete(token);
      }
    }
  }

  // Remove expired sessions from the Map.
  // Called at the start of every incoming request so the Map doesn't
  // accumulate stale entries indefinitely over a long server uptime.
  function pruneExpiredSessions() {
    const now = Date.now();
    for (const [token, session] of sessions.entries()) {
      if (session.expiresAt < now) {
        sessions.delete(token);
      }
    }
  }

  // Return the public API of the session manager as a plain object.
  // Only the functions listed here are accessible to callers.
  return {
    loginUser,
    requireSession,
    logout,
    assertPermission,
    assertEndpointAccess,
    dropUserSessions,
    pruneExpiredSessions
  };
}

// Export the factory function so server.js can call createSessionManager(storage).
module.exports = {
  createSessionManager
};
