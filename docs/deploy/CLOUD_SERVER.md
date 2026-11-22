# Deploy Converge on a cloud server

This puts Converge on one internet-facing server with HTTPS, so your team only needs a link. Teammates use a
browser or the desktop app; nobody but the server needs Docker.

The steps assume a fresh **Ubuntu 24.04 LTS** server from any provider and a domain name you control.
`converge.example.com` stands for your domain throughout.

## 1. What you need

- **A server** with at least 2 vCPUs, 4 GB of memory and 30 GB of disk. The API runs on Java and every agent
  turn and test run uses memory, so give a busy team more.
- **A domain name** with an `A` record pointing at the server's public IP address. HTTPS certificates are only
  issued for a name that already points at the server.
- **SSH access** to the server as a user with `sudo`.

## 2. Install Docker

Follow Docker's own instructions for Ubuntu, which install Docker Engine and the Compose plugin:
<https://docs.docker.com/engine/install/ubuntu/>. Then check both are there:

```bash
docker --version
docker compose version
```

## 3. Open only SSH and the web ports

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Docker publishes container ports past `ufw`. That is why step 5 uses a production file that publishes nothing
except nginx on `127.0.0.1`. Do not start the stack without it on a public server: the plain Compose file
publishes PostgreSQL and Redis for local development.

## 4. Get the code and set your secrets

```bash
sudo git clone https://github.com/Sarthak-47/Converge.git /opt/converge
sudo chown -R "$USER" /opt/converge
cd /opt/converge
cp .env.example .env
```

Generate fresh secrets:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
echo "INTERNAL_TOKEN=$(openssl rand -hex 32)"
echo "SECRETS_KEY=$(openssl rand -base64 32)"
```

Edit `.env` (for example with `nano .env`) and set:

| Setting | Value |
|---|---|
| `POSTGRES_PASSWORD` | the generated value |
| `INTERNAL_TOKEN` | the generated value |
| `SECRETS_KEY` | the generated value |
| `PUBLIC_ORIGIN` | `https://converge.example.com`, exactly as people will type it, with no trailing slash |
| `AGENT_MODEL_URL` | leave empty, so agents call the real model providers |

Keep a copy of `SECRETS_KEY` somewhere safe outside the server. It encrypts members' API keys and Git
credentials; without it, those cannot be read again and every member has to enter their keys anew.

Optional settings, all described in the [README](../../README.md#agents): `AGENT_MODELS`,
`AGENT_CUSTOM_MODELS` and `AGENT_MODEL_PRICES` for which models members may use and what they cost.

## 5. Start Converge

```bash
docker compose -f compose.yaml -f infra/compose.production.yaml up -d --build
```

The first build takes several minutes. [`infra/compose.production.yaml`](../../infra/compose.production.yaml)
publishes only nginx, on `127.0.0.1:8000`, sends the session cookie over HTTPS only, and restarts every
service when the server reboots.

Check that it is up:

```bash
curl -s http://127.0.0.1:8000/api/actuator/health
```

It should report `"status":"UP"`.

## 6. Add HTTPS with Caddy

Caddy gets and renews a certificate by itself. Install it from <https://caddyserver.com/docs/install>
(the "Debian, Ubuntu, Raspbian" section), then replace `/etc/caddy/Caddyfile` with:

```
converge.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

and reload it:

```bash
sudo systemctl reload caddy
```

Open `https://converge.example.com`, create the first account, and create a workspace. Live editing,
chat and agents all run through this one address.

## 7. Invite your team

- **Browser:** send people the link. They create an account, and you add them to a workspace under
  **Members**.
- **Desktop app:** it opens whichever server `CONVERGE_URL` names, for example
  `CONVERGE_URL=https://converge.example.com`.
- **Agents:** each member saves their own Anthropic, OpenAI, Gemini or OpenRouter key in the Sessions panel.
  The server needs no key of its own.

## 8. Update to a new version

```bash
cd /opt/converge
git pull
docker compose -f compose.yaml -f infra/compose.production.yaml up -d --build
```

Database changes are applied automatically when the API starts.

## 9. Back up

Everything people create is in PostgreSQL; Git checkouts are in the `git-data` volume and can be recreated
from the remotes. A nightly database dump is enough to restore a server:

```bash
cd /opt/converge
docker compose exec -T postgres pg_dump -U converge converge | gzip > ~/converge-$(date +%F).sql.gz
```

Copy the dumps off the server, and keep `.env` (above all `SECRETS_KEY`) with them.

## 10. Before strangers can run commands

Approved test commands run in throwaway containers with no network, limited memory and a time limit. The
executor that starts them holds the Docker socket, which is equivalent to root on the server. That is fine for
a team that trusts each other. Before people you do not trust can get commands approved, run the sandboxes
under gVisor: install it (<https://gvisor.dev/docs/user_guide/install/>) and add `SANDBOX_RUNTIME=runsc`
to `.env`.

## Troubleshooting

- **The page loads but nothing is live** (no cursors, chat or agent progress): `PUBLIC_ORIGIN` does not match
  the address in the browser. It must be the exact `https://` address. Fix `.env` and run the `up` command in
  step 5 again.
- **Signing in does not stick:** the site is being opened over plain `http://`. The production file only sends
  the session cookie over HTTPS, so always use the `https://` address.
- **Logs:** `docker compose logs --tail=100 api` (or `collab`, `agent-runner`, `executor`, `nginx`).
- **More instances** for a bigger team: see "Scaling out" in the [README](../../README.md).
