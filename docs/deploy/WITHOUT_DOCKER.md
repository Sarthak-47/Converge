# Run Converge without Docker

Converge normally runs with Docker Compose (see the [README](../../README.md) and the
[cloud server guide](CLOUD_SERVER.md)). This guide runs every service directly on a Linux server instead,
for machines where Docker is not available or not allowed.

Only the person hosting Converge follows this. Teammates just open the link in a browser or the desktop app.

## What works without Docker

| Feature | Without Docker |
|---|---|
| Live editing, cursors, chat, presence | Works |
| Version history, comments, recently deleted files | Works |
| Agents (Anthropic, OpenAI, Gemini or OpenRouter keys) | Works |
| Sessions, plans, takeovers, approvals | Works |
| Git: connect a repository, import, push, pull requests | Works |
| **Running approved commands, such as tests** | **Switched off.** These run inside throwaway sandbox containers, which need Docker. An approved command fails with "Running commands is switched off on this server (it runs without Docker)." |

The steps assume **Ubuntu 24.04 LTS**. Other Linux distributions work the same way with their own package
commands. Windows and macOS can run every component too, but that setup is untested.

## 1. Install the prerequisites

| Component | Version Converge is tested with | Where to get it |
|---|---|---|
| Java (JDK) | 21 | `sudo apt install openjdk-21-jdk` |
| Maven | 3.9 | `sudo apt install maven`, or <https://maven.apache.org/download.cgi> |
| Node.js | 24 | <https://nodejs.org/en/download> |
| PostgreSQL | 18 | <https://www.postgresql.org/download/linux/ubuntu/> |
| Redis | 8 | <https://redis.io/docs/latest/operate/oss_and_stack/install/install-stack/apt/> |
| nginx | any current | `sudo apt install nginx` |
| Git | any current | `sudo apt install git` |
| OpenSSL | any | preinstalled; used to generate secrets |

## 2. Create the database

```bash
DB_PASSWORD=$(openssl rand -hex 24)
echo "Database password: $DB_PASSWORD"
sudo -u postgres psql -c "create user converge with password '$DB_PASSWORD';"
sudo -u postgres psql -c "create database converge owner converge;"
```

The API creates every table itself when it first starts.

## 3. Build Converge

```bash
sudo git clone https://github.com/Sarthak-47/Converge.git /opt/converge
sudo chown -R "$USER" /opt/converge
cd /opt/converge

# The desktop app's Electron download is not needed on a server.
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build --workspace @converge/web
npm run build --workspace @converge/collab
npm run build --workspace @converge/agent-runner
npm run build --workspace @converge/executor
(cd apps/api && mvn -B package -DskipTests)
```

This produces the web app in `apps/web/dist`, the three Node services in `apps/*/dist`, and the API as
`apps/api/target/converge-api-*.jar`.

## 4. Configure the services

Generate the shared secrets once:

```bash
echo "INTERNAL_TOKEN=$(openssl rand -hex 32)"
echo "SECRETS_KEY=$(openssl rand -base64 32)"
```

Keep `SECRETS_KEY` safe outside the server: it encrypts members' API keys and Git credentials, and without
it they cannot be read again.

Each service reads its settings from the environment. The API and the Node services spell the database
address differently, so each gets its own file. Create `/etc/converge/` and the files below, replacing
`DB_PASSWORD`, `INTERNAL_TOKEN`, `SECRETS_KEY` and the domain with your values. `PUBLIC_ORIGIN` must be the
exact address people open, for example `https://converge.example.com`.

`/etc/converge/api.env`:

```
SERVER_ADDRESS=127.0.0.1
DATABASE_URL=jdbc:postgresql://127.0.0.1:5432/converge
DATABASE_USER=converge
DATABASE_PASSWORD=DB_PASSWORD
REDIS_HOST=127.0.0.1
COLLAB_URL=http://127.0.0.1:1234
AGENT_RUNNER_URL=http://127.0.0.1:4100
AGENT_RUNNER_LEASES=true
INTERNAL_TOKEN=INTERNAL_TOKEN
SECRETS_KEY=SECRETS_KEY
COOKIE_SECURE=true
CONVERGE_WEBSOCKET_ALLOWED_ORIGINS=https://converge.example.com
```

`/etc/converge/collab.env`:

```
DATABASE_URL=postgres://converge:DB_PASSWORD@127.0.0.1:5432/converge
REDIS_URL=redis://127.0.0.1:6379
API_URL=http://127.0.0.1:8080
INTERNAL_TOKEN=INTERNAL_TOKEN
COLLAB_ALLOWED_ORIGINS=https://converge.example.com
```

`/etc/converge/agent-runner.env`:

```
API_URL=http://127.0.0.1:8080
COLLAB_WS_URL=ws://127.0.0.1:1234
COLLAB_ORIGIN=https://converge.example.com
INTERNAL_TOKEN=INTERNAL_TOKEN
REDIS_URL=redis://127.0.0.1:6379
```

