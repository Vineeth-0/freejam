# Deploying the FreeJam relay publicly

You need this only for **sync mode** when participants are not on the same
network and you do not want to use a VPN. The relay must be reachable over the
internet with **TLS**, so the extension uses a `wss://` URL.

The relay is one file with no dependencies. It reads `PORT` (default `8787`)
and `HOST` (default `0.0.0.0`) from the environment and exposes `/health`.

There are three practical options.

### Quick setup on Windows

FreeJam does not silently start a relay. The host chooses and runs one, which
keeps relay ownership clear: each person can run their own relay, and session
join codes point guests to that host's chosen relay. For a private same-Wi-Fi
session, run `node freejam-relay.js` in this folder and use the `ws://` LAN
address it prints. For friends outside your network, follow Option 2 below;
the Cloudflare quick tunnel URL is temporary and must stay running alongside
the relay. Paste the resulting `wss://` URL into **Playback sync → Host a sync
session**. The same relay address is used for friends features.

---

## Option 1 — Render (free, stable URL)

Render gives you a permanent `https://<name>.onrender.com` address that also
speaks `wss://`. This folder already contains `package.json` and `render.yaml`.

1. Create a GitHub repository containing:
   - `freejam-relay.js`
   - `package.json`
   - `render.yaml` (optional but convenient)
2. Sign in at <https://render.com>.
3. **New → Web Service**, connect the repository.
4. Settings:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/health`
   - Plan: **Free**
5. Deploy. When it is live, Render shows something like
   `https://your-service.onrender.com`.
6. In FreeJam use:
   ```
   wss://your-service.onrender.com
   ```

Notes:

- Free Render services sleep after a period without traffic. The first
  connection after sleeping can take ~30–60 seconds. FreeJam retries with
  backoff, so it will connect once the service wakes. An open WebSocket keeps
  the service awake during a session.
- No environment variables are required; Render provides `PORT`.

`render.yaml` also lets you use **New → Blueprint** and skip the manual
settings.

---

## Option 2 — Cloudflare Quick Tunnel (no account, instant, temporary URL)

This runs the relay on your own machine but exposes it through Cloudflare, so
your friend can reach it from any network. The URL changes every time you
restart the tunnel.

1. Install `cloudflared`:
   ```powershell
   winget install --id Cloudflare.cloudflared
   ```
   (macOS: `brew install cloudflared`; Linux: see Cloudflare docs.)
2. Start the relay:
   ```powershell
   node freejam-relay.js
   ```
3. In a second terminal, start the tunnel:
   ```powershell
   cloudflared tunnel --url http://localhost:8787
   ```
4. Cloudflare prints a URL such as:
   ```
   https://random-words-here.trycloudflare.com
   ```
5. In FreeJam use the same host with `wss://`:
   ```
   wss://random-words-here.trycloudflare.com
   ```
6. Keep **both** the relay and `cloudflared` running while you listen.

Notes:

- The host's machine must stay on and online.
- The URL is new each time you start `cloudflared`. Send the new join code
  after restarting.
- No Cloudflare account is required for a quick tunnel.

---

## Option 3 — Any VPS with a domain (most reliable)

If you already have a server:

1. Copy `freejam-relay.js` and `package.json` to the server.
2. Run it behind a TLS reverse proxy. Example Caddy config:
   ```
   relay.example.com {
       reverse_proxy 127.0.0.1:8787
   }
   ```
3. Use `wss://relay.example.com` in FreeJam.

Caddy obtains and renews the certificate automatically. WebSocket upgrades are
proxied by default.

---

## Option 4 — Raspberry Pi or home server (24/7)

A Raspberry Pi 5 is an excellent host for the relay. See **`PI-SETUP.md`** for
the full walkthrough, including:

- installing Node.js on ARM64
- a `systemd` unit that starts the relay on boot
- Cloudflare Tunnel (quick or named) so guests can connect from any network
- a second `systemd` unit for the tunnel
- troubleshooting and security notes

The short version:

```bash
# On the Pi
mkdir -p ~/freejam
# copy freejam-relay.js there, then:
sudo cp freejam-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now freejam-relay

# Cloudflare Tunnel in front (quick tunnel example)
cloudflared tunnel --url http://127.0.0.1:8787
```

Use the resulting `wss://...trycloudflare.com` URL in FreeJam. For a stable URL,
use a named Cloudflare Tunnel with your own domain.

---

## Docker

A `Dockerfile` is included:

```bash
docker build -t freejam-relay .
docker run -p 8787:8787 freejam-relay
```

Put it behind a TLS terminator (Caddy, nginx, Cloudflare) before using it over
the internet.

---

## Security

- The relay does not store playback history. It keeps a small per-user mailbox
  for friend alerts, including a pending alert while that friend is offline
  (up to 12 hours).
- The session key inside the `FJ1…` join code acts as a room password.
- Friend codes contain a mailbox send key, not the owner's private receive key.
  The relay forwards a jam only to the addressed mailbox; it never broadcasts
  to everyone.
- Only a host can create a room; only hosts can send state; only guests can
  send commands.
- Use TLS (`wss://`) for anything that leaves your machine.
- Do not publish the relay URL together with the join code to strangers.
