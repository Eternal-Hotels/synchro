# Synchro Upload Service — Architecture Reference

> **Audience:** This document is written for two audiences simultaneously.
> - **LLMs ingesting this as context** — the prose sections give dense, unambiguous descriptions of every module, data flow, and design decision.
> - **Human readers** — the Mermaid diagrams give a visual map of the same information.

---

## 1. What the Application Is

Synchro is a **self-contained file-sync platform** with two halves:

| Half | Runtime | Purpose |
|---|---|---|
| **Server** | Node.js (no framework) | Receives file uploads, stores them on disk, provides a browser-based admin panel |
| **Companion** | Python 3 (stdlib only) | Sends files from a local machine to the server via HTTP |

The entire Node server runs on a single `http.createServer` call — there is no Express, Fastify, or any other web framework. Everything (routing, cookie handling, JSON parsing, multipart parsing) is implemented from scratch in the `src/` tree.

---

## 2. Repository Layout

```
synchro/
├── src/                        # Node.js server source
│   ├── server.js               # Entry point — wires everything together and starts HTTP server
│   ├── config.js               # All environment-driven constants in one place
│   ├── routes/
│   │   ├── admin.js            # /api/admin/** — key and user management (session-authenticated)
│   │   ├── session.js          # /api/session/** — login / logout / whoami
│   │   ├── ui.js               # / /app.js /app.css — serves the browser admin panel
│   │   └── upload.js           # /api/upload/:slug — receives file uploads (API-key-authenticated)
│   ├── services/
│   │   ├── session-manager.js  # In-memory session store; login, logout, permission checks
│   │   ├── storage.js          # All SQLite reads/writes plus on-disk folder operations
│   │   └── upload-service.js   # Multipart parsing, file writing, file download streaming
│   ├── ui/
│   │   ├── admin-panel.html    # The single HTML page served at /
│   │   ├── admin-panel.css     # Stylesheet served at /app.css
│   │   ├── admin-client.js     # Browser JavaScript served at /app.js (no bundler)
│   │   └── admin-ui.js         # Server-side module that reads and returns the UI files
│   └── utils/
│       ├── files.js            # Path sanitization, slug generation, directory helpers
│       ├── http.js             # Cookie parsing, JSON helpers, response senders
│       └── security.js         # scrypt password hashing and API key hashing
├── companion/                  # Python companion tools
│   ├── sync_client.py          # Core logic: config loading, multipart building, folder sync
│   ├── uploader.py             # CLI entry point wrapping sync_client
│   └── gui.py                  # Tkinter desktop GUI wrapping sync_client
├── data/                       # Runtime-created; holds synchro.sqlite
├── storage/                    # Runtime-created; one sub-folder per endpoint slug
└── package.json
```

---

## 3. System Architecture Diagram

