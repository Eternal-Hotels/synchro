// This is the data layer for the entire application.
// It is the ONLY place in the Node server that reads or writes the SQLite database
// or the on-disk storage folders. Everything else asks this module for data.
"use strict";

// Node built-in: cryptography (random bytes, UUID generation).
const crypto = require("crypto");

// Node built-in: file system (read/write/stat files and directories).
const fs = require("fs");

// Node built-in: path manipulation (join, basename, dirname).
const path = require("path");

// Third-party SQLite driver. This is the only npm dependency in the whole project.
// sqlite3 uses C bindings to the SQLite library and exposes a callback-based API.
// We wrap those callbacks in Promises so we can use async/await with them.
const sqlite3 = require("sqlite3");

// Runtime configuration constants — file paths and directory locations.
const {
  DB_PATH,      // Absolute path to data/synchro.sqlite
  KEYS_PATH,    // Absolute path to data/keys.json (legacy import source)
  STORAGE_DIR,  // Absolute path to storage/ (uploaded files live here)
  USERS_PATH    // Absolute path to data/users.json (legacy import source)
} = require("../config");

// File-system helpers.
const { buildUniqueSlug, buildBreadcrumbs, ensureDirectory, parentRelativePath, sanitizeRelativePath } = require("../utils/files");

// HTTP helpers: formatBytes for human-readable sizes, httpError for typed errors.
const { formatBytes, httpError } = require("../utils/http");

// Cryptographic hash functions for API keys and passwords.
const { hashApiKey, hashPassword } = require("../utils/security");

// Module-level variable that holds the open SQLite database connection.
// It is set once by initializeStorage() and reused by all subsequent operations.
// Using a module-level variable is safe here because Node runs single-threaded.
let db;

// Open the database and bring the schema up to date.
// This runs once at server startup before the HTTP server starts accepting connections.
async function initializeStorage() {
  // Open (or create) the SQLite file. openDatabase wraps the callback in a Promise.
  db = await openDatabase(DB_PATH);

  // SQLite does NOT enforce foreign key constraints by default — you have to
  // opt in with this PRAGMA. This ensures that deleting a user also removes
  // their scope rows via the ON DELETE CASCADE rules in the schema.
  await dbRun("PRAGMA foreign_keys = ON");

  // Create the three tables if they don't already exist.
  await createSchema();

  // Add any columns that were introduced in newer versions of the schema.
  // This is safe to run on an already-up-to-date database.
  await migrateEndpointKeySchema();

  // If the database is empty and old JSON data files exist, import them now.
  // This allows upgrading from the pre-SQLite version without losing data.
  await importLegacyJsonData();
}

