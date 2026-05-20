"use strict";

// Import the three response helpers from utils/http.js.
// sendHtml, sendJavascript, and sendCss each set the right Content-Type header
// before writing the response body.
const { sendCss, sendHtml, sendJavascript } = require("../utils/http");

// This function is called for every request from server.js.
// It checks whether the current request is asking for one of the three UI assets.
// If it matches, it sends the file and returns true so server.js knows to stop.
// If it doesn't match, it returns false so server.js can try the next handler.
async function tryHandleUiRoute(req, res, pathname, adminUi) {
  // GET / — serve the main HTML page.
  // This is the shell of the single-page admin application.
  // The browser loads this first, which then fetches /app.js and /app.css.
  if (req.method === "GET" && pathname === "/") {
    sendHtml(res, adminUi.renderAdminPanel());
    return true;
  }

  // GET /app.js — serve all the client-side JavaScript for the admin panel.
  // The browser runs this code to build the interactive UI.
  if (req.method === "GET" && pathname === "/app.js") {
    sendJavascript(res, adminUi.renderAdminClient());
    return true;
  }

  // GET /app.css — serve the stylesheet that controls the look of the admin panel.
  if (req.method === "GET" && pathname === "/app.css") {
    sendCss(res, adminUi.renderAdminStylesheet());
    return true;
  }

  // GET /gasco.png — serve the local GASCO logo used in the masthead.
  if (req.method === "GET" && pathname === "/gasco.png") {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(adminUi.renderGascoLogo());
    return true;
  }

  // This request is not for a UI asset. Signal to server.js to try the next handler.
  return false;
}

// Make tryHandleUiRoute available to server.js via require().
module.exports = {
  tryHandleUiRoute
};