```mermaid
graph TB
    subgraph Client["Client Machine (Python Companion)"]
        CLI["uploader.py\nCLI tool"]
        GUI["gui.py\nTkinter desktop app"]
        SC["sync_client.py\nShared logic library"]
        ENV[".env file\nSaved credentials"]
        CLI --> SC
        GUI --> SC
        SC <--> ENV
    end

    subgraph Server["Node.js Server (src/)"]
        HTTP["http.createServer\nserver.js"]
        subgraph Routes["Route Handlers"]
            UI_R["ui.js\nGET /\nGET /app.js\nGET /app.css"]
            SESSION_R["session.js\nPOST /api/session/login\nPOST /api/session/logout\nGET /api/session/me"]
            ADMIN_R["admin.js\nGET|POST /api/admin/keys\nPOST /api/admin/keys/:s/revoke\nPOST /api/admin/keys/:s/restore\nPOST /api/admin/keys/:s/rotate\nGET /api/admin/keys/:s/browse\nDELETE /api/admin/keys/:s\nGET|POST /api/admin/users\nPATCH|DELETE /api/admin/users/:id"]
            UPLOAD_R["upload.js\nPOST /api/upload/:slug"]
        end
        subgraph Services["Services"]
            SM["session-manager.js\nIn-memory session Map"]
            STOR["storage.js\nSQLite + disk I/O"]
            US["upload-service.js\nMultipart parser\nFile writer\nFile streamer"]
        end
        subgraph Utils["Utilities"]
            SEC["security.js\nscrypt hashing"]
            FILES["files.js\nPath sanitization"]
            HTTPU["http.js\nCookie / JSON helpers"]
        end
        HTTP --> Routes
        Routes --> SM
        Routes --> STOR
        Routes --> US
        SM --> STOR
        SM --> SEC
        US --> STOR
        US --> FILES
        STOR --> SEC
        STOR --> FILES
    end

    subgraph Storage["Persistent Storage"]
        DB[("synchro.sqlite\nusers\nendpoint_keys\nuser_endpoint_scopes")]
        DISK["storage/<slug>/\nUploaded files on disk"]
    end

    subgraph Browser["Admin Browser"]
        PANEL["admin-panel.html\nSingle-page app"]
        JS["admin-client.js\nVanilla JS state machine"]
        PANEL --> JS
    end

    SC -- "POST /api/upload/:slug\nX-API-Key header\nmultipart/form-data body" --> HTTP
    Browser -- "HTTP requests\n(session cookie)" --> HTTP
    HTTP -- "Serves HTML/JS/CSS" --> Browser
    STOR <--> DB
    US <--> DISK
```

---

## 4. Request Routing Flow

Every single HTTP request flows through one central function in `server.js`. There are no middleware chains — each route module exports a `tryHandle*` function that returns `true` if it handled the request, or `false` to pass it on.

```mermaid
flowchart TD
    REQ([Incoming HTTP Request]) --> PRUNE[Prune expired sessions\nfrom in-memory Map]
    PRUNE --> PARSE[Parse URL pathname\nand decode percent-encoding]
    PARSE --> UI{tryHandleUiRoute?\nGET / or /app.js or /app.css}
    UI -- yes --> SERVE_HTML[Send HTML / JS / CSS file\nfrom src/ui/]
    UI -- no --> SESSION{tryHandleSessionRoute?\n/api/session/**}
    SESSION -- yes --> SESSION_WORK[Login / Logout / Me]
    SESSION -- no --> ADMIN{tryHandleAdminRoute?\n/api/admin/**}
    ADMIN -- yes --> AUTH{requireSession\nvalid cookie?}
    AUTH -- no --> E401[401 Unauthorized]
    AUTH -- yes --> PERM{assertPermission\nor assertEndpointAccess?}
    PERM -- no --> E403[403 Forbidden]
    PERM -- yes --> ADMIN_WORK[Key/User CRUD\nor file browse/download]
    ADMIN -- no --> UPLOAD{tryHandleUploadRoute?\nPOST /api/upload/:slug}
    UPLOAD -- yes --> KEY_CHECK{Find key by slug\nCheck revoked\nVerify API key hash}
    KEY_CHECK -- invalid --> E401B[401 / 403 / 404]
    KEY_CHECK -- valid --> PARSE_MULTI[Parse multipart body\nWrite file to disk]
    UPLOAD -- no --> E404[404 Not Found]
    SERVE_HTML --> RES([HTTP Response])
    SESSION_WORK --> RES
    ADMIN_WORK --> RES
    PARSE_MULTI --> RES
    E401 --> RES
    E403 --> RES
    E401B --> RES
    E404 --> RES
```

---

## 5. Authentication & Session Model

The server uses **two completely separate authentication mechanisms**:

### 5a. Browser sessions (admin panel)