// Called once after initializeStorage().
// Creates a first admin account if the users table is completely empty.
// This is necessary because you need an account to log in to the admin panel,
// and on a brand-new install there are none.
async function ensureBootstrapAdmin() {
  // COUNT(*) returns a single row with a column called "count".
  // If count > 0, at least one user already exists — no bootstrapping needed.
  const countRow = await dbGet("SELECT COUNT(*) AS count FROM users");
  if (countRow.count > 0) {
    return;
  }

  // Use env vars if set, otherwise fall back to sensible defaults.
  // randomBytes(9).toString("base64url") produces a 12-character URL-safe password.
  // This is printed to the console so the operator can log in on first run.
  const username = process.env.SYNCHRO_BOOTSTRAP_USER || "admin";
  const password = process.env.SYNCHRO_BOOTSTRAP_PASSWORD || crypto.randomBytes(9).toString("base64url");

  // Generate a fresh random salt for this account's password hash.
  const passwordSalt = crypto.randomBytes(16).toString("hex");

  // Derive the hash from the password + salt using scrypt.
  const passwordHash = hashPassword(password, passwordSalt);

  // crypto.randomUUID() generates a standard UUID v4 (e.g. "550e8400-e29b-41d4-a716-446655440000").
  // UUIDs are used as primary keys so there's no auto-increment counter to leak record counts.
  const adminUser = {
    id: crypto.randomUUID(),
    username,
    role: "api_manager",   // Managers have full permissions
    endpointScopes: [],    // Managers don't use scopes (they can see everything)
    disabled: false,
    passwordSalt,
    passwordHash,
    createdAt: new Date().toISOString()  // ISO 8601 timestamp e.g. "2026-05-07T12:00:00.000Z"
  };

  // The ? placeholders prevent SQL injection.
  // sqlite3 substitutes the values from the array in order.
  // Never interpolate user-controlled values directly into SQL strings.
  await dbRun(
    `INSERT INTO users (id, username, role, disabled, password_salt, password_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      adminUser.id,
      adminUser.username,
      adminUser.role,
      0,                        // disabled = false → stored as integer 0 in SQLite
      adminUser.passwordSalt,
      adminUser.passwordHash,
      adminUser.createdAt
    ]
  );
  // Print credentials to the terminal so the operator knows the first-run password.
  console.log("Bootstrap admin created.");
  console.log(`Username: ${username}`);
  console.log(`Password: ${password}`);
}

async function listKeysForUser(user) {
  // Managers see all endpoints; viewers see only scoped endpoints. No one can retrieve stored keys.
  const keys = (await loadKeys())
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return keys
    .filter((record) => user.permissions.manageKeys || user.endpointScopes.includes(record.slug))
    .map((record) => hydrateKeyRecord(record));
}

async function createKeyRecord(rawName) {
  // Creating an endpoint means generating a one-time plaintext key, storing only
  // its salted hash, and ensuring one folder exists on disk.
  const keys = await loadKeys();
  const baseName = rawName.trim() || `endpoint-${keys.length + 1}`;
  const slug = buildUniqueSlug(baseName, keys);
  const apiKey = crypto.randomBytes(24).toString("hex");
  const apiKeySalt = crypto.randomBytes(16).toString("hex");
  const record = {
    name: baseName,
    slug,
    apiKeyHash: hashApiKey(apiKey, apiKeySalt),
    apiKeySalt,
    revoked: false,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    rotatedAt: null,
    rotationCount: 0
  };

  await dbRun(
    `INSERT INTO endpoint_keys (
      slug, name, api_key, api_key_hash, api_key_salt, revoked,
      created_at, last_used_at, rotated_at, rotation_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.slug,
      record.name,
      secureApiKeyPlaceholder(record.slug),
      record.apiKeyHash,
      record.apiKeySalt,
      0,
      record.createdAt,
      null,
      null,
      0
    ]
  );

  ensureDirectory(path.join(STORAGE_DIR, slug));
  return {
    ...hydrateKeyRecord(record),
    apiKey
  };
}

async function updateKeyStatus(slug, revoked) {
  // Revoking prevents future uploads without deleting history.
  const record = await findKeyBySlug(slug);
  if (!record) {
    throw httpError(404, "Endpoint key not found.");
  }
  record.revoked = revoked;
  await dbRun("UPDATE endpoint_keys SET revoked = ? WHERE slug = ?", [revoked ? 1 : 0, slug]);
  return hydrateKeyRecord(record);
}

async function rotateKeyRecord(slug) {
  // Rotation invalidates the previous secret and returns a new secret only once.
  const record = await findKeyBySlug(slug);
  if (!record) {
    throw httpError(404, "Endpoint key not found.");
  }

  const apiKey = crypto.randomBytes(24).toString("hex");
  const apiKeySalt = crypto.randomBytes(16).toString("hex");
  const rotatedAt = new Date().toISOString();
  const rotationCount = Number(record.rotationCount || 0) + 1;

  await dbRun(
    `UPDATE endpoint_keys
     SET api_key = ?, api_key_hash = ?, api_key_salt = ?, rotated_at = ?, rotation_count = ?
     WHERE slug = ?`,
    [
      secureApiKeyPlaceholder(slug),
      hashApiKey(apiKey, apiKeySalt),
      apiKeySalt,
      rotatedAt,
      rotationCount,
      slug
    ]
  );

  return {
    ...hydrateKeyRecord({
      ...record,
      apiKeyHash: hashApiKey(apiKey, apiKeySalt),
      apiKeySalt,
      rotatedAt,
      rotationCount
    }),
    apiKey
  };
}

