// "use strict" activates JavaScript's strict mode for this file.
// Strict mode disables some old, error-prone JavaScript behaviors:
// - Variables must be declared before use (no accidental globals)
// - Duplicate function parameters are an error
// - 'this' inside a plain function call is undefined instead of the global object
// It is a best practice for any serious Node.js code.
"use strict";

// "path" is a built-in Node.js module. You access it with require().
// require() is how Node loads code — either from its standard library
// (like "path") or from files you've written (like "./utils/files").
// The "path" module handles file and directory path strings safely across
// operating systems (Windows uses backslashes, Linux/Mac use forward slashes).
const path = require("path");

// process.env is a Node.js object that contains all environment variables
// set before the program started (e.g. PORT=4000 npm start).
// The || operator means "use the left side if it is truthy, otherwise the right side."
// So PORT will be whatever the environment says, or 3000 if nothing was set.
// Number() converts the string "3000" to the actual number 3000.
const PORT = Number(process.env.PORT || 3000);

// HOST controls which network interface the server binds to.
// "0.0.0.0" means "listen on ALL network interfaces" — accessible from other machines.
// "127.0.0.1" would mean "localhost only".
const HOST = process.env.HOST || "0.0.0.0";

// __dirname is a special Node.js variable that always equals the absolute path
// of the CURRENT FILE's directory — here that's the "src/" folder.
// path.resolve(__dirname, "..") means "go one folder up from src/" — giving us
// the project root (the folder that also contains package.json, data/, storage/).
const ROOT_DIR = path.resolve(__dirname, "..");

// path.join() safely concatenates path segments using the correct separator
// for the current OS. This gives us "<project root>/data".
const DATA_DIR = path.join(ROOT_DIR, "data");

// "<project root>/storage" — the top-level folder where uploaded files are saved.
// Each endpoint gets its own sub-folder inside here.
const STORAGE_DIR = path.join(ROOT_DIR, "storage");

// The SQLite database file. SQLite is a simple, file-based database — there is
// no separate database server process to run. The whole database lives in one file.
const DB_PATH = path.join(DATA_DIR, "synchro.sqlite");

// These two paths point to the old JSON files that an earlier version used
// to store data. They are kept here so the migration code knows where to look
// when importing legacy data into SQLite on first startup.
const KEYS_PATH = path.join(DATA_DIR, "keys.json");
const USERS_PATH = path.join(DATA_DIR, "users.json");

// 25 * 1024 * 1024 = 26,214,400 bytes = 25 megabytes.
// Any upload request body larger than this is rejected before it is fully read.
// This prevents a malicious client from sending an enormous request and
// exhausting the server's memory.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// The name of the HTTP cookie that stores the user's session token.
// The browser will automatically send this cookie with every request to the server.
const SESSION_COOKIE = "synchro_session";

// How long a login session stays valid without activity: 1000ms × 60 × 60 × 12 = 12 hours.
// Each authenticated request resets the clock, so active users stay logged in.
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

// module.exports is how Node.js makes values available to other files.
// Any file that does require("./config") gets back this exact object.
// Centralizing all constants here means a single place to adjust them.
module.exports = {
  PORT,
  HOST,
  ROOT_DIR,
  DATA_DIR,
  STORAGE_DIR,
  DB_PATH,
  KEYS_PATH,
  USERS_PATH,
  MAX_UPLOAD_BYTES,
  SESSION_COOKIE,
  SESSION_TTL_MS
};
