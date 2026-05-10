import argparse

from sync_client import ensure_test_file, resolve_config, sync_folder, upload_file


def parse_args():
    # argparse builds a friendly command-line interface and also generates --help output.
    parser = argparse.ArgumentParser(
        description="Upload a test file or sync a folder to a Synchro endpoint."
    )
    parser.add_argument("--server", help="Server base URL, e.g. http://localhost:3000")
    parser.add_argument("--endpoint", help="Endpoint slug, e.g. warehouse-laptop")
    parser.add_argument("--key", help="API key for the endpoint")
    parser.add_argument("--folder", help="Folder to sync recursively")
    profile_group = parser.add_mutually_exclusive_group()
    profile_group.add_argument(
        "--verifone-commander",
        action="store_true",
        help="Only sync HTML files while preserving their folder structure."
    )
    profile_group.add_argument(
        "--gilbarco-storeclose",
        action="store_true",
        help="Only sync PDF files whose names start with StoreClose."
    )
    return parser.parse_args()


def main():
    # Step 1: combine command-line options with any values previously saved in .env.
    args = parse_args()
    config = resolve_config(
        server=args.server,
        endpoint=args.endpoint,
        api_key=args.key,
        folder=args.folder,
        profile=(
            "verifone_commander" if args.verifone_commander
            else "gilbarco_storeclose" if args.gilbarco_storeclose
            else None
        )
    )

    # If a folder is configured, treat this run as a bulk sync job.
    if config["folder"]:
        results = sync_folder(
            config["server"],
            config["endpoint"],
            config["api_key"],
            config["folder"],
            profile=config["profile"]
        )
        ok_count = sum(1 for item in results if 200 <= item["status"] < 300)
        print(f"Synced {ok_count}/{len(results)} files from {config['folder']}")
        print(f"Profile: {config['profile']}")
        for item in results:
            print(f"{item['status']} {item['relative_path']}")
        return

    # Otherwise create a tiny test file and upload just that single file.
    test_file = ensure_test_file()
    status, payload = upload_file(
        config["server"],
        config["endpoint"],
        config["api_key"],
        test_file
    )
    print(f"Upload status: {status}")
    print(payload)


if __name__ == "__main__":
    main()