```mermaid
sequenceDiagram
    participant B as Browser
    participant S as server.js
    participant SM as session-manager.js
    participant DB as SQLite

    B->>S: POST /api/session/login {username, password}
    S->>SM: loginUser(username, password)
    SM->>DB: findUserByUsername(username)
    DB-->>SM: user row with passwordHash + passwordSalt
    SM->>SM: scrypt(password, salt) == hash?\ntimingSafeEqual()
    SM->>SM: crypto.randomBytes(32) → token\nStore {token, user, expiresAt} in Map
    SM-->>S: {token, user}
    S->>B: Set-Cookie: synchro_session=<token>; HttpOnly; SameSite=Strict; Max-Age=43200

    Note over B,S: Subsequent requests carry the cookie automatically

    B->>S: GET /api/admin/keys (with cookie)
    S->>SM: requireSession(req)
    SM->>SM: getCookie → look up token in Map
    SM->>DB: findUserById (re-hydrate fresh user)
    SM->>SM: Extend expiresAt by 12 hours
    SM-->>S: session object with user + permissions
    S-->>B: 200 {keys: [...]}
```

Sessions live **only in the Node.js process memory** — a server restart clears all active sessions and everyone must re-login.

### 5b. API key authentication (upload endpoint)

```mermaid
sequenceDiagram
    participant PY as Python companion
    participant S as server.js
    participant US as upload-service.js
    participant DB as SQLite
    participant DISK as storage/<slug>/

    PY->>S: POST /api/upload/<slug>\nX-API-Key: <plaintext key>\nContent-Type: multipart/form-data

    S->>US: handleUpload(req, res, slug, storage)
    US->>DB: findKeyBySlug(slug)
    DB-->>US: {apiKeyHash, apiKeySalt, revoked, ...}
    US->>US: keyRecord.revoked? → 403
    US->>US: scrypt(suppliedKey, salt) == storedHash?\ntimingSafeEqual()
    US->>DB: recordKeyUsage(slug) — update last_used_at
    US->>US: Read X-Relative-Path header\nsanitizeRelativePath() — blocks path traversal
    US->>DISK: ensureDirectory(path.dirname(targetPath))\nfs.writeFileSync(targetPath, content)
    US-->>S: {message, endpoint, storedAs, bytes}
    S-->>PY: 201 Created JSON
```

---

## 6. Database Schema

Synchro uses a single SQLite file at `data/synchro.sqlite`. There are three tables:

```mermaid
erDiagram
    users {
        TEXT id PK "UUID v4"
        TEXT username UK "COLLATE NOCASE"
        TEXT role "api_manager OR viewer"
        INTEGER disabled "0 or 1"
        TEXT password_salt
        TEXT password_hash "scrypt-derived 64-byte hex"
        TEXT created_at "ISO 8601"
    }

    endpoint_keys {
        TEXT slug PK "URL-safe name e.g. warehouse-laptop"
        TEXT name "Human-readable display name"
        TEXT api_key "Non-secret placeholder only — real key is hashed"
        TEXT api_key_hash "scrypt-derived 64-byte hex"
        TEXT api_key_salt
        INTEGER revoked "0 or 1"
        TEXT created_at "ISO 8601"
        TEXT last_used_at "ISO 8601 or NULL"
        TEXT rotated_at "ISO 8601 or NULL"
        INTEGER rotation_count
    }

    user_endpoint_scopes {
        TEXT user_id FK
        TEXT endpoint_slug FK
    }

    users ||--o{ user_endpoint_scopes : "viewer scopes"
    endpoint_keys ||--o{ user_endpoint_scopes : "scoped to"
```

**Key design decisions:**
- API keys are **never stored in plaintext**. Only a scrypt hash + salt is kept. The plaintext key is shown once at creation/rotation and then discarded.
- The `api_key` column stores a non-secret placeholder string (e.g. `[hashed:warehouse-laptop]`), not the real key, for legacy migration compatibility.
- `user_endpoint_scopes` only matters for `viewer` role users. `api_manager` users bypass scope checks entirely.

---

## 7. Upload Data Flow (Python Companion → Server → Disk)