async function deleteKeyRecord(slug) {
  // The database row is deleted, but the synced files are intentionally kept on disk.
  const existing = await findKeyBySlug(slug);
  if (!existing) {
    throw httpError(404, "Endpoint key not found.");
  }

  await dbRun("DELETE FROM endpoint_keys WHERE slug = ?", [slug]);
  return { deleted: true, slug, filesKeptOnDisk: true };
}

async function findKeyBySlug(slug) {
  // Keep SQL-specific column names out of the rest of the app by normalizing here.
  const row = await dbGet(
    `SELECT slug, name, api_key_hash AS apiKeyHash, api_key_salt AS apiKeySalt,
            revoked, created_at AS createdAt, last_used_at AS lastUsedAt,
            rotated_at AS rotatedAt, rotation_count AS rotationCount
     FROM endpoint_keys
     WHERE slug = ?`,
    [slug]
  );
  return row ? normalizeKeyRecord(row) : null;
}

async function listDirectoryForKey(slug, requestedPath) {
  // Confirm the endpoint exists before browsing its storage folder.
  const keyRecord = await findKeyBySlug(slug);
  if (!keyRecord) {
    throw httpError(404, "Endpoint key not found.");
  }
  return directoryListingForSlug(slug, requestedPath);
}

async function deleteStoredEntryForKey(slug, requestedPath) {
  const keyRecord = await findKeyBySlug(slug);
  if (!keyRecord) {
    throw httpError(404, "Endpoint key not found.");
  }

  const endpointDir = path.join(STORAGE_DIR, slug);
  ensureDirectory(endpointDir);

  const relativePath = requestedPath ? sanitizeRelativePath(requestedPath) : "";
  if (!relativePath) {
    throw httpError(400, "Invalid file path.");
  }

  const targetPath = path.join(endpointDir, relativePath);
  if (!fs.existsSync(targetPath)) {
    throw httpError(404, "File or folder not found.");
  }

  const stats = fs.statSync(targetPath);
  const kind = stats.isDirectory() ? "directory" : "file";

  if (stats.isDirectory()) {
    fs.rmSync(targetPath, { recursive: true, force: false });
  } else {
    fs.unlinkSync(targetPath);
  }

  return {
    deleted: true,
    slug,
    path: relativePath.replace(/\\/g, "/"),
    kind
  };
}

async function listUsersForClient() {
  // The UI only needs a sanitized representation of users.
  return (await loadUsers())
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(sanitizeUserForClient);
}

