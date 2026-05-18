from datetime import datetime, timedelta
import hashlib
import http.client
import json
import mimetypes
import pathlib
import subprocess
import sys
import uuid
from urllib.parse import urlparse


# This module contains the shared "business logic" for the Python tools.
# The command-line script and the GUI both call into these helpers so they do
# not have to reimplement config loading, multipart upload construction, or
# recursive folder syncing.
SOURCE_DIR = pathlib.Path(__file__).resolve().parent
DEFAULT_VERIFONE_RNR_EXE = r"C:\Reports\RNR\RNR.exe"
DEFAULT_VERIFONE_RNR_IP = "192.168.31.11"
DEFAULT_VERIFONE_RNR_REPORT = "daily"
DEFAULT_VERIFONE_EXPORT_DIR = r"C:\Reports\DR"
DEFAULT_MONTHLY_EXE = r"C:\Reports\RNR\ReportNavigator.exe"
DEFAULT_MONTHLY_IP = DEFAULT_VERIFONE_RNR_IP
DEFAULT_MONTHLY_REPORT = "Monthly Report"
DEFAULT_MONTHLY_USER = "manager"
DEFAULT_MONTHLY_PASSWORD = "C123456"
DEFAULT_MONTHLY_EXPORT_DIR = r"C:\Reports\MR"


def runtime_dir():
    # When the script is packaged as an .exe, files may need to live next to the
    # executable instead of next to the original source code.
    if getattr(sys, "frozen", False):
        cwd = pathlib.Path.cwd().resolve()
        exe_dir = pathlib.Path(sys.executable).resolve().parent
        if (cwd / "commander.env").exists() or cwd == exe_dir:
            return cwd
        return exe_dir
    return SOURCE_DIR


def env_path():
    # We store reusable settings in a plain-text commander.env file beside the running app.
    return runtime_dir() / "commander.env"


def test_file_path():
    # The test upload always uses the same predictable file name.
    return runtime_dir() / "commander-test.txt"


def scheduled_log_path():
    # Headless runs need a durable log because Task Scheduler often hides console output.
    return runtime_dir() / "commander-scheduled-sync.log"


def hash_manifest_path():
    # Store per-sync fingerprints beside the app so scheduled and GUI runs share state.
    return runtime_dir() / "commander-sync-hashes.json"


def load_env():
    # Read KEY=value lines from commander.env into a dictionary.
    values = {}
    target = env_path()
    if not target.exists():
        return values

    for line in target.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def save_env(values):
    # Persist the dictionary back to disk in the same KEY=value format.
    lines = [f"{key}={value}" for key, value in values.items()]
    env_path().write_text("\n".join(lines) + "\n", encoding="utf-8")


def append_scheduled_log(message):
    # Prefix every line with a timestamp so repeated scheduled runs are easier to trace.
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with scheduled_log_path().open("a", encoding="utf-8") as handle:
        handle.write(f"[{timestamp}] {message}\n")


def load_hash_manifest():
    target = hash_manifest_path()
    if not target.exists():
        return {}

    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}

    return data if isinstance(data, dict) else {}


def save_hash_manifest(manifest):
    hash_manifest_path().write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8"
    )


def read_saved_config():
    # This gives the GUI a clean snapshot of saved values to preload into the form.
    env = load_env()
    return {
        "server": env.get("SYNCHRO_SERVER", "http://localhost:3000"),
        "endpoint": env.get("SYNCHRO_ENDPOINT", ""),
        "api_key": env.get("SYNCHRO_API_KEY", ""),
        "folder": env.get("SYNCHRO_FOLDER", ""),
        "profile": env.get("SYNCHRO_PROFILE", "default"),
        "verifone_username": env.get("SYNCHRO_VERIFONE_USERNAME", ""),
        "verifone_password": env.get("SYNCHRO_VERIFONE_PASSWORD", ""),
        "verifone_rnr_path": env.get("SYNCHRO_VERIFONE_RNR_PATH", DEFAULT_VERIFONE_RNR_EXE),
        "verifone_rnr_ip": env.get("SYNCHRO_VERIFONE_RNR_IP", DEFAULT_VERIFONE_RNR_IP),
        "verifone_rnr_report": env.get("SYNCHRO_VERIFONE_RNR_REPORT", DEFAULT_VERIFONE_RNR_REPORT),
        "verifone_export_dir": env.get("SYNCHRO_VERIFONE_EXPORT_DIR", DEFAULT_VERIFONE_EXPORT_DIR),
        "monthly_exe_path": env.get("SYNCHRO_MONTHLY_EXE_PATH", DEFAULT_MONTHLY_EXE),
        "monthly_ip": env.get("SYNCHRO_MONTHLY_IP", DEFAULT_MONTHLY_IP),
        "monthly_report": env.get("SYNCHRO_MONTHLY_REPORT", DEFAULT_MONTHLY_REPORT),
        "monthly_user": env.get("SYNCHRO_MONTHLY_USER", DEFAULT_MONTHLY_USER),
        "monthly_password": env.get("SYNCHRO_MONTHLY_PASSWORD", DEFAULT_MONTHLY_PASSWORD),
        "monthly_export_dir": env.get("SYNCHRO_MONTHLY_EXPORT_DIR", DEFAULT_MONTHLY_EXPORT_DIR)
    }


