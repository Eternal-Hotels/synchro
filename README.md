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
  - Parsed HTML report viewing directly inside the endpoint explorer for browser users
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
- A separate SynchroCommander test track in `companion_commander/` that:
  - Builds a side-by-side `SynchroCommander.exe` without changing `SynchroCompanion.exe`
  - Stores its runtime state in `companion_commander/commander.env`
  - Writes its own test file, scheduled log, and sync-hash manifest so it can be tested safely beside the current working companion

## Run the server

Create a root `.env` file (already scaffolded in this repo) and set your environment values:

```dotenv
HOST=0.0.0.0
PORT=3000
SYNCHRO_GRAPH_TENANT_ID=your-tenant-id-guid
SYNCHRO_GRAPH_CLIENT_ID=your-app-client-id-guid
SYNCHRO_GRAPH_CLIENT_SECRET=your-client-secret
```

Then start the server:

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

## Run SynchroCommander

SynchroCommander is the parallel Verifone test companion. It lives under `companion_commander/` and does not share runtime state with the current working companion.

Seed its config by copying `companion_commander/.env.example` to `companion_commander/commander.env`, or by running the commander entrypoints and saving settings there.

The direct Verifone path no longer shells out to `RNR.exe` or `ReportNavigator.exe`. It logs into the site controller over HTTPS, retrieves the report XML directly, and applies the bundled Verifone XSLT assets in-process. If you need to override the asset location while running from source, set `SYNCHRO_VERIFONE_ASSETS_DIR` to a folder that contains the `vfit/` tree from ReportNavigator.

To use the desktop GUI:

```powershell
python companion_commander/gui.py
```

To run a headless scheduled sync using the saved commander settings:

```powershell
python companion_commander/gui.py --scheduled
```

For the packaged app, the same pattern works:

```powershell
SynchroCommander.exe --scheduled
```

This mode reads its settings from `companion_commander/commander.env` when run from source, or from `commander.env` next to the executable when packaged. It also writes `commander-scheduled-sync.log`, `commander-sync-hashes.json`, and `commander-test.txt` beside the running app.

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

## Build SynchroCommander

To rebuild the packaged SynchroCommander executable from the forked Python source:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-commander.ps1
```

That script rebuilds the exe from `companion_commander/SynchroCommander.spec` and updates:

- `companion_commander/dist/SynchroCommander.exe`
- `companion_commander/release/SynchroCommander.exe`
- `companion_commander/release_envfix/SynchroCommander.exe`

The commander spec bundles the Verifone `vfit` transform assets into the executable. The build script also prefers `synchro/.venv/Scripts/python.exe` so PyInstaller and `lxml` come from the same environment used for development.

If you want to inspect PyInstaller's temporary `dist_rebuild` and `build_rebuild` folders after a build:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-commander.ps1 -KeepBuildArtifacts
```

In VS Code, run the `Build SynchroCommander` task to call the same script.

## Storage

- User accounts, endpoint keys, and viewer endpoint scopes are stored in `data/synchro.sqlite`.
- On the first SQLite-backed startup, the server automatically imports any existing `data/users.json` and `data/keys.json` records into SQLite if the database is empty.
- Stored upload files still live on disk under `storage/<endpointSlug>/`.

## Parse category reports to CSV

If a synced report set contains one or more `Category.html` files, you can export all category rows to a CSV with:

```powershell
npm run parse:categories -- --input storage\smoke-test-client\3\2026-04-30.046
```

You can also point it directly at one report file:

```powershell
npm run parse:categories -- --input storage\smoke-test-client\3\2026-04-30.046\Category.html
```

By default, the script writes `category-export.csv` into the input folder, or `Category-categories.csv` next to a single input file. To choose a destination:

```powershell
npm run parse:categories -- --input storage\smoke-test-client --output data\category-export.csv
```

Inside the web control panel, signed-in users can also open an endpoint explorer, click `View Parsed` on any synced `.html` or `.htm` report, and review the extracted tables in the browser.

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
- In `Settings`, manage `Report Digest Delivery` and `Morning Sync Log` recipients separately. Use the test-send actions to verify Graph mail delivery without waiting for the scheduled send times.
- For an internet-exposed deployment, put this behind HTTPS and consider adding CSRF protection, audit logging, and password reset flows.
