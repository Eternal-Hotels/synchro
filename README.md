# Synchro Upload Service

This project scaffolds a self-contained Node.js upload server and a Python companion uploader. Each remote client gets its own endpoint slug and API key, and every endpoint writes into its own folder under `storage/`.

## What it includes

- A Node.js server with:
  - `POST /api/upload/:endpointSlug` for authenticated file uploads
  - A local authenticated admin panel at `/`
  - Cookie-based sign-in for Synchro users
  - `api_manager` accounts that can create, revoke, restore, and delete endpoint keys
  - `api_manager` accounts that can create, disable, enable, and delete users
  - `viewer` accounts that can only see file uploads for assigned endpoint folders
  - File browsing and download links for each endpoint the signed-in user can access
- A Python companion app in `companion/uploader.py` that:
  - Saves `SYNCHRO_SERVER`, `SYNCHRO_ENDPOINT`, and `SYNCHRO_API_KEY` to `companion/.env`
  - Creates `companion/test.txt` with the text `successful`
  - Uploads that file to the selected endpoint
  - Can recursively sync an entire folder while preserving relative paths
- A desktop GUI in `companion/gui.py` that:
  - Saves server, endpoint, API key, and folder settings
  - Uploads a test file on demand
  - Syncs a selected folder to the server
  - Includes sync profiles for `Verifone Commander` HTML-only syncs and `Gilbarco StoreClose` PDF-only syncs

## Run the server

```powershell
npm start
```

Then open `http://localhost:3000` in a browser.

## First sign-in

On the very first startup, the server creates a bootstrap admin account in `data/synchro.sqlite` and prints the credentials to the console.

- Default username: `admin`
- Default password: randomly generated unless you set `SYNCHRO_BOOTSTRAP_PASSWORD`

You can also predefine the bootstrap admin with:

```powershell
$env:SYNCHRO_BOOTSTRAP_USER="admin"
$env:SYNCHRO_BOOTSTRAP_PASSWORD="change-me-now"
npm start
```

## Create an endpoint key

1. Sign in as an `api_manager`.
2. Enter a client name and click `Create Endpoint Key`.
3. Copy the endpoint slug and API key from the one-time pop-up immediately.
4. Store that API key somewhere safe, because Synchro does not let admins retrieve it later.

## Create users

From the `Users` tab, an `api_manager` can create:

- `API Manager` users: full endpoint and user-management access
- `Viewer` users: read-only file access scoped to one or more endpoint slugs

Viewer accounts do not see API keys and cannot change endpoint records.

## Run the Python companion

First run, pass the values so they can be saved into `companion/.env`:

```powershell
python companion/uploader.py --server http://localhost:3000 --endpoint your-endpoint-slug --key your-generated-api-key
```

Later runs can reuse the saved `.env` values:

```powershell
python companion/uploader.py
```

To sync an entire folder from the command line:

```powershell
python companion/uploader.py --folder C:\path\to\folder
```

To sync only `.html` and `.htm` files for Verifone Commander:

```powershell
python companion/uploader.py --folder C:\path\to\folder --verifone-commander
```

To sync only Gilbarco `StoreClose*.pdf` reports:

```powershell
python companion/uploader.py --folder C:\path\to\folder --gilbarco-storeclose
```

To use the desktop GUI:

```powershell
python companion/gui.py
```

In the GUI, choose a sync profile from the `Sync Profile` drop-down. That profile is saved in `companion/.env` and will be reused on the next run.

To run a headless scheduled sync using the saved `.env` settings:

```powershell
python companion/gui.py --scheduled
```

For the packaged app, the same pattern works:

```powershell
SynchroCompanion.exe --scheduled
```

This mode does not open the GUI. It reads `SYNCHRO_SERVER`, `SYNCHRO_ENDPOINT`, `SYNCHRO_API_KEY`, `SYNCHRO_FOLDER`, and `SYNCHRO_PROFILE` from the `.env` file next to the executable, runs the sync, prints results to standard output, and exits with a non-zero code if the sync fails.

Each scheduled run also appends a timestamped troubleshooting log to `scheduled-sync.log` next to the running script or executable. For Task Scheduler jobs, that usually means the log sits beside `SynchroCompanion.exe`.

## Build the companion app

To rebuild the packaged Windows executable from the current Python source:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-companion.ps1
```

That script rebuilds the exe from `companion/SynchroCompanion.spec` and updates:

- `companion/dist/SynchroCompanion.exe`
- `companion/release/SynchroCompanion.exe`
- `companion/release_envfix/SynchroCompanion.exe`

If you want to inspect PyInstaller's temporary `dist_rebuild` and `build_rebuild` folders after a build:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-companion.ps1 -KeepBuildArtifacts
```

In VS Code, run the `Build SynchroCompanion` task to call the same script.

## Storage

- User accounts, endpoint keys, and viewer endpoint scopes are stored in `data/synchro.sqlite`.
- On the first SQLite-backed startup, the server automatically imports any existing `data/users.json` and `data/keys.json` records into SQLite if the database is empty.
- Stored upload files still live on disk under `storage/<endpointSlug>/`.

## API key security

- Endpoint API keys are stored as salted `scrypt` hashes in SQLite, not as retrievable plaintext values.
- The full API key is shown only once when an endpoint is created or rotated.
- `api_manager` accounts can rotate keys, but they cannot reveal old or current keys after that one-time display.
- Each endpoint records `last_used_at`, `rotated_at`, and `rotation_count` metadata to support audits and key rotation workflows.

## Notes

- Revoking a key stops new uploads but keeps existing files available in the admin panel.
- Rotating a key invalidates the old key immediately and issues a brand-new one-time key.
- Deleting a key removes the key record only. The stored files remain on disk in `storage/<endpointSlug>`.
- Folder sync uploads preserve relative paths under `storage/<endpointSlug>/`.
- Sessions are stored in memory, so active logins are cleared when the server restarts.
- For an internet-exposed deployment, put this behind HTTPS and consider adding CSRF protection, audit logging, and password reset flows.