def profile_choices():
    # One shared list keeps the CLI, GUI, and scheduled mode speaking the same profile names.
    return {
        "default": "Default",
        "verifone_commander": "Verifone Commander",
        "gilbarco_storeclose": "Gilbarco StoreClose"
    }


def profile_label(profile):
    # Convert a stored profile ID into a user-facing label.
    return profile_choices().get(profile, "Default")


def profile_description(profile):
    # Each profile is really just a different file-selection rule for folder syncs.
    descriptions = {
        "default": "All files will sync.",
        "verifone_commander": "Only .html and .htm files will sync.",
        "gilbarco_storeclose": "Only PDF files whose names start with StoreClose will sync."
    }
    return descriptions.get(profile, descriptions["default"])


def resolve_config(
    server=None,
    endpoint=None,
    api_key=None,
    folder=None,
    profile=None,
    verifone_username=None,
    verifone_password=None,
    verifone_rnr_path=None,
    verifone_rnr_ip=None,
    verifone_rnr_report=None,
    verifone_export_dir=None,
    monthly_exe_path=None,
    monthly_ip=None,
    monthly_report=None,
    monthly_user=None,
    monthly_password=None,
    monthly_export_dir=None,
    persist=True,
    require_credentials=True
):
    # Build the active configuration by preferring explicit function arguments and
    # falling back to values already saved in commander.env.
    env = load_env()

    resolved = {
        "server": server or env.get("SYNCHRO_SERVER", "http://localhost:3000"),
        "endpoint": endpoint or env.get("SYNCHRO_ENDPOINT", ""),
        "api_key": api_key or env.get("SYNCHRO_API_KEY", ""),
        "folder": folder or env.get("SYNCHRO_FOLDER", ""),
        "profile": profile or env.get("SYNCHRO_PROFILE", "default"),
        "verifone_username": (
            verifone_username
            if verifone_username is not None
            else env.get("SYNCHRO_VERIFONE_USERNAME", "")
        ),
        "verifone_password": (
            verifone_password
            if verifone_password is not None
            else env.get("SYNCHRO_VERIFONE_PASSWORD", "")
        ),
        "verifone_rnr_path": (
            verifone_rnr_path
            if verifone_rnr_path is not None
            else env.get("SYNCHRO_VERIFONE_RNR_PATH", DEFAULT_VERIFONE_RNR_EXE)
        ),
        "verifone_rnr_ip": (
            verifone_rnr_ip
            if verifone_rnr_ip is not None
            else env.get("SYNCHRO_VERIFONE_RNR_IP", DEFAULT_VERIFONE_RNR_IP)
        ),
        "verifone_rnr_report": (
            verifone_rnr_report
            if verifone_rnr_report is not None
            else env.get("SYNCHRO_VERIFONE_RNR_REPORT", DEFAULT_VERIFONE_RNR_REPORT)
        ),
        "verifone_export_dir": (
            verifone_export_dir
            if verifone_export_dir is not None
            else env.get("SYNCHRO_VERIFONE_EXPORT_DIR", DEFAULT_VERIFONE_EXPORT_DIR)
        ),
        "monthly_exe_path": (
            monthly_exe_path
            if monthly_exe_path is not None
            else env.get("SYNCHRO_MONTHLY_EXE_PATH", DEFAULT_MONTHLY_EXE)
        ),
        "monthly_ip": (
            monthly_ip
            if monthly_ip is not None
            else env.get("SYNCHRO_MONTHLY_IP", DEFAULT_MONTHLY_IP)
        ),
        "monthly_report": (
            monthly_report
            if monthly_report is not None
            else env.get("SYNCHRO_MONTHLY_REPORT", DEFAULT_MONTHLY_REPORT)
        ),
        "monthly_user": (
            monthly_user
            if monthly_user is not None
            else env.get("SYNCHRO_MONTHLY_USER", DEFAULT_MONTHLY_USER)
        ),
        "monthly_password": (
            monthly_password
            if monthly_password is not None
            else env.get("SYNCHRO_MONTHLY_PASSWORD", DEFAULT_MONTHLY_PASSWORD)
        ),
        "monthly_export_dir": (
            monthly_export_dir
            if monthly_export_dir is not None
            else env.get("SYNCHRO_MONTHLY_EXPORT_DIR", DEFAULT_MONTHLY_EXPORT_DIR)
        )
    }

    # A sync job cannot talk to the server unless it knows which endpoint and key to use.
    if require_credentials and (not resolved["endpoint"] or not resolved["api_key"]):
        raise SystemExit(
            "Missing endpoint or key. Run once with --endpoint and --key, or enter them in the GUI."
        )

    # Saving here means the CLI and GUI both update the same remembered settings.
    if persist:
        env["SYNCHRO_SERVER"] = resolved["server"]
        env["SYNCHRO_ENDPOINT"] = resolved["endpoint"]
        env["SYNCHRO_API_KEY"] = resolved["api_key"]
        env["SYNCHRO_PROFILE"] = resolved["profile"]
        env["SYNCHRO_VERIFONE_USERNAME"] = resolved["verifone_username"]
        env["SYNCHRO_VERIFONE_PASSWORD"] = resolved["verifone_password"]
        env["SYNCHRO_VERIFONE_RNR_PATH"] = resolved["verifone_rnr_path"]
        env["SYNCHRO_VERIFONE_RNR_IP"] = resolved["verifone_rnr_ip"]
        env["SYNCHRO_VERIFONE_RNR_REPORT"] = resolved["verifone_rnr_report"]
        env["SYNCHRO_VERIFONE_EXPORT_DIR"] = resolved["verifone_export_dir"]
        env["SYNCHRO_MONTHLY_EXE_PATH"] = resolved["monthly_exe_path"]
        env["SYNCHRO_MONTHLY_IP"] = resolved["monthly_ip"]
        env["SYNCHRO_MONTHLY_REPORT"] = resolved["monthly_report"]
        env["SYNCHRO_MONTHLY_USER"] = resolved["monthly_user"]
        env["SYNCHRO_MONTHLY_PASSWORD"] = resolved["monthly_password"]
        env["SYNCHRO_MONTHLY_EXPORT_DIR"] = resolved["monthly_export_dir"]
        if resolved["folder"]:
            env["SYNCHRO_FOLDER"] = resolved["folder"]
        elif "SYNCHRO_FOLDER" in env:
            del env["SYNCHRO_FOLDER"]
        save_env(env)

    return resolved