async function createUserRecord(payload) {
  // User creation validates inputs before opening a write transaction.
  const username = String(payload.username || "").trim();
  const password = String(payload.password || "");
  const role = payload.role === "viewer" ? "viewer" : "api_manager";
  const endpointScopes = Array.isArray(payload.endpointScopes) ? payload.endpointScopes.map(String) : [];

  await validateNewUser({ username, password, role, endpointScopes });

  if (await findUserByUsername(username)) {
    throw httpError(409, "That username already exists.");
  }

  const passwordSalt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, passwordSalt);
  const record = {
    id: crypto.randomUUID(),
    username,
    role,
    endpointScopes: role === "viewer" ? dedupeScopes(endpointScopes) : [],
    disabled: false,
    passwordSalt,
    passwordHash,
    createdAt: new Date().toISOString()
  };

  await runInTransaction(async () => {
    await dbRun(
      `INSERT INTO users (id, username, role, disabled, password_salt, password_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.username, record.role, 0, record.passwordSalt, record.passwordHash, record.createdAt]
    );

    if (record.role === "viewer") {
      await replaceUserScopes(record.id, record.endpointScopes);
    }
  });

  return sanitizeUserForClient(record);
}

async function updateUserRecord(userId, payload) {
  // Updates can disable a user, rotate a password, or replace viewer scopes.
  const record = await findUserById(userId);
  if (!record) {
    throw httpError(404, "User not found.");
  }

  if (typeof payload.disabled === "boolean") {
    record.disabled = payload.disabled;
  }

  if (payload.password) {
    const nextPassword = String(payload.password);
    validatePassword(nextPassword);
    record.passwordSalt = crypto.randomBytes(16).toString("hex");
    record.passwordHash = hashPassword(nextPassword, record.passwordSalt);
  }

  if (Array.isArray(payload.endpointScopes)) {
    if (record.role !== "viewer") {
      throw httpError(400, "Only viewer accounts use endpoint scopes.");
    }
    const nextScopes = payload.endpointScopes.map(String);
    await validateScopes(nextScopes);
    record.endpointScopes = dedupeScopes(nextScopes);
  }

  await runInTransaction(async () => {
    await dbRun(
      `UPDATE users
       SET disabled = ?, password_salt = ?, password_hash = ?
       WHERE id = ?`,
      [record.disabled ? 1 : 0, record.passwordSalt, record.passwordHash, record.id]
    );

    if (Array.isArray(payload.endpointScopes)) {
      await replaceUserScopes(record.id, record.endpointScopes);
    }
  });

  return sanitizeUserForClient(record);
}

async function deleteUserRecord(userId, actorUserId) {
  // Prevent the current operator from deleting the account they are using right now.
  if (userId === actorUserId) {
    throw httpError(400, "You cannot delete the account you are currently using.");
  }

  const existing = await findUserById(userId);
  if (!existing) {
    throw httpError(404, "User not found.");
  }

  await dbRun("DELETE FROM users WHERE id = ?", [userId]);
  return { deleted: true, userId };
}

function directoryListingForSlug(slug, requestedPath = "") {
  // Files themselves stay on disk; SQLite stores only users, keys, and scopes.
  const endpointDir = path.join(STORAGE_DIR, slug);
  ensureDirectory(endpointDir);
  const relativePath = requestedPath ? sanitizeRelativePath(requestedPath) : "";
  if (requestedPath && !relativePath) {
    throw httpError(400, "Invalid directory path.");
  }

  const targetDir = relativePath ? path.join(endpointDir, relativePath) : endpointDir;
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    throw httpError(404, "Folder not found.");
  }

  const entries = fs.readdirSync(targetDir, { withFileTypes: true })
    .map((entry) => {
      const relativeEntryPath = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;
      const fullPath = path.join(endpointDir, relativeEntryPath);
      const stats = fs.statSync(fullPath);
      const normalizedPath = relativeEntryPath.replace(/\\/g, "/");
      return {
        name: entry.name,
        path: normalizedPath,
        kind: entry.isDirectory() ? "directory" : "file",
        createdAt: stats.birthtime.toISOString(),
        sizeBytes: stats.size,
        sizeLabel: formatBytes(stats.size),
        downloadUrl: entry.isDirectory()
          ? ""
          : `/api/admin/keys/${encodeURIComponent(slug)}/file-download?path=${encodeURIComponent(normalizedPath)}`
      };
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "directory" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

  return {
    currentPath: relativePath,
    parentPath: parentRelativePath(relativePath),
    breadcrumbs: buildBreadcrumbs(relativePath),
    entries
  };
}

function hydrateKeyRecord(record) {
  // "Hydrate" means enriching a raw stored record with derived values for the UI.
  const endpointDir = path.join(STORAGE_DIR, record.slug);
  ensureDirectory(endpointDir);
  return {
    name: record.name,
    slug: record.slug,
    revoked: record.revoked,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt || "",
    rotatedAt: record.rotatedAt || "",
    rotationCount: Number(record.rotationCount || 0),
    rootEntryCount: fs.readdirSync(endpointDir, { withFileTypes: true }).length
  };
}

// Add a computed "permissions" object to a user, derived from their role.
// This is called just before storing a user in the session Map or sending
// the user to the browser — anywhere we need the permissions to be available.
// Deriving permissions from role on-the-fly means there's no separate permissions
// table to keep in sync when roles change.
function hydrateUserForPermissions(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    // .slice() creates a shallow copy of the array so callers can't mutate the original.
    endpointScopes: Array.isArray(user.endpointScopes) ? user.endpointScopes.slice() : [],
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt,
    // Compute booleans from the role string. Only api_manager gets true here.
    // The session manager's assertPermission() checks these flags by name.
    permissions: {
      manageKeys: user.role === "api_manager",
      manageUsers: user.role === "api_manager"
    }
  };
}

// Produce the subset of user fields that is safe to send to the browser.
// Most importantly: passwordHash and passwordSalt are NOT included.
// hydrateUserForPermissions already excludes them, so this is a thin wrapper.
function sanitizeUserForClient(user) {
  return hydrateUserForPermissions(user);
}

async function loadKeys() {
  // Load the full endpoint list when callers need to filter or sort it in JavaScript.
  const rows = await dbAll(
    `SELECT slug, name, api_key_hash AS apiKeyHash, api_key_salt AS apiKeySalt,
            revoked, created_at AS createdAt, last_used_at AS lastUsedAt,
            rotated_at AS rotatedAt, rotation_count AS rotationCount
     FROM endpoint_keys`
  );
  return rows.map(normalizeKeyRecord);
}

async function loadUsers() {
  // User scopes live in a separate table, so each row is hydrated with its scopes.
  const rows = await dbAll(
    `SELECT id, username, role, disabled, password_salt AS passwordSalt,
            password_hash AS passwordHash, created_at AS createdAt
     FROM users`
  );

  const users = [];
  for (const row of rows) {
    users.push(await hydrateUserRow(row));
  }
  return users;
}

async function validateNewUser({ username, password, role, endpointScopes }) {
  // Reject bad input before any database writes happen.
  if (!username) {
    throw httpError(400, "Username is required.");
  }
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
    throw httpError(400, "Username must be 3-40 characters using letters, numbers, dot, underscore, or hyphen.");
  }
  validatePassword(password);
  if (!["api_manager", "viewer"].includes(role)) {
    throw httpError(400, "Invalid role.");
  }
  if (role === "viewer") {
    await validateScopes(endpointScopes);
    if (dedupeScopes(endpointScopes).length === 0) {
      throw httpError(400, "Viewer accounts need at least one endpoint scope.");
    }
  }
}

function validatePassword(password) {
  // This sample keeps password rules intentionally simple for readability.
  if (!password || password.length < 8) {
    throw httpError(400, "Password must be at least 8 characters.");
  }
}

async function validateScopes(scopes) {
  // Viewer scopes must point at endpoint slugs that already exist.
  const validSlugs = new Set((await loadKeys()).map((entry) => entry.slug));
  for (const slug of scopes) {
    if (!validSlugs.has(slug)) {
      throw httpError(400, `Unknown endpoint scope: ${slug}`);
    }
  }
}

function dedupeScopes(scopes) {
  // A Set removes duplicates while preserving the original order of first appearance.
  return Array.from(new Set(scopes.map((item) => String(item))));
}

// Open (or create) a SQLite database file.
// sqlite3.Database's constructor accepts a callback — we convert that to a Promise
// so callers can use "await" instead of nesting callbacks.
function openDatabase(filename) {
  // A Promise wraps an asynchronous operation.
  // The function you pass to "new Promise" is called immediately with two functions:
  //   resolve(value) — call this when the operation succeeds
  //   reject(error)  — call this when the operation fails
  // Whoever awaits this Promise will receive the resolved value or the rejected error.
  return new Promise((resolve, reject) => {
    // sqlite3.Database opens or creates the file at `filename`.
    // The second argument is a callback fired when the connection is ready (or failed).
    const connection = new sqlite3.Database(filename, (error) => {
      if (error) {
        // Something went wrong (e.g. file permissions). Reject the Promise.
        reject(error);
        return;
      }
      // Connection is open. Resolve the Promise with the connection object.
      resolve(connection);
    });
  });
}

// Execute a SQL statement that modifies data (INSERT, UPDATE, DELETE, CREATE TABLE, PRAGMA).
// Resolves with { lastID, changes } where:
//   lastID  = rowid of the last inserted row (useful after INSERT)
//   changes = number of rows affected (useful after UPDATE/DELETE)
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    // db.run executes the SQL with the ? placeholders filled by params[].
    // We use a named function (onRun) rather than an arrow function so we can
    // access "this.lastID" — arrow functions don't have their own "this".
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }
      // "this" inside db.run's callback refers to the sqlite3 Statement object,
      // which exposes lastID and changes as properties.
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

// Execute a SQL query that returns at most one row.
// Use this for lookups by primary key or any query with LIMIT 1.
// Resolves with the row object, or null if no row matched.
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    // db.get fetches the first matching row as a JavaScript object.
    // Column names become object keys: { id: "abc", username: "admin", ... }
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }
      // db.get passes undefined (not null) when no row is found — normalize to null.
      resolve(row || null);
    });
  });
}

// Execute a SQL query that may return multiple rows.
// Resolves with an array of row objects (empty array if nothing matched).
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    // db.all fetches ALL matching rows into memory as an array.
    // Only use this when the result set is expected to be small.
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows);
    });
  });
}

// Run a group of database writes inside a single SQLite transaction.
// If any write fails, ALL writes in the group are rolled back — the database
// is left in the state it was before the transaction started.
// This guarantees consistency: e.g. inserting a user AND their scopes either
// both succeed or both fail together.
async function runInTransaction(work) {
  // BEGIN IMMEDIATE locks the database immediately (not lazily on first write).
  // This prevents two concurrent transactions from both thinking they can proceed.
  await dbRun("BEGIN IMMEDIATE TRANSACTION");
  try {
    // Call the caller-supplied function to do the actual work.
    // work() is typically an async function that calls dbRun multiple times.
    const result = await work();

    // All writes succeeded — make them permanent.
    await dbRun("COMMIT");
    return result;
  } catch (error) {
    try {
      // Something failed — undo all writes since BEGIN.
      await dbRun("ROLLBACK");
    } catch {
      // If ROLLBACK itself fails (rare), ignore it so the original error
      // propagates to the caller rather than being masked.
    }
    // Re-throw the original error so the route handler can send the right response.
    throw error;
  }
}

async function createSchema() {
  // The schema is normalized: users and endpoint keys are primary entities, and
  // viewer access lives in a join table that links users to endpoint slugs.
  await dbRun(
    `CREATE TABLE IF NOT EXISTS endpoint_keys (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key TEXT NOT NULL UNIQUE,
      api_key_hash TEXT NOT NULL,
      api_key_salt TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      rotated_at TEXT,
      rotation_count INTEGER NOT NULL DEFAULT 0
    )`
  );

  await dbRun(
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      role TEXT NOT NULL CHECK (role IN ('api_manager', 'viewer')),
      disabled INTEGER NOT NULL DEFAULT 0,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`
  );

  await dbRun(
    `CREATE TABLE IF NOT EXISTS user_endpoint_scopes (
      user_id TEXT NOT NULL,
      endpoint_slug TEXT NOT NULL,
      PRIMARY KEY (user_id, endpoint_slug),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (endpoint_slug) REFERENCES endpoint_keys(slug) ON DELETE CASCADE
    )`
  );
}

async function migrateEndpointKeySchema() {
  // Upgrade older databases that stored plaintext api_key values into the new
  // hash-only model, then overwrite the plaintext column with non-secret placeholders.
  const columnRows = await dbAll("PRAGMA table_info(endpoint_keys)");
  if (!columnRows.length) {
    return;
  }

  const columns = new Set(columnRows.map((row) => row.name));
  if (!columns.has("api_key_hash")) {
    await dbRun("ALTER TABLE endpoint_keys ADD COLUMN api_key_hash TEXT");
  }
  if (!columns.has("api_key_salt")) {
    await dbRun("ALTER TABLE endpoint_keys ADD COLUMN api_key_salt TEXT");
  }
  if (!columns.has("last_used_at")) {
    await dbRun("ALTER TABLE endpoint_keys ADD COLUMN last_used_at TEXT");
  }
  if (!columns.has("rotated_at")) {
    await dbRun("ALTER TABLE endpoint_keys ADD COLUMN rotated_at TEXT");
  }
  if (!columns.has("rotation_count")) {
    await dbRun("ALTER TABLE endpoint_keys ADD COLUMN rotation_count INTEGER NOT NULL DEFAULT 0");
  }

  const insecureRows = await dbAll(
    `SELECT slug, api_key AS apiKey
     FROM endpoint_keys
     WHERE api_key_hash IS NULL OR api_key_salt IS NULL`
  );

  for (const row of insecureRows) {
    const apiKeySalt = crypto.randomBytes(16).toString("hex");
    const apiKeyHash = hashApiKey(String(row.apiKey), apiKeySalt);
    await dbRun(
      `UPDATE endpoint_keys
       SET api_key = ?, api_key_hash = ?, api_key_salt = ?, rotation_count = COALESCE(rotation_count, 0)
       WHERE slug = ?`,
      [secureApiKeyPlaceholder(row.slug), apiKeyHash, apiKeySalt, row.slug]
    );
  }
}

async function importLegacyJsonData() {
  // This one-time migration copies old JSON data into SQLite only when the
  // database is still empty, so restarts do not duplicate records.
  const keyCountRow = await dbGet("SELECT COUNT(*) AS count FROM endpoint_keys");
  if (keyCountRow.count === 0 && fs.existsSync(KEYS_PATH)) {
    let legacyKeys = [];
    try {
      legacyKeys = JSON.parse(fs.readFileSync(KEYS_PATH, "utf8"));
    } catch (error) {
      console.warn("Could not parse legacy keys.json for import.", error);
    }

    for (const entry of legacyKeys) {
      if (!entry || !entry.slug || !entry.name || !entry.apiKey || !entry.createdAt) {
        continue;
      }
      const apiKeySalt = crypto.randomBytes(16).toString("hex");
      await dbRun(
        `INSERT INTO endpoint_keys (
          slug, name, api_key, api_key_hash, api_key_salt, revoked,
          created_at, last_used_at, rotated_at, rotation_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          String(entry.slug),
          String(entry.name),
          secureApiKeyPlaceholder(String(entry.slug)),
          hashApiKey(String(entry.apiKey), apiKeySalt),
          apiKeySalt,
          entry.revoked ? 1 : 0,
          String(entry.createdAt),
          null,
          null,
          0
        ]
      );
      ensureDirectory(path.join(STORAGE_DIR, String(entry.slug)));
    }
  }

  const userCountRow = await dbGet("SELECT COUNT(*) AS count FROM users");
  if (userCountRow.count === 0 && fs.existsSync(USERS_PATH)) {
    let legacyUsers = [];
    try {
      legacyUsers = JSON.parse(fs.readFileSync(USERS_PATH, "utf8"));
    } catch (error) {
      console.warn("Could not parse legacy users.json for import.", error);
    }

    await runInTransaction(async () => {
      for (const entry of legacyUsers) {
        if (!entry || !entry.id || !entry.username || !entry.role || !entry.passwordSalt || !entry.passwordHash || !entry.createdAt) {
          continue;
        }

        await dbRun(
          `INSERT INTO users (id, username, role, disabled, password_salt, password_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            String(entry.id),
            String(entry.username),
            entry.role === "viewer" ? "viewer" : "api_manager",
            entry.disabled ? 1 : 0,
            String(entry.passwordSalt),
            String(entry.passwordHash),
            String(entry.createdAt)
          ]
        );

        if (entry.role === "viewer" && Array.isArray(entry.endpointScopes)) {
          for (const scope of dedupeScopes(entry.endpointScopes)) {
            const keyExists = await dbGet("SELECT slug FROM endpoint_keys WHERE slug = ?", [String(scope)]);
            if (!keyExists) {
              continue;
            }
            await dbRun(
              `INSERT OR IGNORE INTO user_endpoint_scopes (user_id, endpoint_slug)
               VALUES (?, ?)`,
              [String(entry.id), String(scope)]
            );
          }
        }
      }
    });
  }
}