```mermaid
flowchart LR
    subgraph Python["Python Companion"]
        F[Local file\nor folder] --> SC[sync_client.py\nbuild_multipart_body]
        SC --> HTTP[http.client\nHTTPConnection]
    end

    subgraph Wire["HTTP Wire"]
        HTTP -- "POST /api/upload/:slug\nX-API-Key: <key>\nX-Relative-Path: a/b/file.html\nmultipart/form-data body" --> SERVER
    end

    subgraph Node["Node Server"]
        SERVER[upload.js\nroute handler] --> AUTH[Verify API key\nwith scrypt]
        AUTH --> PARSE[parseMultipartUpload\nbinary boundary split]
        PARSE --> SANITIZE[sanitizeRelativePath\nstrip .., normalize]
        SANITIZE --> WRITE[fs.writeFileSync\nstorage/:slug/:path]
    end

    subgraph FS["File System"]
        WRITE --> RESULT["storage/\n  warehouse-laptop/\n    menus/\n      daily.htm\n    index.html"]
    end
```

For **folder syncs**, `sync_client.py` calls `pathlib.Path.rglob("*")` to walk the directory tree recursively, then uploads each file individually with its path relative to the sync root set in the `X-Relative-Path` header. The server recreates the same directory structure under `storage/<slug>/`.

---

## 8. Admin Panel (Browser SPA)

The admin panel is a **vanilla-JS single-page application** — no React, Vue, or bundler. It is served as three static assets from `src/ui/`:

| Asset | Route | Description |
|---|---|---|
| `admin-panel.html` | `GET /` | The HTML shell (two views: auth form and app) |
| `admin-client.js` | `GET /app.js` | All JavaScript logic (~700 lines) |
| `admin-panel.css` | `GET /app.css` | Styles |

The JS holds a single `state` object:

```js
state = {
  user,          // currently logged-in user or null
  keys,          // array of endpoint records from /api/admin/keys
  users,         // array of user records from /api/admin/users
  activeTab,     // "keys" or "users"
  explorer: {    // file explorer modal state
    slug, name, currentPath, breadcrumbs, entries
  }
}
```

All UI re-renders are triggered imperatively — there is no reactivity framework. Functions like `renderKeys()` and `renderUsers()` clear and rebuild the relevant DOM nodes from the current `state`.

```mermaid
stateDiagram-v2
    [*] --> CheckingSession: page load → GET /api/session/me
    CheckingSession --> LoggedOut: 401 response
    CheckingSession --> LoggedIn: 200 response
    LoggedOut --> LoggedIn: POST /api/session/login success
    LoggedIn --> LoggedOut: POST /api/session/logout
    LoggedIn --> KeysTab: default view
    LoggedIn --> UsersTab: only api_manager role
    KeysTab --> ExplorerModal: click Open Explorer
    ExplorerModal --> KeysTab: close modal
    KeysTab --> KeysTab: create / revoke / restore / rotate / delete key
    UsersTab --> UsersTab: create / enable / disable / delete user\nupdate viewer scopes
```

---

## 9. Permission Model

```mermaid
graph LR
    subgraph Roles
        AM[api_manager]
        V[viewer]
    end
    subgraph Permissions
        MK[manageKeys\ncreate, revoke, restore, rotate, delete endpoints]
        MU[manageUsers\ncreate, disable, enable, delete users]
        ES[endpointScopes\nread-only access to specific endpoint folders]
    end
    AM --> MK
    AM --> MU
    V --> ES
```

- `api_manager` derives both `manageKeys` and `manageUsers` from the role string alone — no separate permission rows in the database.
- `viewer` accounts get a row in `user_endpoint_scopes` for each endpoint slug they are allowed to browse.
- The `assertEndpointAccess` function short-circuits for managers (they see everything) and checks `user.endpointScopes` for viewers.

---

## 10. Python Companion Architecture

```mermaid
graph TB
    subgraph Companion
        UP["uploader.py\nCLI entry point\nargparse"]
        GUI_PY["gui.py\nTkinter GUI\nRuns sync on background thread\nPolls log queue every 150ms"]
        SC["sync_client.py\nShared library"]
        ENV_FILE[".env file\nKEY=value pairs"]

        UP -- "resolve_config()\nsync_folder()\nupload_file()" --> SC
        GUI_PY -- "resolve_config()\nread_saved_config()\nsave_env()\nsync_folder()\nupload_file()\nensure_test_file()" --> SC
        SC <-- "load_env()\nsave_env()" --> ENV_FILE
    end
```

