from datetime import datetime
import http.client
import mimetypes
import pathlib
import sys
import uuid
from urllib.parse import urlparse


# This module contains the shared "business logic" for the Python tools.
# The command-line script and the GUI both call into these helpers so they do
# not have to reimplement config loading, multipart upload construction, or
# recursive folder syncing.
SOURCE_DIR = pathlib.Path(__file__).resolve().parent


def runtime_dir():
    # When the script is packaged as an .exe, files may need to live next to the
    # executable instead of next to the original source code.
    if getattr(sys, "frozen", False):
        cwd = pathlib.Path.cwd().resolve()
        exe_dir = pathlib.Path(sys.executable).resolve().parent
        if (cwd / ".env").exists() or cwd == exe_dir:
            return cwd
        return exe_dir
    return SOURCE_DIR


def env_path():
    # We store reusable settings in a plain-text .env file beside the running app.
    return runtime_dir() / ".env"


def test_file_path():
    # The test upload always uses the same predictable file name.
    return runtime_dir() / "test.txt"


def scheduled_log_path():
    # Headless runs need a durable log because Task Scheduler often hides console output.
    return runtime_dir() / "scheduled-sync.log"


def load_env():
    # Read KEY=value lines from .env into a dictionary.
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


def read_saved_config():
    # This gives the GUI a clean snapshot of saved values to preload into the form.
    env = load_env()
    return {
        "server": env.get("SYNCHRO_SERVER", "http://localhost:3000"),
        "endpoint": env.get("SYNCHRO_ENDPOINT", ""),
        "api_key": env.get("SYNCHRO_API_KEY", ""),
        "folder": env.get("SYNCHRO_FOLDER", ""),
        "profile": env.get("SYNCHRO_PROFILE", "default")
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
    persist=True,
    require_credentials=True
):
    # Build the active configuration by preferring explicit function arguments and
    # falling back to values already saved in .env.
    env = load_env()

    resolved = {
        "server": server or env.get("SYNCHRO_SERVER", "http://localhost:3000"),
        "endpoint": endpoint or env.get("SYNCHRO_ENDPOINT", ""),
        "api_key": api_key or env.get("SYNCHRO_API_KEY", ""),
        "folder": folder or env.get("SYNCHRO_FOLDER", ""),
        "profile": profile or env.get("SYNCHRO_PROFILE", "default")
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


def sync_folder(
    server_url,
    endpoint,
    api_key,
    folder_path,
    progress_callback=None,
    profile="default"
):
    # Resolve the sync root once so every uploaded file can be expressed relative to it.
    root = pathlib.Path(folder_path).resolve()
    if not root.exists() or not root.is_dir():
        raise SystemExit(f"Folder not found: {root}")

    # rglob("*") walks the directory tree recursively; we then keep only real files
    # and apply the chosen sync profile's filtering rules.
    files = sorted(
        path for path in root.rglob("*")
        if path.is_file() and should_upload_file(path, profile)
    )
    results = []
    for file_path in files:
        # The server expects forward-slash relative paths, even on Windows.
        relative = file_path.relative_to(root).as_posix()
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
        results.append(result)
        if progress_callback:
            progress_callback(result)
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