// Convert a raw SQLite row into a normalized JavaScript object.
// This is the single place where SQLite types are converted to JS types.
// SQLite has no native boolean or null-safe types — booleans are stored as 0/1
// integers, and missing values come back as null.
function normalizeKeyRecord(row) {
  return {
    slug: row.slug,
    name: row.name,
    // Fall back to empty string if the column is null (pre-migration databases).
    apiKeyHash: row.apiKeyHash || "",
    apiKeySalt: row.apiKeySalt || "",
    // Boolean(0) → false, Boolean(1) → true. Converts the SQLite integer flag.
    revoked: Boolean(row.revoked),
    createdAt: row.createdAt,
    // null → "" so callers can safely compare/display without null checks.
    lastUsedAt: row.lastUsedAt || "",
    rotatedAt: row.rotatedAt || "",
    // Number(null || 0) → 0. Ensures rotationCount is always a number, not null.
    rotationCount: Number(row.rotationCount || 0)
  };
}

// Update the last_used_at timestamp for an endpoint whenever an upload succeeds.
// This creates an audit trail so administrators can see which endpoints are active.
async function recordKeyUsage(slug) {
  // new Date().toISOString() gives an ISO 8601 string like "2026-05-07T15:30:00.000Z".
  const lastUsedAt = new Date().toISOString();
  await dbRun("UPDATE endpoint_keys SET last_used_at = ? WHERE slug = ?", [lastUsedAt, slug]);
}