def ensure_test_file():
    # The server upload path accepts arbitrary files, but a tiny text file is an
    # easy, low-risk way to verify credentials and connectivity.
    target = test_file_path()
    target.write_text("successful", encoding="utf-8")
    return target


def build_multipart_body(file_path):
    # Multipart/form-data is the same format browsers use when uploading files
    # from an HTML <form>. We build that payload manually so we do not need any
    # third-party Python HTTP libraries.
    boundary = f"----SynchroBoundary{uuid.uuid4().hex}"
    filename = file_path.name
    content = file_path.read_bytes()
    mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"

    body = bytearray()
    # Each multipart "part" starts with a boundary line plus headers that describe the file.
    body.extend(f"--{boundary}\r\n".encode("utf-8"))
    body.extend(
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode("utf-8")
    )
    body.extend(f"Content-Type: {mime_type}\r\n\r\n".encode("utf-8"))
    body.extend(content)
    body.extend(f"\r\n--{boundary}--\r\n".encode("utf-8"))
    return boundary, bytes(body)


def upload_file(server_url, endpoint, api_key, file_path, relative_path=None):
    # Parse the base URL so we can decide whether to open an HTTP or HTTPS connection.
    parsed = urlparse(server_url)
    if parsed.scheme not in {"http", "https"}:
        raise SystemExit("Server URL must start with http:// or https://")

    file_path = pathlib.Path(file_path).resolve()
    connection_class = (
        http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    )
    connection = connection_class(parsed.hostname, parsed.port)
    boundary, body = build_multipart_body(file_path)
    upload_path = f"/api/upload/{endpoint}"

    # If the server is hosted under a sub-path, keep that prefix when forming the route.
    if parsed.path and parsed.path != "/":
      upload_path = parsed.path.rstrip("/") + upload_path

    headers = {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Content-Length": str(len(body)),
        "X-API-Key": api_key,
    }
    if relative_path:
        # For folder syncs, the server stores this path under the endpoint directory.
        headers["X-Relative-Path"] = normalize_relative_path(relative_path)

    # Send the request, then read the whole response body before closing the socket.
    connection.request("POST", upload_path, body=body, headers=headers)
    response = connection.getresponse()
    payload = response.read().decode("utf-8", errors="replace")
    connection.close()
    return response.status, payload


