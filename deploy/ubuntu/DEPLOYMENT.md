# Ubuntu deployment

This Ubuntu setup is for the Synchro server only.
The Windows companion apps are not deployed to Ubuntu and are not needed on the server.

The server deploys cleanly on a standard Ubuntu host as:

- `nginx` in front on port `80` or `443`
- `systemd` managing the Node service
- a local Python virtualenv only for the server-side PDF parser
- SQLite stored on disk inside the app directory

## What this app needs

- Ubuntu 22.04 or 24.04
- Node.js 20+
- Python 3 with `venv`
- `pdfplumber` installed in the app virtualenv
- write access to `data/`, `storage/`, and `logs/`
- no `companion/` or `companion_commander/` runtime on the server

## Files in this folder

- `install-server.sh`: first-time server bootstrap
- `update-app.sh`: redeploy updated code onto an existing server
- `synchro.service`: `systemd` unit template
- `nginx.synchro.conf`: nginx reverse proxy template
- `env.production.example`: production env template

## First-time install

Fast path: one command from a fresh Ubuntu box:

```bash
curl -fsSL https://raw.githubusercontent.com/Eternal-Hotels/synchro/main/deploy/ubuntu/install-server.sh | sudo bash
```

That clones `https://github.com/Eternal-Hotels/synchro.git` into `/opt/synchro` as the `synchro` user and configures nginx for `reports.gascofuel.com` by default.

You can also install in either of these ways.

1. Direct git clone into `/opt/synchro` as the `synchro` user:

```bash
sudo APP_DIR=/opt/synchro \
  APP_USER=synchro \
  bash deploy/ubuntu/install-server.sh
```

Optional:

- Set `APP_GIT_REF=branch-name`, `tag-name`, or a commit to install a specific revision.
- Set `APP_GIT_URL=` to a different repo if you ever need to override the default GitHub source.
- Set `DOMAIN_NAME=` only if you ever need to override `reports.gascofuel.com`.

2. Run from an existing checked-out repo on the server:

```bash
cd /path/to/checked-out/synchro
sudo APP_DIR=/opt/synchro \
  APP_USER=synchro \
  DOMAIN_NAME=example.com \
  bash deploy/ubuntu/install-server.sh
```

If `APP_REPO_SOURCE` points at a git checkout, the installer clones that repo into `/opt/synchro` as `synchro` and then `chown`s the whole app directory. If the source folder is not a git repo, the installer falls back to the old file-sync behavior.

3. Edit `/opt/synchro/.env`.
4. Start the app:

```bash
sudo systemctl enable --now synchro
```

5. Reload nginx:

```bash
sudo systemctl reload nginx
```

## HTTPS

The service is configured for `NODE_ENV=production`, which makes the login cookie `Secure`.
That means browser logins work correctly once nginx is serving HTTPS.

A common follow-up is:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d example.com
```

## Updating the app

If `/opt/synchro` is a git checkout, update it directly in place:

```bash
sudo -u synchro git -C /opt/synchro pull --ff-only
sudo -u synchro npm --prefix /opt/synchro ci --omit=dev
sudo -u synchro /opt/synchro/.venv/bin/pip install -r /opt/synchro/requirements-server.txt
sudo systemctl restart synchro
```

If you installed from a non-git source and still want the older copy-based flow, pull or copy new code onto the server and run:

```bash
cd /path/to/checked-out/synchro
sudo APP_DIR=/opt/synchro \
  APP_USER=synchro \
  bash deploy/ubuntu/update-app.sh
```

## Useful checks

```bash
sudo systemctl status synchro
sudo journalctl -u synchro -f
sudo nginx -t
curl -I http://127.0.0.1:3000/
sqlite3 /opt/synchro/data/synchro.sqlite ".tables"
```

## App-specific notes

- The app listens on `127.0.0.1:3000` behind nginx by default.
- Uploaded files are stored under `/opt/synchro/storage`.
- The SQLite database lives at `/opt/synchro/data/synchro.sqlite`.
- The PDF parser is invoked from Node and uses `SYNCHRO_PYTHON_BIN=/opt/synchro/.venv/bin/python`.
- Report-digest email features require valid `SYNCHRO_GRAPH_TENANT_ID`, `SYNCHRO_GRAPH_CLIENT_ID`, and `SYNCHRO_GRAPH_CLIENT_SECRET`.
- On first startup, if the database is empty, the server creates the bootstrap admin user from `.env` or generates a password and prints it to the service logs.

## Recommended deployment flow

1. Install with `install-server.sh`.
2. Fill in `/opt/synchro/.env`.
3. Start `synchro.service`.
4. Confirm the bootstrap login works through nginx.
5. Add HTTPS with Certbot.
6. Rotate the bootstrap password after first login if you set a temporary one.
