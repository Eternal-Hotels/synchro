// Strict mode — catches common JavaScript mistakes and disables legacy unsafe behaviors.
// Every .js file in this project starts with this line.
"use strict";

require("dotenv").config();

// Node.js built-in module for creating HTTP servers.
// "http" is part of Node's standard library — no npm install needed.
const http = require("http");

// "url" is another built-in module. We specifically pull out the URL class,
// which parses strings like "http://localhost:3000/api/admin/keys?path=foo"
// into structured parts: protocol, hostname, pathname, searchParams, etc.
const { URL } = require("url");

// Pull in all our runtime constants from config.js.
// The { } destructuring syntax means "give me just these named properties from
// whatever config.js exports."
const { DATA_DIR, HOST, PORT, STORAGE_DIR } = require("./config");

// Each of these modules exports exactly one "tryHandle*" function.
// The function returns true if it handled the request, false if it did not.
// This is the entire routing system — no routing library needed.
const { tryHandleAdminRoute } = require("./routes/admin");
const { tryHandleSessionRoute } = require("./routes/session");
const { tryHandleUiRoute } = require("./routes/ui");
const { tryHandleUploadRoute } = require("./routes/upload");

// The storage module talks to the SQLite database and the file system.
// It is the only place in the app that reads or writes persisted data.
const storage = require("./services/storage");

// createSessionManager is a factory function — we call it once and it returns
// an object with methods like loginUser(), requireSession(), logout(), etc.
// Sessions are stored in a JavaScript Map inside that returned object (in memory).
const { createSessionManager } = require("./services/session-manager");

// Handles the business logic of receiving, parsing, saving, and streaming files.
const uploadService = require("./services/upload-service");
const { startReportEmailDigestScheduler } = require("./services/report-email-digest");

// adminUi reads the HTML/CSS/JS files from src/ui/ and returns them as strings
// so the HTTP server can send them to the browser.
const adminUi = require("./ui/admin-ui");

// ensureDirectory creates a folder if it doesn't already exist.
const { ensureDirectory } = require("./utils/files");

// sendJson is a helper that sets the right Content-Type header and writes JSON.
const { sendJson } = require("./utils/http");

// Make sure the data/ and storage/ folders exist before we try to use them.
// If they don't exist, Node would throw an error when trying to open the database.
ensureDirectory(DATA_DIR);
ensureDirectory(STORAGE_DIR);

// Create the session manager. We pass the storage object to it because
// the session manager needs to look up users from the database when
// validating a session cookie.
const sessionManager = createSessionManager(storage);

// http.createServer() creates an HTTP server.
// The function we pass in is called for EVERY request that comes in.
// Node.js calls it with two objects: req (the incoming request) and res (our response).
// "async" means this function can use "await" — it can pause while waiting for
// asynchronous operations (like database reads) to finish.
const server = http.createServer(async (req, res) => {
  try {
    // On every request, remove any sessions that have expired.
    // Because sessions live only in memory, we have to clean them up ourselves.
    sessionManager.pruneExpiredSessions();

    // req.url is the raw URL path from the HTTP request line, e.g. "/api/admin/keys?path=foo".
    // We wrap it in URL() to parse it into structured pieces.
    // We need to supply a base URL because req.url is only a path, not a full URL.
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    // requestUrl.pathname is just the path portion, e.g. "/api/admin/keys".
    // decodeURIComponent converts percent-encoded characters back to their real form,
    // e.g. "/api/admin/my%20folder" → "/api/admin/my folder".
    const pathname = decodeURIComponent(requestUrl.pathname);

    // Try each route handler in priority order.
    // If a handler deals with the request, it returns true and we stop.
    // The "await" keyword means we wait for the async function to finish before moving on.

    // First priority: serve the admin UI HTML/JS/CSS files.
    if (await tryHandleUiRoute(req, res, pathname, adminUi, sessionManager)) {
      return;
    }

    // Second priority: login, logout, and session check.
    if (await tryHandleSessionRoute(req, res, pathname, sessionManager, storage)) {
      return;
    }

    // Third priority: admin panel API calls (key and user management, file browsing).
    if (await tryHandleAdminRoute(req, res, pathname, requestUrl, sessionManager, storage, uploadService)) {
      return;
    }

    // Fourth priority: file uploads from the Python companion.
    if (await tryHandleUploadRoute(req, res, pathname, storage, uploadService)) {
      return;
    }

    // If no handler claimed the request, send a 404 JSON response.
    return sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    // If any handler throws an error (including our custom httpError objects),
    // we catch it here and send a JSON error response.
    // console.error prints to stderr — visible in the terminal but not in the browser.
    console.error(error);

    // error.statusCode is set by our httpError() helper in utils/http.js.
    // If it's not set (unexpected crash), we default to 500 (Internal Server Error).
    return sendJson(res, error.statusCode || 500, {
      error: error.message || "Internal server error."
    });
  }
});

// Start the startup sequence.
// initializeStorage() opens the SQLite database, creates the schema if needed,
// and runs any pending migrations.
storage.initializeStorage()
  // After the database is ready, ensure at least one admin user exists.
  // On a brand-new installation this creates the bootstrap admin and prints credentials.
  .then(() => storage.ensureBootstrapAdmin())
  .then(() => {
    startReportEmailDigestScheduler(storage);
  })
  // Now that storage is fully ready, start listening for HTTP connections.
  .then(() => {
    // server.listen() tells Node to begin accepting TCP connections on PORT (default 3000).
    // The callback runs once the server is actually ready to accept connections.
    server.listen(PORT, HOST, () => {
      console.log(`Synchro upload service listening on http://${HOST}:${PORT}`);
    });
  })
  // If anything in the startup sequence fails (e.g. database corruption),
  // log the error and exit with code 1 (a non-zero exit code signals failure to the OS).
  .catch((error) => {
    console.error("Failed to initialize storage.", error);
    process.exit(1);
  });