def build_sync_scope_key(server_url, endpoint, folder_path, profile):
    parsed = urlparse(server_url)
    base_url = f"{parsed.scheme.lower()}://{parsed.netloc.lower()}{parsed.path.rstrip('/')}"
    normalized_root = str(pathlib.Path(folder_path).resolve()).lower()
    return " | ".join([
        base_url,
        str(endpoint or "").strip().lower(),
        str(profile or "default").strip().lower(),
        normalized_root
    ])


def hash_file(file_path):
    digest = hashlib.sha256()
    with pathlib.Path(file_path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_skipped_result(file_path, relative_path, reason):
    return {
        "file": str(file_path),
        "relative_path": relative_path,
        "status": 0,
        "payload": reason,
        "skipped": True,
        "reason": reason
    }


def resolve_verifone_sync_settings(
    server_url,
    endpoint,
    api_key,
    profile,
    verifone_username,
    verifone_password,
    status_callback=None
):
    if profile != "verifone_commander":
        return {
            "profile": profile,
            "verifone_username": verifone_username,
            "verifone_password": verifone_password
        }

    if status_callback:
        status_callback("Fetching Verifone Commander credentials from Synchro admin...")

    remote = fetch_companion_config(server_url, endpoint, api_key)
    remote_profile = str(remote.get("profile") or "").strip() or profile
    remote_username = str(remote.get("verifone_username") or "").strip()
    remote_password = str(remote.get("verifone_password") or "")

    if status_callback:
        payment_system = str(remote.get("payment_system") or "unknown")
        status_callback(
            f"Loaded endpoint config for {endpoint} ({payment_system}); using profile {remote_profile}."
        )

    return {
        "profile": remote_profile,
        "verifone_username": remote_username or verifone_username,
        "verifone_password": remote_password or verifone_password
    }


def fetch_companion_config(server_url, endpoint, api_key):
    # Pull the endpoint's active sync profile and any Verifone credentials from the server.
    parsed = urlparse(server_url)
    if parsed.scheme not in {"http", "https"}:
        raise SystemExit("Server URL must start with http:// or https://")

    connection_class = (
        http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    )
    connection = connection_class(parsed.hostname, parsed.port)
    config_path = f"/api/upload/{endpoint}/config"

    if parsed.path and parsed.path != "/":
        config_path = parsed.path.rstrip("/") + config_path

    connection.request("GET", config_path, headers={"X-API-Key": api_key})
    response = connection.getresponse()
    raw_payload = response.read().decode("utf-8", errors="replace")
    connection.close()

    try:
        payload = json.loads(raw_payload) if raw_payload else {}
    except json.JSONDecodeError:
        payload = {}

    if not (200 <= response.status < 300):
        message = payload.get("error") if isinstance(payload, dict) else ""
        raise SystemExit(message or f"Could not fetch endpoint config (HTTP {response.status}).")

    return {
        "endpoint": str(payload.get("endpoint") or endpoint),
        "payment_system": str(payload.get("paymentSystem") or ""),
        "profile": str(payload.get("profile") or "default"),
        "verifone_username": str(payload.get("verifoneUsername") or ""),
        "verifone_password": str(payload.get("verifonePassword") or "")
    }


def verifone_export_path(export_dir, now=None):
    # Daily sales are for the prior close period, so date the file to yesterday.
    current = now or datetime.now()
    report_date = current - timedelta(days=1)
    return pathlib.Path(export_dir) / f"DR-{report_date.strftime('%Y%m%d')}.html"


def monthly_export_path(export_dir, now=None):
    # Monthly export uses the MR prefix but still carries the current yyyymmdd suffix.
    current = now or datetime.now()
    return pathlib.Path(export_dir) / f"MR-{current.strftime('%Y%m%d')}.html"


def run_report_export_command(
    exe_path,
    report_name,
    ip_address,
    username,
    password,
    export_path,
    status_callback=None,
    label="Report"
):
    export_path = pathlib.Path(export_path)
    if not exe_path.exists():
        raise SystemExit(f"{label} runner not found: {exe_path}")

    export_path.parent.mkdir(parents=True, exist_ok=True)
    had_existing_file = export_path.exists()
    previous_mtime = export_path.stat().st_mtime if had_existing_file else None

    if status_callback:
        status_callback(f"Running {label} export: {exe_path.name}")

    command = [
        str(exe_path),
        f"/report:{report_name}",
        f"/ip:{ip_address}",
        f"/user:{username}",
        f"/password:{password}",
        f"/export:{export_path}"
    ]

    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        cwd=str(exe_path.parent)
    )
    if result.returncode != 0:
        details = (result.stderr or result.stdout or f"{exe_path.name} returned a non-zero exit code.").strip()
        raise SystemExit(f"{label} export failed: {details}")

    if not export_path.exists():
        raise SystemExit(f"{label} export did not produce {export_path}")

    current_mtime = export_path.stat().st_mtime
    if previous_mtime is not None and current_mtime <= previous_mtime:
        raise SystemExit(f"{label} export did not refresh {export_path}")
    if export_path.stat().st_size <= 0:
        raise SystemExit(f"{label} export produced an empty file: {export_path}")

    if status_callback:
        action = "Created" if not had_existing_file else "Refreshed"
        status_callback(f"{action} {label} report: {export_path}")

    return export_path