// Generate a non-secret placeholder to store in the api_key column.
// The actual key is never stored — only the scrypt hash is kept.
// But SQLite requires the column to have some value (it has a NOT NULL UNIQUE constraint),
// so we fill it with a recognizable non-secret string.
// The UUID ensures uniqueness across rows so the UNIQUE constraint is satisfied.
function secureApiKeyPlaceholder(slug) {
  return `stored-securely:${slug}:${crypto.randomUUID()}`;
}

// Combine a user row with all the endpoint scopes assigned to that user.
// The users table doesn't store scopes — they live in user_endpoint_scopes.
// This function joins them together into a single convenient object.
async function hydrateUserRow(row) {
  // Fetch all scope rows for this user ordered alphabetically.
  // Each row is { endpointSlug: "warehouse-laptop" } etc.
  const scopeRows = await dbAll(
    `SELECT endpoint_slug AS endpointSlug
     FROM user_endpoint_scopes
     WHERE user_id = ?
     ORDER BY endpoint_slug`,
    [row.id]
  );

  return {
    id: row.id,
    username: row.username,
    role: row.role,
    // .map() transforms the array of row objects into a flat array of slug strings.
    endpointScopes: scopeRows.map((entry) => entry.endpointSlug),
    // Convert SQLite integer (0/1) to JavaScript boolean.
    disabled: Boolean(row.disabled),
    // Include the hashed credentials so session-manager can verify passwords.
    // These are NEVER sent to the browser — they're stripped in sanitizeUserForClient.
    passwordSalt: row.passwordSalt,
    passwordHash: row.passwordHash,
    createdAt: row.createdAt
  };
}

