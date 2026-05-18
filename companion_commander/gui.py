import argparse
import pathlib
import queue
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, scrolledtext, ttk

from sync_client import (
    append_scheduled_log,
    ensure_test_file,
    env_path,
    fetch_companion_config,
    profile_choices,
    profile_description,
    profile_label,
    read_saved_config,
    resolve_config,
    scheduled_log_path,
    save_env,
    sync_folder,
    run_monthly_verifone_export,
    upload_file,
)


class SynchroCommanderApp:
    def __init__(self, root):
        # Tkinter stores nearly all window state on the root widget, so we keep a
        # reference to it and then attach the rest of the application state here.
        self.root = root
        self.root.title("SynchroCommander")
        self.root.geometry("780x620")

        # Background workers post messages into this queue so the GUI thread can
        # render them safely during its normal event loop.
        self.log_queue = queue.Queue()
        self.is_busy = False

        # StringVar objects are Tkinter's observable string containers. Widgets
        # can bind to them so changes in Python automatically appear in the UI.
        config = read_saved_config()
        self.server_var = tk.StringVar(value=config["server"])
        self.endpoint_var = tk.StringVar(value=config["endpoint"])
        self.api_key_var = tk.StringVar(value=config["api_key"])
        self.folder_var = tk.StringVar(value=config["folder"])
        self.profile_var = tk.StringVar(value=config["profile"])
        self.verifone_username_var = tk.StringVar(value=config["verifone_username"])
        self.verifone_password_var = tk.StringVar(value=config["verifone_password"])
        self.verifone_rnr_path_var = tk.StringVar(value=config["verifone_rnr_path"])
        self.verifone_rnr_ip_var = tk.StringVar(value=config["verifone_rnr_ip"])
        self.verifone_rnr_report_var = tk.StringVar(value=config["verifone_rnr_report"])
        self.verifone_export_dir_var = tk.StringVar(value=config["verifone_export_dir"])
        self.monthly_exe_path_var = tk.StringVar(value=config["monthly_exe_path"])
        self.monthly_ip_var = tk.StringVar(value=config["monthly_ip"])
        self.monthly_report_var = tk.StringVar(value=config["monthly_report"])
        self.monthly_user_var = tk.StringVar(value=config["monthly_user"])
        self.monthly_password_var = tk.StringVar(value=config["monthly_password"])
        self.monthly_export_dir_var = tk.StringVar(value=config["monthly_export_dir"])
        self.profile_label_var = tk.StringVar()
        self.status_var = tk.StringVar(value="Ready.")

        self.build_ui()
        self.root.after(150, self.flush_log_queue)

    def build_ui(self):
        # grid row/column weights tell Tkinter which parts should stretch when the
        # window is resized.
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(1, weight=1)

        # The top section contains connection settings plus the main action buttons.
        top = ttk.Frame(self.root, padding=16)
        top.grid(row=0, column=0, sticky="ew")
        top.columnconfigure(1, weight=1)

        ttk.Label(top, text="Server").grid(row=0, column=0, sticky="w", pady=4)
        ttk.Entry(top, textvariable=self.server_var).grid(row=0, column=1, sticky="ew", pady=4)

        ttk.Label(top, text="Endpoint").grid(row=1, column=0, sticky="w", pady=4)
        ttk.Entry(top, textvariable=self.endpoint_var).grid(row=1, column=1, sticky="ew", pady=4)

        ttk.Label(top, text="API Key").grid(row=2, column=0, sticky="w", pady=4)
        ttk.Entry(top, textvariable=self.api_key_var).grid(row=2, column=1, sticky="ew", pady=4)

        ttk.Label(top, text="Folder").grid(row=3, column=0, sticky="w", pady=4)
        folder_frame = ttk.Frame(top)
        folder_frame.grid(row=3, column=1, sticky="ew", pady=4)
        folder_frame.columnconfigure(0, weight=1)
        ttk.Entry(folder_frame, textvariable=self.folder_var).grid(row=0, column=0, sticky="ew")
        ttk.Button(folder_frame, text="Browse", command=self.choose_folder).grid(row=0, column=1, padx=(8, 0))

        profile_frame = ttk.Frame(top)
        profile_frame.grid(row=4, column=0, columnspan=2, sticky="ew", pady=(4, 0))
        profile_frame.columnconfigure(1, weight=1)
        ttk.Label(profile_frame, text="Sync Profile").grid(row=0, column=0, sticky="w")
        self.profile_menu = ttk.Combobox(
            profile_frame,
            textvariable=self.profile_label_var,
            state="readonly",
            values=list(profile_choices().values())
        )
        self.profile_menu.grid(row=0, column=1, sticky="ew", padx=(12, 0))
        self.profile_menu.bind("<<ComboboxSelected>>", self.on_profile_selected)
        self.profile_hint = ttk.Label(profile_frame, text="")
        self.profile_hint.grid(row=1, column=1, sticky="w", padx=(12, 0), pady=(4, 0))

        verifone_frame = ttk.LabelFrame(top, text="Verifone Commander", padding=12)
        verifone_frame.grid(row=5, column=0, columnspan=2, sticky="ew", pady=(12, 0))
        verifone_frame.columnconfigure(1, weight=1)
        ttk.Label(verifone_frame, text="Commander Username").grid(row=0, column=0, sticky="w", pady=4)
        self.verifone_username_entry = ttk.Entry(verifone_frame, textvariable=self.verifone_username_var)
        self.verifone_username_entry.grid(row=0, column=1, sticky="ew", pady=4)
        ttk.Label(verifone_frame, text="Commander Password").grid(row=1, column=0, sticky="w", pady=4)
        self.verifone_password_entry = ttk.Entry(verifone_frame, textvariable=self.verifone_password_var, show="*")
        self.verifone_password_entry.grid(row=1, column=1, sticky="ew", pady=4)
        ttk.Label(verifone_frame, text="RNR.exe Path").grid(row=2, column=0, sticky="w", pady=4)
        self.verifone_rnr_path_entry = ttk.Entry(verifone_frame, textvariable=self.verifone_rnr_path_var)
        self.verifone_rnr_path_entry.grid(row=2, column=1, sticky="ew", pady=4)
        ttk.Label(verifone_frame, text="Commander IP").grid(row=3, column=0, sticky="w", pady=4)
        self.verifone_rnr_ip_entry = ttk.Entry(verifone_frame, textvariable=self.verifone_rnr_ip_var)
        self.verifone_rnr_ip_entry.grid(row=3, column=1, sticky="ew", pady=4)
        ttk.Label(verifone_frame, text="Report Name").grid(row=4, column=0, sticky="w", pady=4)
        self.verifone_rnr_report_entry = ttk.Entry(verifone_frame, textvariable=self.verifone_rnr_report_var)
        self.verifone_rnr_report_entry.grid(row=4, column=1, sticky="ew", pady=4)
        ttk.Label(verifone_frame, text="Export Folder").grid(row=5, column=0, sticky="w", pady=4)
        self.verifone_export_dir_entry = ttk.Entry(verifone_frame, textvariable=self.verifone_export_dir_var)
        self.verifone_export_dir_entry.grid(row=5, column=1, sticky="ew", pady=4)
        ttk.Label(verifone_frame, text="Monthly EXE Path").grid(row=6, column=0, sticky="w", pady=4)
        self.monthly_exe_path_entry = ttk.Entry(verifone_frame, textvariable=self.monthly_exe_path_var)
        self.monthly_exe_path_entry.grid(row=6, column=1, sticky="ew", pady=4)
        ttk.Label(verifone_frame, text="Monthly IP").grid(row=7, column=0, sticky="w", pady=4)
        self.monthly_ip_entry = ttk.Entry(verifone_frame, textvariable=self.monthly_ip_var)
        self.monthly_ip_entry.grid(row=7, column=1, sticky="ew", pady=4)
        ttk.Label(verifone_frame, text="Monthly Report").grid(row=8, column=0, sticky="w", pady=4)
        self.monthly_report_entry = ttk.Entry(verifone_frame, textvariable=self.monthly_report_var)
        self.monthly_report_entry.grid(row=8, column=1, sticky="ew", pady=4)
        ttk.Label(verifone_frame, text="Monthly Username").grid(row=9, column=0, sticky="w", pady=4)
        self.monthly_user_entry = ttk.Entry(verifone_frame, textvariable=self.monthly_user_var)
        self.monthly_user_entry.grid(row=9, column=1, sticky="ew", pady=4)
        ttk.Label(verifone_frame, text="Monthly Password").grid(row=10, column=0, sticky="w", pady=4)
        self.monthly_password_entry = ttk.Entry(verifone_frame, textvariable=self.monthly_password_var, show="*")
        self.monthly_password_entry.grid(row=10, column=1, sticky="ew", pady=4)
        ttk.Label(verifone_frame, text="Monthly Export Folder").grid(row=11, column=0, sticky="w", pady=4)
        self.monthly_export_dir_entry = ttk.Entry(verifone_frame, textvariable=self.monthly_export_dir_var)
        self.monthly_export_dir_entry.grid(row=11, column=1, sticky="ew", pady=4)
        self.verifone_hint = ttk.Label(
            verifone_frame,
            text="These values are only used for Verifone Commander endpoints and can be pulled from the Synchro web API."
        )
        self.verifone_hint.grid(row=12, column=1, sticky="w", pady=(4, 0))

        actions = ttk.Frame(top)
        actions.grid(row=6, column=0, columnspan=2, sticky="ew", pady=(12, 0))
        ttk.Button(actions, text="Save Settings", command=self.save_settings).grid(row=0, column=0, padx=(0, 8))
        ttk.Button(actions, text="Fetch Endpoint Config", command=self.fetch_endpoint_config).grid(row=0, column=1, padx=(0, 8))
        ttk.Button(actions, text="Upload Test File", command=self.upload_test_file).grid(row=0, column=2, padx=(0, 8))
        ttk.Button(actions, text="Sync Folder", command=self.sync_selected_folder).grid(row=0, column=3)
        ttk.Button(actions, text="Run Monthly Test", command=self.run_monthly_test).grid(row=0, column=4, padx=(8, 0))

        log_panel = ttk.Frame(self.root, padding=(16, 0, 16, 16))
        log_panel.grid(row=1, column=0, sticky="nsew")
        log_panel.columnconfigure(0, weight=1)
        log_panel.rowconfigure(1, weight=1)

        ttk.Label(log_panel, text="Activity").grid(row=0, column=0, sticky="w", pady=(0, 8))
        self.log = scrolledtext.ScrolledText(log_panel, wrap="word", height=22, state="disabled")
        self.log.grid(row=1, column=0, sticky="nsew")

        status = ttk.Label(self.root, textvariable=self.status_var, padding=(16, 0, 16, 16))
        status.grid(row=2, column=0, sticky="ew")
        self.refresh_profile_button()

    def choose_folder(self):
        # Ask the operating system for a folder path and copy the result into the form.
        selected = filedialog.askdirectory(initialdir=self.folder_var.get() or pathlib.Path.home())
        if selected:
            self.folder_var.set(selected)

    def save_settings(self):
        # Persist exactly what is on screen so future CLI or GUI runs reuse it.
        env = {
            "SYNCHRO_SERVER": self.server_var.get().strip(),
            "SYNCHRO_ENDPOINT": self.endpoint_var.get().strip(),
            "SYNCHRO_API_KEY": self.api_key_var.get().strip(),
            "SYNCHRO_FOLDER": self.folder_var.get().strip(),
            "SYNCHRO_PROFILE": self.profile_var.get().strip() or "default",
            "SYNCHRO_VERIFONE_USERNAME": self.verifone_username_var.get().strip(),
            "SYNCHRO_VERIFONE_PASSWORD": self.verifone_password_var.get(),
            "SYNCHRO_VERIFONE_RNR_PATH": self.verifone_rnr_path_var.get().strip(),
            "SYNCHRO_VERIFONE_RNR_IP": self.verifone_rnr_ip_var.get().strip(),
            "SYNCHRO_VERIFONE_RNR_REPORT": self.verifone_rnr_report_var.get().strip(),
            "SYNCHRO_VERIFONE_EXPORT_DIR": self.verifone_export_dir_var.get().strip(),
            "SYNCHRO_MONTHLY_EXE_PATH": self.monthly_exe_path_var.get().strip(),
            "SYNCHRO_MONTHLY_IP": self.monthly_ip_var.get().strip(),
            "SYNCHRO_MONTHLY_REPORT": self.monthly_report_var.get().strip(),
            "SYNCHRO_MONTHLY_USER": self.monthly_user_var.get().strip(),
            "SYNCHRO_MONTHLY_PASSWORD": self.monthly_password_var.get(),
            "SYNCHRO_MONTHLY_EXPORT_DIR": self.monthly_export_dir_var.get().strip()
        }
        save_env(env)
        self.write_log(f"Saved settings to {env_path()}")
        self.status_var.set("Settings saved.")

    def fetch_endpoint_config(self):
        if self.is_busy:
            return
        self.run_in_background("Fetching endpoint config...", self._fetch_endpoint_config)

    def upload_test_file(self):
        # The busy guard prevents multiple overlapping network jobs from fighting
        # over the same status area and log window.
        if self.is_busy:
            return
        self.run_in_background("Uploading test file...", self._upload_test_file)

    def sync_selected_folder(self):
        if self.is_busy:
            return
        self.run_in_background("Syncing folder...", self._sync_selected_folder)

    def run_monthly_test(self):
        if self.is_busy:
            return
        self.run_in_background("Running monthly test export...", self._run_monthly_test)

    def _upload_test_file(self):
        # This method runs on a worker thread so the window stays responsive.
        config = self.current_config()
        self.save_settings()
        file_path = ensure_test_file()
        status, payload = upload_file(
            config["server"],
            config["endpoint"],
            config["api_key"],
            file_path
        )
        self.log_queue.put(f"Upload status: {status}")
        self.log_queue.put(payload)
        self.root.after(0, lambda: self.status_var.set(f"Test file upload finished with status {status}."))

    def _sync_selected_folder(self):
        # Syncing many files can take a while, so progress is reported one file at a time.
        config = self.current_config(require_folder=True)
        self.save_settings()

        def progress(item):
            if item.get("skipped"):
                self.log_queue.put(f"SKIP {item['relative_path']} ({item.get('reason', 'unchanged')})")
            else:
                self.log_queue.put(f"{item['status']} {item['relative_path']}")

        results = sync_folder(
            config["server"],
            config["endpoint"],
            config["api_key"],
            config["folder"],
            progress_callback=progress,
            profile=config["profile"],
            verifone_username=config["verifone_username"],
            verifone_password=config["verifone_password"],
            verifone_rnr_path=config["verifone_rnr_path"],
            verifone_rnr_ip=config["verifone_rnr_ip"],
            verifone_rnr_report=config["verifone_rnr_report"],
            verifone_export_dir=config["verifone_export_dir"],
            monthly_exe_path=config["monthly_exe_path"],
            monthly_ip=config["monthly_ip"],
            monthly_report=config["monthly_report"],
            monthly_user=config["monthly_user"],
            monthly_password=config["monthly_password"],
            monthly_export_dir=config["monthly_export_dir"],
            status_callback=self.log_queue.put
        )
        success_count = sum(1 for item in results if 200 <= item["status"] < 300)
        skipped_count = sum(1 for item in results if item.get("skipped"))
        self.log_queue.put(f"Profile: {config['profile']}")
        self.root.after(
            0,
            lambda: self.status_var.set(
                f"Uploaded {success_count}, skipped {skipped_count} unchanged, matched {len(results)} files."
            )
        )

    def _run_monthly_test(self):
        config = self.current_config()
        self.save_settings()
        export_path = run_monthly_verifone_export(
            monthly_exe_path=config["monthly_exe_path"],
            monthly_ip=config["monthly_ip"],
            monthly_report=config["monthly_report"],
            monthly_user=config["monthly_user"],
            monthly_password=config["monthly_password"],
            monthly_export_dir=config["monthly_export_dir"],
            status_callback=self.log_queue.put,
            label="Monthly test"
        )
        self.log_queue.put(f"Monthly test output: {export_path}")
        self.root.after(0, lambda: self.status_var.set("Monthly test export completed."))

    def _fetch_endpoint_config(self):
        server = self.server_var.get().strip()
        endpoint = self.endpoint_var.get().strip()
        api_key = self.api_key_var.get().strip()
        if not endpoint or not api_key:
            raise SystemExit("Enter an endpoint and API key before fetching remote config.")

        remote = fetch_companion_config(server, endpoint, api_key)
        self.root.after(0, lambda: self._apply_remote_config(remote))

    def run_in_background(self, busy_message, target):
        # Tkinter is single-threaded: long-running work must leave the main thread
        # quickly or the entire window appears frozen.
        self.is_busy = True
        self.status_var.set(busy_message)

        def worker():
            try:
                target()
            except SystemExit as error:
                self.log_queue.put(f"Error: {error}")
                self.root.after(0, lambda: messagebox.showerror("SynchroCommander", str(error)))
                self.root.after(0, lambda: self.status_var.set("Action failed."))
            except Exception as error:  # pragma: no cover - GUI safety net
                self.log_queue.put(f"Unexpected error: {error}")
                self.root.after(0, lambda: messagebox.showerror("SynchroCommander", str(error)))
                self.root.after(0, lambda: self.status_var.set("Action failed."))
            finally:
                self.root.after(0, self._mark_idle)

        threading.Thread(target=worker, daemon=True).start()

    def _mark_idle(self):
        # Centralizing this reset makes it easier to keep busy-state handling consistent.
        self.is_busy = False

    def current_config(self, require_folder=False):
        # Reuse the same validation rules as the command-line tool, but do not save
        # automatically here because the caller decides when persistence should happen.
        config = resolve_config(
            server=self.server_var.get().strip(),
            endpoint=self.endpoint_var.get().strip(),
            api_key=self.api_key_var.get().strip(),
            folder=self.folder_var.get().strip(),
            profile=self.profile_var.get().strip() or "default",
            verifone_username=self.verifone_username_var.get().strip(),
            verifone_password=self.verifone_password_var.get(),
            verifone_rnr_path=self.verifone_rnr_path_var.get().strip(),
            verifone_rnr_ip=self.verifone_rnr_ip_var.get().strip(),
            verifone_rnr_report=self.verifone_rnr_report_var.get().strip(),
            verifone_export_dir=self.verifone_export_dir_var.get().strip(),
            monthly_exe_path=self.monthly_exe_path_var.get().strip(),
            monthly_ip=self.monthly_ip_var.get().strip(),
            monthly_report=self.monthly_report_var.get().strip(),
            monthly_user=self.monthly_user_var.get().strip(),
            monthly_password=self.monthly_password_var.get(),
            monthly_export_dir=self.monthly_export_dir_var.get().strip(),
            persist=False,
            require_credentials=True
        )
        if require_folder and not config["folder"]:
            raise SystemExit("Choose a folder before syncing.")
        return config

    def on_profile_selected(self, _event=None):
        # The drop-down shows friendly labels, so convert the chosen label back into the stored profile ID.
        selected_label = self.profile_label_var.get()
        next_profile = "default"
        for profile_id, label in profile_choices().items():
            if label == selected_label:
                next_profile = profile_id
                break
        self.profile_var.set(next_profile)
        self.refresh_profile_button()
        self.write_log(f"Profile set to {profile_label(next_profile)}: {profile_description(next_profile)}")
        self.status_var.set("Sync profile updated.")

    def refresh_profile_button(self):
        # Show the active profile in both human-friendly and machine-friendly forms.
        current_profile = self.profile_var.get() or "default"
        self.profile_label_var.set(profile_label(current_profile))
        self.profile_hint.configure(text=profile_description(current_profile))
        verifone_state = "normal" if current_profile == "verifone_commander" else "disabled"
        self.verifone_username_entry.configure(state=verifone_state)
        self.verifone_password_entry.configure(state=verifone_state)
        self.verifone_rnr_path_entry.configure(state=verifone_state)
        self.verifone_rnr_ip_entry.configure(state=verifone_state)
        self.verifone_rnr_report_entry.configure(state=verifone_state)
        self.verifone_export_dir_entry.configure(state=verifone_state)
        self.monthly_exe_path_entry.configure(state=verifone_state)
        self.monthly_ip_entry.configure(state=verifone_state)
        self.monthly_report_entry.configure(state=verifone_state)
        self.monthly_user_entry.configure(state=verifone_state)
        self.monthly_password_entry.configure(state=verifone_state)
        self.monthly_export_dir_entry.configure(state=verifone_state)
        if current_profile == "verifone_commander":
            self.verifone_hint.configure(
                text="These values will be passed through SynchroCommander for Verifone Commander automation."
            )
        else:
            self.verifone_hint.configure(
                text="Stored for later use, but only active when the sync profile is Verifone Commander."
            )

    def _apply_remote_config(self, remote):
        self.profile_var.set(remote["profile"] or "default")
        self.verifone_username_var.set(remote["verifone_username"])
        self.verifone_password_var.set(remote["verifone_password"])
        self.refresh_profile_button()
        self.save_settings()
        payment_system = remote.get("payment_system") or "unknown"
        self.write_log(
            f"Fetched endpoint config for {remote['endpoint']} ({payment_system}); profile set to {profile_label(self.profile_var.get())}."
        )
        if self.profile_var.get() == "verifone_commander":
            self.write_log("Applied Verifone Commander username/password from the Synchro web API.")
        self.status_var.set("Endpoint config fetched.")

    def write_log(self, message):
        # The text widget is normally read-only; we briefly enable it to append a line.
        self.log.configure(state="normal")
        self.log.insert("end", f"{message}\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def flush_log_queue(self):
        # Poll the queue on a timer so worker threads never touch Tkinter widgets directly.
        while True:
            try:
                message = self.log_queue.get_nowait()
            except queue.Empty:
                break
            self.write_log(message)
        self.root.after(150, self.flush_log_queue)


def main():
    # The same file supports both interactive GUI mode and scheduled headless mode.
    args = parse_args()
    if args.scheduled:
        raise SystemExit(run_scheduled_sync())

    root = tk.Tk()
    style = ttk.Style(root)
    if "vista" in style.theme_names():
        style.theme_use("vista")
    SynchroCommanderApp(root)
    root.mainloop()


def parse_args():
    # The GUI only needs one switch because almost everything else is entered in the window.
    parser = argparse.ArgumentParser(
        description="SynchroCommander GUI and scheduled sync runner."
    )
    parser.add_argument(
        "--scheduled",
        action="store_true",
        help="Run a headless sync using the saved commander.env settings and then exit."
    )
    return parser.parse_args()


def run_scheduled_sync():
    # This path is designed for Windows Task Scheduler or similar automation tools.
    try:
        append_scheduled_log("------------------------------------------------------------")
        append_scheduled_log("Scheduled sync starting.")
        append_scheduled_log(f"Working directory: {pathlib.Path.cwd()}")
        append_scheduled_log(f"Config file: {env_path()}")
        append_scheduled_log(f"Log file: {scheduled_log_path()}")
        config = resolve_config(
            persist=False,
            require_credentials=True
        )
        if not config["folder"]:
            append_scheduled_log("Scheduled sync failed: SYNCHRO_FOLDER is not configured.")
            print("Scheduled sync failed: SYNCHRO_FOLDER is not configured.", file=sys.stderr)
            return 1

        append_scheduled_log(f"Server: {config['server']}")
        append_scheduled_log(f"Endpoint: {config['endpoint']}")
        append_scheduled_log(f"Folder: {config['folder']}")
        append_scheduled_log(f"Profile: {profile_label(config['profile'])} ({config['profile']})")
        print(f"Scheduled sync starting for {config['folder']}")
        print(f"Profile: {config['profile']}")
        results = sync_folder(
            config["server"],
            config["endpoint"],
            config["api_key"],
            config["folder"],
            profile=config["profile"],
            verifone_username=config["verifone_username"],
            verifone_password=config["verifone_password"],
            verifone_rnr_path=config["verifone_rnr_path"],
            verifone_rnr_ip=config["verifone_rnr_ip"],
            verifone_rnr_report=config["verifone_rnr_report"],
            verifone_export_dir=config["verifone_export_dir"],
            monthly_exe_path=config["monthly_exe_path"],
            monthly_ip=config["monthly_ip"],
            monthly_report=config["monthly_report"],
            monthly_user=config["monthly_user"],
            monthly_password=config["monthly_password"],
            monthly_export_dir=config["monthly_export_dir"],
            status_callback=append_scheduled_log
        )
        ok_count = sum(1 for item in results if 200 <= item["status"] < 300)
        skipped_count = sum(1 for item in results if item.get("skipped"))
        failure_count = sum(1 for item in results if not item.get("skipped") and not (200 <= item["status"] < 300))
        append_scheduled_log(f"Matched files: {len(results)}")
        print(
            f"Scheduled sync finished: uploaded {ok_count}, skipped {skipped_count} unchanged, "
            f"matched {len(results)} files."
        )
        append_scheduled_log(
            f"Scheduled sync finished: uploaded {ok_count}, skipped {skipped_count} unchanged, "
            f"matched {len(results)} files."
        )
        for item in results:
            if item.get("skipped"):
                append_scheduled_log(f"SKIP {item['relative_path']} ({item.get('reason', 'unchanged')})")
                print(f"SKIP {item['relative_path']} ({item.get('reason', 'unchanged')})")
                continue

            append_scheduled_log(f"{item['status']} {item['relative_path']}")
            print(f"{item['status']} {item['relative_path']}")
            if not (200 <= item["status"] < 300):
                append_scheduled_log(f"Response: {item['payload']}")
                print(item["payload"], file=sys.stderr)
        return 0 if failure_count == 0 else 2
    except SystemExit as error:
        append_scheduled_log(f"Scheduled sync failed: {error}")
        print(f"Scheduled sync failed: {error}", file=sys.stderr)
        return 1
    except Exception as error:  # pragma: no cover - CLI safety net
        append_scheduled_log(f"Scheduled sync failed unexpectedly: {error}")
        print(f"Scheduled sync failed unexpectedly: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    main()