def run_verifone_commander_export(
    username,
    password,
    rnr_exe_path=None,
    rnr_ip=None,
    rnr_report=None,
    export_dir=None,
    monthly_exe_path=None,
    monthly_ip=None,
    monthly_report=None,
    monthly_user=None,
    monthly_password=None,
    monthly_export_dir=None,
    status_callback=None
):
    # The Verifone sync profile must refresh the daily report before any HTML upload begins.
    if not username:
        raise SystemExit("Missing Verifone Commander username. Fetch endpoint config or save it in SynchroCommander first.")
    if not password:
        raise SystemExit("Missing Verifone Commander password. Fetch endpoint config or save it in SynchroCommander first.")
    rnr_exe = pathlib.Path(rnr_exe_path or DEFAULT_VERIFONE_RNR_EXE)
    export_root = pathlib.Path(export_dir or DEFAULT_VERIFONE_EXPORT_DIR)
    command_ip = rnr_ip or DEFAULT_VERIFONE_RNR_IP
    command_report = rnr_report or DEFAULT_VERIFONE_RNR_REPORT
    export_path = verifone_export_path(export_root)

    daily_export = run_report_export_command(
        exe_path=rnr_exe,
        report_name=command_report,
        ip_address=command_ip,
        username=username,
        password=password,
        export_path=export_path,
        status_callback=status_callback,
        label="Verifone daily"
    )

    now = datetime.now()
    if now.day == 1:
        run_monthly_verifone_export(
            monthly_exe_path=monthly_exe_path,
            monthly_ip=monthly_ip,
            monthly_report=monthly_report,
            monthly_user=monthly_user,
            monthly_password=monthly_password,
            monthly_export_dir=monthly_export_dir,
            status_callback=status_callback,
            now=now,
            label="Verifone monthly"
        )

    return daily_export


def run_monthly_verifone_export(
    monthly_exe_path=None,
    monthly_ip=None,
    monthly_report=None,
    monthly_user=None,
    monthly_password=None,
    monthly_export_dir=None,
    status_callback=None,
    now=None,
    label="Verifone monthly"
):
    current = now or datetime.now()
    monthly_exe = pathlib.Path(monthly_exe_path or DEFAULT_MONTHLY_EXE)
    export_path = monthly_export_path(monthly_export_dir or DEFAULT_MONTHLY_EXPORT_DIR, now=current)
    return run_report_export_command(
        exe_path=monthly_exe,
        report_name=monthly_report or DEFAULT_MONTHLY_REPORT,
        ip_address=monthly_ip or DEFAULT_MONTHLY_IP,
        username=monthly_user or DEFAULT_MONTHLY_USER,
        password=monthly_password or DEFAULT_MONTHLY_PASSWORD,
        export_path=export_path,
        status_callback=status_callback,
        label=label
    )