`/etc/converge/executor.env`:

```
SANDBOX=off
DATABASE_URL=postgres://converge:DB_PASSWORD@127.0.0.1:5432/converge
API_URL=http://127.0.0.1:8080
INTERNAL_TOKEN=INTERNAL_TOKEN
SECRETS_KEY=SECRETS_KEY
GIT_ROOT=/var/lib/converge/git
```

Protect them, since they hold secrets:

```bash
sudo chmod 600 /etc/converge/*.env
```

Optional agent settings (`AGENT_MODELS`, `AGENT_CUSTOM_MODELS` in `api.env`; `AGENT_MODEL_PRICES` in
`agent-runner.env`) are described in the [README](../../README.md#agents).

## 5. Run the services with systemd

Create a system user that owns the Git checkouts:

```bash
sudo useradd --system --home /var/lib/converge --create-home converge
sudo mkdir -p /var/lib/converge/git && sudo chown -R converge /var/lib/converge
```

Create one unit per service. `/etc/systemd/system/converge-api.service`:

```ini
[Unit]
Description=Converge API
After=network-online.target postgresql.service redis-server.service converge-collab.service

[Service]
User=converge
EnvironmentFile=/etc/converge/api.env
WorkingDirectory=/opt/converge/apps/api
ExecStart=/bin/sh -c 'exec java -jar /opt/converge/apps/api/target/converge-api-*.jar'
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

The three Node services follow the same pattern. Change the description, the env file, `WorkingDirectory`
and `ExecStart`:

| Unit file | `EnvironmentFile` | `WorkingDirectory` | `ExecStart` |
|---|---|---|---|
| `converge-collab.service` | `collab.env` | `/opt/converge/apps/collab` | `/usr/bin/node dist/server.js` |
| `converge-agent-runner.service` | `agent-runner.env` | `/opt/converge/apps/agent-runner` | `/usr/bin/node dist/server.js` |
| `converge-executor.service` | `executor.env` | `/opt/converge/apps/executor` | `/usr/bin/node dist/main.js` |

Use the path `which node` prints if Node is installed elsewhere. Then start everything:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now converge-collab converge-api converge-agent-runner converge-executor
```

The collaboration service waits for the API's database tables, and the executor waits for them too, so the
order they start in does not matter.

## 6. Serve the app with nginx

nginx serves the web app and puts the API and the live sockets on one address. Start from the
repository's own configuration and point it at this machine:

```bash
sed -e 's#http://api:8080#http://127.0.0.1:8080#g' \
    -e 's#http://collab:1234/#http://127.0.0.1:1234/#' \
    -e 's#root /usr/share/nginx/html;#root /opt/converge/apps/web/dist;#' \
    -e 's#listen 80;#listen 80;\n    server_name converge.example.com;#' \
    infra/nginx/nginx.conf | sudo tee /etc/nginx/sites-available/converge > /dev/null
sudo ln -s /etc/nginx/sites-available/converge /etc/nginx/sites-enabled/converge
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Make sure the `converge` and `www-data` users can read `/opt/converge/apps/web/dist`.

## 7. Add HTTPS and close the other ports

Get a certificate with Certbot (<https://certbot.eff.org/>, choose nginx and Ubuntu):

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d converge.example.com
```

Allow only SSH and the web from outside. Every service above listens on `127.0.0.1` or is closed by this:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Open `https://converge.example.com`, create the first account and a workspace.

## 8. Update to a new version

```bash
cd /opt/converge
git pull
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build --workspace @converge/web
npm run build --workspace @converge/collab
npm run build --workspace @converge/agent-runner
npm run build --workspace @converge/executor
(cd apps/api && mvn -B package -DskipTests)
sudo systemctl restart converge-collab converge-api converge-agent-runner converge-executor
```

Database changes are applied automatically when the API starts.

## 9. Back up

```bash
sudo -u postgres pg_dump converge | gzip > ~/converge-$(date +%F).sql.gz
```

Keep the dumps and `/etc/converge/` (above all `SECRETS_KEY`) somewhere off the server.

## Troubleshooting

- **Health:** `curl -s http://127.0.0.1:8080/api/actuator/health` should report `"status":"UP"`, including
  the database, Redis and the collaboration service.
- **Logs:** `journalctl -u converge-api -n 100` (or `converge-collab`, `converge-agent-runner`,
  `converge-executor`).
- **The page loads but nothing is live:** `CONVERGE_WEBSOCKET_ALLOWED_ORIGINS`, `COLLAB_ALLOWED_ORIGINS` and
  `COLLAB_ORIGIN` must all be the exact `https://` address in the browser.
- **Signing in does not stick:** `COOKIE_SECURE=true` sends the session cookie over HTTPS only; open the
  `https://` address, or set it to `false` while testing over plain HTTP.
- **Turning commands on later:** install Docker, remove `SANDBOX=off` from `executor.env`, run the executor as
  a user that can reach the Docker socket, and restart it.