`sync_client.py` is the **shared kernel** — neither `uploader.py` nor `gui.py` duplicates upload logic. The GUI runs uploads on a background `threading.Thread` to keep the Tkinter event loop responsive. Results are posted to a `queue.Queue` and flushed into the log widget by the main thread via `root.after(150, ...)`.

---

## 11. Security Properties

| Property | Implementation |
|---|---|
| Password storage | scrypt (N=32768 by default via Node `crypto.scryptSync`) with a random 16-byte hex salt per user |
| API key storage | Same scrypt approach; plaintext key shown once and never persisted |
| Timing-safe comparison | `crypto.timingSafeEqual` used for both password and API key verification |
| Session tokens | 32 random bytes → 64-char hex string; stored server-side only in a `Map` |
| Session cookie flags | `HttpOnly`, `SameSite=Strict`, `Secure` (in production), `Max-Age=43200` |
| Path traversal prevention | `sanitizeRelativePath()` in `utils/files.js` rejects `..` segments and non-safe characters |
| Upload size cap | `MAX_UPLOAD_BYTES = 25 MB` enforced in `readRequestBuffer` before multipart parsing |
| Self-deletion prevention | `deleteUserRecord` compares target `userId` to the current session's `actorUserId` |
| Scope isolation | Viewer accounts cannot see or download files outside their assigned `endpointScopes` |

---

## 12. Configuration & Environment Variables

All configuration is centralized in `src/config.js`. Every value can be overridden by an environment variable:

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `3000` | TCP port the server listens on |
| `HOST` | `0.0.0.0` | Bind address (all interfaces) |
| `NODE_ENV` | _(unset)_ | Set to `production` to add `Secure` flag to session cookie |
| `SYNCHRO_BOOTSTRAP_USER` | `admin` | Username for the auto-created first admin |
| `SYNCHRO_BOOTSTRAP_PASSWORD` | _(random)_ | Password for the auto-created first admin |

Python companion variables:

- `SynchroCompanion` stores these values in `companion/.env`.
- `SynchroCommander` stores the same `SYNCHRO_*` keys in `companion_commander/commander.env`.

| Variable | Effect |
|---|---|
| `SYNCHRO_SERVER` | Base URL of the Node server |
| `SYNCHRO_ENDPOINT` | Endpoint slug to upload to |
| `SYNCHRO_API_KEY` | Plaintext API key for the endpoint |
| `SYNCHRO_FOLDER` | Local folder to sync recursively |
| `SYNCHRO_PROFILE` | `default` or `verifone_commander` (HTML-only filter) |

---

## 13. Startup Sequence

```mermaid
sequenceDiagram
    participant OS as OS / npm start
    participant SRV as server.js
    participant CFG as config.js
    participant STOR as storage.js
    participant DB as synchro.sqlite

    OS->>SRV: node src/server.js
    SRV->>CFG: require("./config") — read env vars
    SRV->>SRV: ensureDirectory(DATA_DIR)\nensureDirectory(STORAGE_DIR)
    SRV->>SRV: createSessionManager(storage)
    SRV->>STOR: initializeStorage()
    STOR->>DB: openDatabase(DB_PATH)\nPRAGMA foreign_keys = ON
    STOR->>DB: CREATE TABLE IF NOT EXISTS (3 tables)
    STOR->>DB: migrateEndpointKeySchema() — safe column additions
    STOR->>DB: importLegacyJsonData() — one-time JSON→SQLite migration
    STOR-->>SRV: resolved
    SRV->>STOR: ensureBootstrapAdmin()
    STOR->>DB: SELECT COUNT(*) FROM users
    DB-->>STOR: 0 rows (first run)
    STOR->>DB: INSERT INTO users (bootstrap admin)
    STOR-->>SRV: resolved
    SRV->>SRV: server.listen(PORT, HOST, callback)
    SRV->>OS: console.log("Synchro upload service listening on...")
```