def sync_folder(
    server_url,
    endpoint,
    api_key,
    folder_path,
    progress_callback=None,
    profile="default",
    verifone_username="",
    verifone_password="",
    verifone_rnr_path="",
    verifone_rnr_ip="",
    verifone_rnr_report="",
    verifone_export_dir="",
    monthly_exe_path="",
    monthly_ip="",
    monthly_report="",
    monthly_user="",
    monthly_password="",
    monthly_export_dir="",
    status_callback=None
):
    # Resolve the sync root once so every uploaded file can be expressed relative to it.
    root = pathlib.Path(folder_path).resolve()
    if not root.exists() or not root.is_dir():
        raise SystemExit(f"Folder not found: {root}")

    resolved_sync = resolve_verifone_sync_settings(
        server_url,
        endpoint,
        api_key,
        profile,
        verifone_username,
        verifone_password,
        status_callback=status_callback
    )
    profile = resolved_sync["profile"]
    verifone_username = resolved_sync["verifone_username"]
    verifone_password = resolved_sync["verifone_password"]

    if profile == "verifone_commander":
        run_verifone_commander_export(
            verifone_username,
            verifone_password,
            rnr_exe_path=verifone_rnr_path,
            rnr_ip=verifone_rnr_ip,
            rnr_report=verifone_rnr_report,
            export_dir=verifone_export_dir,
            monthly_exe_path=monthly_exe_path,
            monthly_ip=monthly_ip,
            monthly_report=monthly_report,
            monthly_user=monthly_user,
            monthly_password=monthly_password,
            monthly_export_dir=monthly_export_dir,
            status_callback=status_callback
        )

    # rglob("*") walks the directory tree recursively; we then keep only real files
    # and apply the chosen sync profile's filtering rules.
    files = sorted(
        path for path in root.rglob("*")
        if path.is_file() and should_upload_file(path, profile)
    )
    manifest = load_hash_manifest()
    scope_key = build_sync_scope_key(server_url, endpoint, root, profile)
    scope_manifest = manifest.get(scope_key)
    if not isinstance(scope_manifest, dict):
        scope_manifest = {}

    results = []
    current_relative_paths = set()
    for file_path in files:
        # The server expects forward-slash relative paths, even on Windows.
        relative = file_path.relative_to(root).as_posix()
        current_relative_paths.add(relative)
        stats = file_path.stat()
        cached = scope_manifest.get(relative)
        file_hash = ""

        if (
            isinstance(cached, dict)
            and cached.get("sha256")
            and cached.get("size") == stats.st_size
            and cached.get("mtime_ns") == stats.st_mtime_ns
        ):
            file_hash = str(cached["sha256"])
        else:
            file_hash = hash_file(file_path)

        if isinstance(cached, dict) and cached.get("sha256") == file_hash:
            scope_manifest[relative] = {
                "sha256": file_hash,
                "size": stats.st_size,
                "mtime_ns": stats.st_mtime_ns
            }
            result = build_skipped_result(file_path, relative, "unchanged")
            results.append(result)
            if progress_callback:
                progress_callback(result)
            continue

        status, payload = upload_file(
            server_url,
            endpoint,
            api_key,
            file_path,
            relative_path=relative
        )
        result = {
            "file": str(file_path),
            "relative_path": relative,
            "status": status,
            "payload": payload
        }
        if 200 <= status < 300:
            scope_manifest[relative] = {
                "sha256": file_hash,
                "size": stats.st_size,
                "mtime_ns": stats.st_mtime_ns
            }
        results.append(result)
        if progress_callback:
            progress_callback(result)

    stale_paths = [relative for relative in scope_manifest if relative not in current_relative_paths]
    for relative in stale_paths:
        del scope_manifest[relative]

    manifest[scope_key] = scope_manifest
    save_hash_manifest(manifest)
    return results


def should_upload_file(file_path, profile):
    # Profiles let us reuse the same sync engine while changing which files are eligible.
    file_path = pathlib.Path(file_path)
    suffix = file_path.suffix.lower()
    name = file_path.name.lower()
    if profile == "verifone_commander":
        return suffix in {".html", ".htm"}
    if profile == "gilbarco_storeclose":
        return suffix == ".pdf" and name.startswith("storeclose")
    return True


def normalize_relative_path(relative_path):
    # This strips "." segments and rejects ".." so callers cannot escape the
    # endpoint's storage directory on the server.
    parts = []
    for part in pathlib.PurePosixPath(str(relative_path).replace("\\", "/")).parts:
        if part in {"", "."}:
            continue
        if part == "..":
            raise SystemExit("Relative paths cannot contain '..'")
        parts.append(part)
    if not parts:
        raise SystemExit("Relative path is empty.")
    return "/".join(parts)
