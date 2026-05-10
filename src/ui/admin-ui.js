// This module is the server-side bridge between the HTTP server and the static UI files.
// Its only job is to read the three UI assets from disk and return them as strings.
// Keeping this in its own module means the route handler (ui.js) doesn't need to
// know where the files live — it just asks for the content.
"use strict";

// fs (file system) — lets us read files from disk.
const fs = require("fs");

// path — lets us build absolute file paths in a cross-platform way.
const path = require("path");

// __dirname is the absolute path of THIS file's directory (src/ui/).
// path.join(__dirname, "admin-panel.html") = "<project root>/src/ui/admin-panel.html"
// Storing the paths in variables at module load time is slightly faster than
// computing them on every request.
const panelPath = path.join(__dirname, "admin-panel.html");
const cssPath = path.join(__dirname, "admin-panel.css");
const clientPath = path.join(__dirname, "admin-client.js");

// Read and return the HTML page (served at GET /).
// fs.readFileSync reads the whole file into memory synchronously.
// "utf8" means "decode the bytes as UTF-8 text and return a string."
function renderAdminPanel() {
  return fs.readFileSync(panelPath, "utf8");
}

// Read and return the stylesheet (served at GET /app.css).
function renderAdminStylesheet() {
  return fs.readFileSync(cssPath, "utf8");
}

// Read and return the browser JavaScript (served at GET /app.js).
// This file contains ALL the admin panel logic — state management, rendering,
// API calls, etc. There is no build step or bundler.
function renderAdminClient() {
  return fs.readFileSync(clientPath, "utf8");
}

// Export the three functions so ui.js can call them when the browser asks for assets.
module.exports = {
  renderAdminPanel,
  renderAdminStylesheet,
  renderAdminClient
};