async function findUserById(userId) {
  // Reuse the same hydration path so every caller receives a consistent user object.
  const row = await dbGet(
    `SELECT id, username, role, disabled, password_salt AS passwordSalt,
            password_hash AS passwordHash, created_at AS createdAt
     FROM users
     WHERE id = ?`,
    [userId]
  );
  return row ? hydrateUserRow(row) : null;
}

async function findUserByUsername(username) {
  // Usernames are matched case-insensitively because the database column uses NOCASE.
  const row = await dbGet(
    `SELECT id, username, role, disabled, password_salt AS passwordSalt,
            password_hash AS passwordHash, created_at AS createdAt
     FROM users
     WHERE username = ? COLLATE NOCASE`,
    [username]
  );
  return row ? hydrateUserRow(row) : null;
}

async function replaceUserScopes(userId, endpointScopes) {
  // Replace-all is easier to reason about than diffing the old and new scope lists.
  await dbRun("DELETE FROM user_endpoint_scopes WHERE user_id = ?", [userId]);
  for (const scope of dedupeScopes(endpointScopes)) {
    await dbRun(
      `INSERT INTO user_endpoint_scopes (user_id, endpoint_slug)
       VALUES (?, ?)`,
      [userId, scope]
    );
  }
}

module.exports = {
  initializeStorage,
  ensureBootstrapAdmin,
  listKeysForUser,
  createKeyRecord,
  updateKeyStatus,
  rotateKeyRecord,
  deleteKeyRecord,
  findKeyBySlug,
  listDirectoryForKey,
  deleteStoredEntryForKey,
  listUsersForClient,
  createUserRecord,
  updateUserRecord,
  deleteUserRecord,
  findUserById,
  findUserByUsername,
  recordKeyUsage,
  hydrateUserForPermissions,
  sanitizeUserForClient
};
