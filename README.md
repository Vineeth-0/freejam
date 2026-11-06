# FreeJam

A Spicetify extension that gives free Spotify accounts a Jam-style shared
listening session without calling Spotify's Premium-only Jam endpoints and
without bypassing any paywall.

FreeJam has three parts:

| Part | Guests need FreeJam? | What it does |
| --- | --- | --- |
| **Request mode** | No | A normal collaborative playlist acts as a request inbox. New songs guests add are queued on the host's device. |
| **Sync mode** | Yes | Host-authoritative playback sync over a small relay. Skips, seeks and play/pause from any participant are applied for everyone. |
| **Friends** | Yes | A private native desktop alert (plus a short ding) when someone you added starts a jam. Only added friends can reach your mailbox; nothing is broadcast to everyone. |

Both playback modes work on free accounts. FreeJam is a cooperative third-party
player, not Spotify Jam.

---

## Quick start

### "I just want friends to add songs" (request mode)

1. Install the extension (below).
2. Open FreeJam → type a name → **Start session**.
3. Send the copied Spotify playlist invite link.
4. Friends open it in Spotify and add songs. No install, no relay.

### "I want everyone on the same playhead" (sync mode)

1. Run or deploy the relay (see [The relay, in depth](#the-relay-in-depth)).
2. Host: paste the relay URL → **Start sync** → send the `FJ1...` code.
3. Guest: paste the `FJ1...` code → **Join sync**.

### "Alert me when a friend starts a jam" (friends)

1. Both people install the extension and use the **same relay**.
2. Each creates a friend code in the Friends card and sends it to the other.
3. Add each other. Future jams notify only the people on the list.

---

## Files

| File | Purpose |
| --- | --- |
| `freejam.js` | The Spicetify extension. Loads in every Spotify client. |
| `freejam-relay.js` | The dependency-free Node.js relay used by sync mode and friend mailboxes. |
| `notifier/` | Optional background notifier for native alerts while Spotify is fully closed. |
| `scripts/sync-to-spicetify.ps1` | Copies the extension into Spicetify and applies it. |
| `scripts/deploy-relay.ps1` | Copies the relay to a remote host and restarts its service. |
| `scripts/install-git-hooks.ps1` | Installs the `post-merge` and `pre-push` hooks. |
| `scripts/build-bundles.ps1` | Rebuilds the release zip files into `dist/`. |
| `hooks/post-merge` | After `git pull`, updates the extension and optionally deploys the relay. |
| `hooks/pre-push` | Before `git push`, updates the extension if it changed. |
| `README.md` | This file: usage plus the full relay guide. |
| `DEPLOY.md` | Short deployment recipes (Render, Cloudflare, VPS, Docker). |
| `PI-SETUP.md` | Complete Raspberry Pi / home-server walkthrough. |
| `freejam-relay.service` | systemd unit for the relay. |
| `freejam-tunnel.service` | systemd unit for a Cloudflare quick tunnel. |
| `Dockerfile`, `render.yaml` | Container and Render deployment helpers. |

---

## Install the extension

1. Copy `freejam.js` into your Spicetify **Extensions** folder:
   - Windows: `%APPDATA%\spicetify\Extensions`
   - macOS/Linux: `~/.config/spicetify/Extensions`
2. Add it to `config-xpui.ini`:
   ```ini
   [AdditionalOptions]
   extensions = freejam.js
   ```
3. Run `spicetify apply` and restart Spotify.

A **FreeJam** button appears in the playbar. Click it to open the panel.

---

## Updating (automatic)

The repo includes git hooks that keep the live extension and the relay in sync.

Install them once:

```powershell
cd C:\path\to\freejam
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-git-hooks.ps1
```

After that, updating is just:

```powershell
cd C:\path\to\freejam
git pull
```

What the hooks do:

| Hook | When | Action |
| --- | --- | --- |
| `post-merge` | After `git pull` | Copies `freejam.js` into Spicetify and runs `spicetify apply` if it changed. Also deploys `freejam-relay.js` to the configured Pi if it changed. |
| `pre-push` | Before `git push` | Applies the extension if `freejam.js` changed, so the local build matches what you push. |

`spicetify apply` restarts Spotify so the new version loads immediately. To
avoid the restart:

```powershell
$env:FREEJAM_NO_RESTART = "1"
git pull
```

To preview without changing anything:

```powershell
$env:FREEJAM_DRY_RUN = "1"
git pull
```

### Automatic relay deployment

If `freejam-relay.js` changes, the `post-merge` hook can copy it to a remote
host and restart the service. Configure the target once:

```powershell
$env:FREEJAM_PI_HOST = "relay.example.com"   # required: your relay host or IP
$env:FREEJAM_PI_USER = "pi"                  # optional: SSH user, default pi
$env:FREEJAM_PI_DIR = "~/freejam"            # optional
$env:FREEJAM_PI_SERVICE = "freejam-relay"    # optional
git pull
```

Or run the deploy script directly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy-relay.ps1 -PiHost relay.example.com
```

If the host is offline, the script prints a warning and does not block the pull.
Without `FREEJAM_PI_HOST`, relay changes are skipped. The manual fallback is:

```bash
scp freejam-relay.js <user>@<host>:~/freejam/
ssh <user>@<host> "sudo systemctl restart freejam-relay"
```

---

## Request mode (no guest install)

Best when your friends just want to add songs and do not want to install
anything.

### Host

1. Open the FreeJam panel.
2. Type a session name and click **Start session**.
   - FreeJam creates a private collaborative playlist.
   - It asks Spotify for a normal "Invite collaborators" link and copies it.
3. Send the invite link to your friends.
   - The link looks like
     `https://open.spotify.com/playlist/<id>?pt=<token>` and is valid for
     7 days.
   - If the automatic link fails, open the playlist, use **Invite
     collaborators**, and paste the resulting link into **Paste an invite
     link** → **Save link**.
4. Keep the panel open (or Spotify running). FreeJam polls the playlist every
   few seconds and queues anything new.

You can also click **Use playlist** and paste an existing playlist link.
FreeJam snapshots its current contents, so only songs added after that are
queued.

### Guest

1. Open the invite link in the normal Spotify app.
2. Accept the collaborator invite.
3. Add songs to the playlist as usual.

Each new song is queued on the host's device with a notification.

### Notes

- Request mode is one-way: guests choose *what* plays next, the host's player
  is still the one that plays it.
- The playlist is private; only people with the invite link can contribute.
- Invite links expire after 7 days. Use **New invite link** to mint another.
- The relay is not needed for request-mode playback. It is only needed if you
  also want friend jam alerts.

---

## Sync mode (FreeJam on every device)

Best when everyone wants the same playhead, and anyone should be able to skip,
seek, pause or resume for the group.

Sync mode is **host-authoritative**:

- The host owns playback. Only the host broadcasts authoritative state.
- Any guest can send a command (`track`, `next`, `prev`, `seek`, `pause`,
  `play`). The host applies it and re-broadcasts the result.
- A guest that skips or picks a song sends the **exact track URI** it landed
  on, so next, previous and arbitrary picks all resolve to the same song on
  the host.

### Host

1. Open the FreeJam panel.
2. Under **Playback sync**, paste the relay URL (for example
   `wss://relay.example.com` over the internet, or
   `ws://192.168.x.x:8787` on the same Wi-Fi).
3. Enter your name and click **Start sync**.
4. Copy the **FJ1…** join code and send it to your friends.

### Guest

1. Open the FreeJam panel.
2. Paste the **FJ1…** join code into **Join a sync session**.
3. Enter your name and click **Join sync**.

The status line shows `Following <host> · N connected · <latency>`.

### Controls

The sync card has:

- **Previous / Play-Pause / Next**
- A seek slider with the current time
- **Resync** (guest) — re-request the host's state
- **Leave sync**

Native controls also work: pausing, playing, skipping or dragging Spotify's own
seek bar is detected and forwarded. The FreeJam seek slider is the exact path;
native seek detection is best-effort.

### Join codes

A join code looks like `FJ1.<base64url>` and contains:

```json
{ "v": 1, "u": "<relay url>", "s": "<session id>", "k": "<session key>" }
```

It is a convenience bundle for the relay address, session id and session key.
Treat it like a room password. The guest does not type the relay URL because it
is already inside the code.

---

# The relay, in depth

This is the long version: what the relay is, why it exists, where its addresses
and keys come from, how to host it, and how to operate it.

## 1. What the relay is

`freejam-relay.js` is a **single-file Node.js server** that:

- speaks the WebSocket protocol,
- forwards playback messages between the host and guests of one sync session,
- stores a small per-user mailbox so friends can receive jam alerts.

It has **no npm dependencies**. It implements the HTTP upgrade handshake and
WebSocket framing itself using only Node's built-in `http`, `crypto` and `os`
modules. Node 18 or newer is enough.

It is not a Spotify service, not a proxy, and not a bot. It never talks to
Spotify. It is a message switchboard that the FreeJam extension connects to.

## 2. Why a relay exists at all

Spotify's real Jam feature is Premium-only and uses Spotify's own servers. Free
accounts cannot call those endpoints. FreeJam therefore needs its own way to
move three kinds of data between devices:

1. **Playback state** from the host (track URI, position, paused).
2. **Commands** from guests (skip, seek, pause, play).
3. **Jam alerts** from a host to specific friends.

A browser/Spotify client cannot reliably open a direct peer-to-peer socket to
another client. NAT, firewalls, and the sandboxed Spotify client make that
fragile. A relay gives every participant one stable, reachable endpoint.

The friend mailbox also needs **store-and-forward**: if a friend is offline when
a jam starts, the invite should wait for them. That requires a process that is
running even when both friends are not.

So the relay is the smallest server that solves both problems: a WebSocket
switchboard plus a bounded in-memory mailbox.

## 3. Where the relay comes from

The relay is part of this repository. There is no external service to sign up
for and no vendor account required.

- Source: `freejam-relay.js` in this repo.
- Runtime: Node.js 18+.
- State: in memory only. No database, no files, no logs of playback history.
- Dependencies: none.

You provide three things:

| Thing | Where it comes from | Who chooses it |
| --- | --- | --- |
| Relay address | You host the relay somewhere, or use a tunnel in front of it. | You |
| Session id and session key | Generated by the extension when the host clicks **Start sync**. | The extension |
| Friend identity keys | Generated once when you click **Create my friend code**. | The extension |

The extension generates random values with `crypto.getRandomValues`:

| Value | Size | Used for |
| --- | --- | --- |
| Session id | 16 random bytes (32 hex chars) | Names the sync room. |
| Session key | 16 random bytes (32 hex chars) | Room password. |
| User id | 12 random bytes (24 hex chars) | Names your friend mailbox. |
| Receive key (`recvKey`) | 24 random bytes (48 hex chars) | Proves you own your mailbox. |
| Send key (`sendKey`) | 24 random bytes (48 hex chars) | Lets friends deliver alerts to you. |

Nothing is derived from your Spotify account. The relay never learns your
Spotify username, email, password, or OAuth token.

## 4. What the relay actually does

The relay has two independent jobs.

### 4.1 Sync rooms

A **room** is identified by a session id. It holds:

- the session key,
- the connected host and guests,
- their display names and roles.

Rules enforced by the relay:

- **Only a host can create a room.** A guest that connects before the host gets
  close code `4004` ("Session not found"). This stops someone who guesses a
  session id from squatting it before the real host arrives.
- **The session key must match.** A wrong key gets `4003`.
- **A reconnecting host replaces the old host.** The old host socket gets
  `4005` ("Replaced by a new host"). The session key must match, so a client
  without the code cannot take over.
- **Only the host may send `state`.** Only guests may send `cmd`. The relay
  drops the wrong direction, which prevents guests from spoofing playback and
  prevents feedback loops.
- **The relay rewrites the sender fields** (`from`, `fromName`, `fromRole`) so a
  client cannot pretend to be someone else.
- **Rooms disappear when empty.** Nothing is stored after the last client
  leaves.

The host and guests exchange these messages:

| Message | Direction | Meaning |
| --- | --- | --- |
| `hello` | client → relay | Set display name and role. |
| `presence` | relay → room | Current member list and count. |
| `state` | host → relay → everyone else | Authoritative playback state. |
| `cmd` | guest → relay → everyone else | Requested action; the host applies it. |
| `ping` / `pong` | both ways | Latency measurement and keepalive. |

The extension adds latency compensation, echo suppression and reconnect logic on
top. See [How sync behaves](#how-sync-behaves).

### 4.2 Friend mailboxes

A **mailbox** is identified by a user id. It holds:

- the owner's private `recvKey`,
- the shareable `sendKey`,
- the owner's connected devices,
- the last jam (optional).

Flow:

1. The owner connects with `?user=<userId>&key=<recvKey>`.
2. The owner sends `hello` with their `sendKey`. The relay registers it.
3. A friend sends `dm` with `to=<userId>`, `sendKey=<owner's sendKey>`, and a
   jam object.
4. The relay checks the send key. If it matches, it delivers the jam to the
   owner's connected devices, or queues it if the owner is offline.
5. The owner's extension checks the sender against its **local friend list**.
   A jam from someone not on the list is ignored even if the relay accepted it.

Mailbox clients identify themselves with `client=app` (the Spotify extension)
or `client=notifier` (the optional background helper). This keeps alerts from
doubling up:

- If an app client is connected, the relay sends the jam only to app clients.
  The extension raises the OS notification; the notifier stays silent.
- If only notifier clients are connected, the relay sends the jam to those whose
  declared friend list contains the sender and also queues a copy for the app.
  The app later receives that copy with `suppressNotify: true`, so it shows the
  **Join jam** card without a second notification.
- Pending jams delivered to a notifier are marked `notifiedAt` and kept for the
  app. Pending jams delivered to the app are removed.

The relay never broadcasts a jam to all users. There is no global feed. A
mailbox only receives messages addressed to its own user id.

Presence works through `watch`:

- The extension sends the list of friend user ids it cares about.
- The relay answers with which of those mailboxes are currently connected.
- The relay re-sends presence when a watched mailbox connects or disconnects.

This is why a friend shows **online** only when their Spotify + FreeJam are
actually running and connected to the same relay.

## 5. Wire protocol reference

This section is for debugging and for anyone who wants to write another client.

### 5.1 Sync connection URL

```
wss://relay.example.com/?session=<sessionId>&key=<sessionKey>&id=<connectionId>&name=<displayName>&role=host
wss://relay.example.com/?session=<sessionId>&key=<sessionKey>&id=<connectionId>&name=<displayName>&role=guest
```

| Parameter | Required | Meaning |
| --- | --- | --- |
| `session` | yes | Room id. |
| `key` | yes | Room password. |
| `id` | no | Connection id. Generated by the relay if omitted. |
| `name` | no | Display name, max 64 chars. Defaults to `Listener`. |
| `role` | no | `host` or `guest`. Defaults to `guest`. |

### 5.2 Sync messages

```jsonc
// client → relay
{ "t": "hello", "name": "Alice", "role": "host" }

// relay → room
{ "t": "presence", "count": 2, "members": [
  { "id": "a1", "name": "Alice", "role": "host" },
  { "id": "b2", "name": "Bob", "role": "guest" }
] }

// host → relay → guests
{ "t": "state", "uri": "spotify:track:...", "pos": 12345, "paused": false }

// guest → relay → others
{ "t": "cmd", "action": "track", "uri": "spotify:track:...", "value": 0 }

// both ways
{ "t": "ping", "id": "abc", "ts": 1730000000000 }
{ "t": "pong", "id": "abc", "ts": 1730000000000, "serverTs": 1730000000001 }
```

### 5.3 Mailbox connection URL

```
wss://relay.example.com/?user=<userId>&key=<recvKey>&id=<connectionId>&name=<displayName>&client=app
wss://relay.example.com/?user=<userId>&key=<recvKey>&id=<connectionId>&name=<displayName>&client=notifier
```

Presence of the `user` parameter selects mailbox mode. The `key` must be the
owner's private receive key. `client` is optional and defaults to `app`;
`notifier` is used by the background helper so the relay can avoid duplicate
alerts.

### 5.4 Mailbox messages

```jsonc
// owner → relay
{ "t": "hello", "name": "Alice", "sendKey": "<sendKey>" }

// background notifier → relay (optional local filter)
{ "t": "hello", "name": "Alice", "friends": ["<friendUserId>", "..."] }

// relay → owner
{ "t": "hello-ok", "userId": "<userId>", "sendKey": "<sendKey>" }

// owner → relay, then relay → owner
{ "t": "watch", "ids": ["<friendUserId>", "..."] }
{ "t": "presence", "online": ["<friendUserId>"] }

// friend → relay
{
  "t": "dm",
  "to": "<friendUserId>",
  "sendKey": "<friendSendKey>",
  "jam": {
    "mode": "sync",
    "hostName": "Alice",
    "joinCode": "FJ1...",
    "sessionId": "...",
    "inviteUrl": "",
    "expiresAt": 0
  }
}

// relay → mailbox owner
{ "t": "jam", "mode": "sync", "from": "<senderUserId>", "fromName": "Alice", "...": "..." }

// relay → app, for a pending jam the notifier already announced
{ "t": "jam", "...": "...", "suppressNotify": true }

// friend → relay, then relay → owner
{ "t": "jam-clear", "to": "<friendUserId>", "sendKey": "<friendSendKey>" }
{ "t": "jam-clear", "from": "<senderUserId>" }
```

A request-mode jam uses `"mode": "request"`, an `inviteUrl`, and an
`expiresAt`. A sync jam uses `"mode": "sync"` with a `joinCode` and
`sessionId`.

### 5.5 Close codes

| Code | Meaning |
| --- | --- |
| `1000` | Normal close. |
| `1009` | Message too large or receive buffer overflow. |
| `4003` | Wrong session key or wrong mailbox receive key. |
| `4004` | Sync session does not exist yet (guest connected before the host). |
| `4005` | Replaced by a new host connection. |
| `4008` | Rate limit exceeded. |
| `4009` | Session or mailbox is full. |

### 5.6 Limits

| Limit | Value |
| --- | --- |
| Max message size | 64 KiB |
| Max receive buffer | 256 KiB |
| Messages per second per connection | 40 |
| Connections per sync room | 32 total (host + guests) |
| Connections per mailbox | 8 |
| Total mailboxes | 10,000 |
| Pending jams per user | 20 |
| Pending jam lifetime | 12 hours |
| Watched friends per connection | 200 |

## 6. Pick a hosting model

Choose based on who needs to reach the relay.

| Situation | Recommended setup | URL to use in FreeJam |
| --- | --- | --- |
| Everyone on the same Wi-Fi | Run the relay on the host PC | `ws://192.168.x.x:8787` |
| Everyone on a Tailscale/private VPN | Run the relay on any always-on device | `ws://100.x.x.x:8787` |
| Different networks, no server, temporary | Cloudflare Quick Tunnel in front of a local relay | `wss://<random>.trycloudflare.com` |
| Different networks, stable, own domain | Named Cloudflare Tunnel | `wss://relay.example.com` |
| Different networks, no server, free | Render web service | `wss://<name>.onrender.com` |
| You already have a VPS | Relay behind Caddy or nginx | `wss://relay.example.com` |
| Always-on home device | Raspberry Pi + systemd + tunnel | `wss://relay.example.com` or a quick tunnel |

**TLS rule:** anything that leaves your machine must use `wss://`. A bare
`ws://` relay on the public internet exposes playback messages and keys to
anyone on the path. On a LAN or inside Tailscale, `ws://` is acceptable because
the network itself is private (Tailscale encrypts traffic).

### 6.1 Same Wi-Fi (LAN)

Run the relay on the host PC:

```bash
node freejam-relay.js
```

It prints addresses such as:

```
FreeJam relay listening on ws://0.0.0.0:8787
  LAN address: ws://192.168.x.x:8787
```

Use the `192.168.x.x` address. Allow Node through the firewall if prompted.
This only works while both devices are on the same network and the host PC is
awake.

### 6.2 Tailscale or another private VPN

Run the relay on a device that is always on, then use its VPN address:

```
ws://100.x.x.x:8787
```

Tailscale encrypts the connection, so TLS is not required inside the tailnet.
Every participant must be in the same tailnet. This is ideal for a small group
of trusted devices, but it is not suitable for friends who will not install a
VPN.

### 6.3 Cloudflare Quick Tunnel

Good for testing and for a temporary public URL. No Cloudflare account, no
domain, no port forwarding.

Install `cloudflared` first:

```powershell
# Windows
winget install --id Cloudflare.cloudflared
```

```bash
# macOS
brew install cloudflared

# Debian/Ubuntu/Raspberry Pi (ARM64)
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cloudflared-linux-arm64.deb
```

Then:

```bash
node freejam-relay.js
# in a second terminal
cloudflared tunnel --url http://localhost:8787
```

Cloudflare prints a URL like:

```
https://random-words-here.trycloudflare.com
```

Use `wss://random-words-here.trycloudflare.com` in FreeJam.

Caveats:

- The URL changes whenever `cloudflared` restarts or the machine reboots.
- Both the relay and `cloudflared` must stay running.
- A quick tunnel is not intended as permanent production infrastructure.

### 6.4 Named Cloudflare Tunnel (stable URL)

A named tunnel gives a permanent hostname such as `relay.example.com`. It
requires a domain whose DNS is managed by Cloudflare (the free plan is enough).
See `PI-SETUP.md` for the full walkthrough. The short version:

```bash
cloudflared tunnel login
cloudflared tunnel create freejam
cloudflared tunnel route dns freejam relay.example.com
```

Then point the tunnel's `config.yml` at `http://127.0.0.1:8787` and install it
as a service. `PI-SETUP.md` has the exact unit and config file. Then use
`wss://relay.example.com`.

### 6.5 Render

The repo includes `package.json` and `render.yaml`. Create a Render **Web
Service** from the repo:

- Runtime: Node
- Build: `npm install`
- Start: `npm start`
- Health check: `/health`
- Plan: Free

Use `wss://<name>.onrender.com`. Free services sleep after inactivity; the first
connection can take 30–60 seconds, and FreeJam retries automatically. An open
WebSocket keeps the service awake during a session.

### 6.6 VPS with Caddy or nginx

Run the relay on `127.0.0.1:8787` and terminate TLS in front of it.

Caddy:

```
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy obtains certificates automatically and proxies WebSocket upgrades by
default.

nginx:

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;

    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}
```

The `Upgrade` and `Connection` headers are required. Without them the WebSocket
handshake fails even though `/health` works.

### 6.7 Docker

```bash
docker build -t freejam-relay .
docker run -d --restart unless-stopped -p 127.0.0.1:8787:8787 freejam-relay
```

Put a TLS terminator in front before exposing it to the internet. Binding to
`127.0.0.1` on the host keeps the relay off the public interface.

## 7. Self-host step by step

### 7.1 Run it once

```bash
node freejam-relay.js
```

Configuration is via environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on. |
| `HOST` | `0.0.0.0` | Interface to bind. Use `127.0.0.1` when a tunnel is in front. |

Examples:

```bash
# Public on the LAN
node freejam-relay.js

# Loopback only, for a tunnel or reverse proxy
HOST=127.0.0.1 node freejam-relay.js

# Different port
PORT=9000 node freejam-relay.js
```

Windows PowerShell:

```powershell
$env:PORT = "9000"
$env:HOST = "127.0.0.1"
node freejam-relay.js
```

Test it:

```bash
curl http://127.0.0.1:8787/health
```

You should see `FreeJam relay is running.`

### 7.2 Keep it running

#### Linux / Raspberry Pi (systemd)

The included `freejam-relay.service` assumes the relay is in
`/home/pi/freejam`, Node is at `/usr/bin/node`, and the service runs as `pi`.
Edit those if needed.

```bash
sudo cp freejam-relay.service /etc/systemd/system/freejam-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now freejam-relay
systemctl status freejam-relay
journalctl -u freejam-relay -n 30 --no-pager
```

To follow logs live:

```bash
journalctl -u freejam-relay -f
```

#### Windows (Task Scheduler, NSSM, or pm2)

For a permanent Windows host, create a Task Scheduler task:

- Trigger: **At startup**
- Action: start `C:\Program Files\nodejs\node.exe`
- Arguments: `C:\path\to\freejam-relay.js`
- Start in: the folder containing the relay
- Run whether the user is logged on or not

Alternatively use [NSSM](https://nssm.cc/) to register it as a Windows service.
On Linux or macOS, `pm2` is another option:

```bash
npm install -g pm2
pm2 start freejam-relay.js --name freejam-relay
pm2 save
pm2 startup
```

#### Docker

See [6.7 Docker](#67-docker). Use `--restart unless-stopped`.

### 7.3 Put TLS in front

Pick one:

- **Cloudflare Quick Tunnel** — fastest, temporary URL.
- **Named Cloudflare Tunnel** — stable URL, needs a domain.
- **Caddy** — automatic certificates on a VPS.
- **nginx** — manual certificate setup.
- **Render** — TLS handled by the platform.

Whichever you choose, the final URL must start with `wss://` when used over the
internet.

### 7.4 Verify from outside

From a different network (for example your phone on mobile data):

```bash
curl https://relay.example.com/health
```

Expected:

```
FreeJam relay is running.

Sync sessions: point the FreeJam extension at this WebSocket URL, for
example:
  ws://<this-machine-ip>:8787

Friend mailboxes: friends send jam invites only to the mailboxes of
people who added them. Nothing is broadcast to everyone.

Keep this process running while you use FreeJam.
```

If `/health` works but FreeJam cannot connect, the WebSocket upgrade is being
blocked. Check the reverse proxy's `Upgrade`/`Connection` headers or the tunnel
configuration.

## 8. Point FreeJam at the relay

### Sync host

1. Paste the base URL into **Playback sync**:
   - `wss://relay.example.com`
   - or `ws://192.168.x.x:8787` on a LAN
2. Click **Start sync**.
3. Share the generated `FJ1...` code.

FreeJam normalizes the URL:

| You paste | FreeJam uses |
| --- | --- |
| `https://relay.example.com` | `wss://relay.example.com` |
| `http://192.168.x.x:8787` | `ws://192.168.x.x:8787` |
| `relay.example.com` | `ws://relay.example.com` |
| trailing `/` | trimmed |

Use the base address, not a path. The extension appends the query parameters.

A bare hostname becomes `ws://`, not `wss://`. For a public relay, always type
the `wss://` prefix (or paste the `https://` URL) so the connection is
encrypted.

### Sync guest

Paste only the `FJ1...` code. The relay URL, session id and key are inside it.

### Friends

Every participant must enter the **same relay URL** in the Friends card,
because mailboxes live on one relay. The friend code also records the relay the
code was created on, which is why FreeJam warns when two codes come from
different relays.

If you change relays:

1. Update the URL in the Friends card and click **Save relay**.
2. Copy your friend code again and send it to your friends.
3. Ask them to add the new code so their copy points at the same relay.

### Why the relay field is already filled in

If you joined someone's sync session, the `FJ1...` code carried **their** relay
URL and FreeJam saved it as your last relay. The Friends card pre-fills that
value on purpose, because friend mailboxes only work when both people use the
same relay.

The relay is a shared endpoint, not a personal account:

- It is not tied to your Spotify identity.
- Your friend still has their own mailbox, user id and keys on it.
- They cannot read your mailbox without your `recvKey`.
- They can send you a jam only because your friend code gave them your
  `sendKey`.

If you deliberately want a different relay, you can change it, but friend
alerts between you and anyone still on the old relay will stop working. Sync
sessions can still work across relays because each `FJ1` code carries the
host's relay.

## 9. Operating the relay

### Logs

The relay logs only connection lifecycle events, for example:

```
[join] 4f2a1c9d… host Alice (a1) — 1 in room
[join] 4f2a1c9d… guest Bob (b2) — 2 in room
[mailbox] 91c02f… Alice (c3) — 1 connected
[leave] mailbox:91c0… member Alice — 0 connected
```

It does **not** log track names, playback history, or message contents.

### Health checks

`GET /` and `GET /health` both return `200` with a short text body. Point an
uptime monitor at `/health` if you want to know when the relay is down.

### Updates

Update the relay whenever `freejam-relay.js` changes. Old relays reject friend
mailboxes and show a handshake error in the extension.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy-relay.ps1 -PiHost <host>
```

or manually:

```bash
scp freejam-relay.js user@host:~/freejam/
ssh user@host "sudo systemctl restart freejam-relay"
```

The `post-merge` hook does this automatically when `FREEJAM_PI_HOST` is set.

### Restart behavior

The relay keeps everything in memory. A restart:

- ends all sync rooms (guests reconnect with backoff and rejoin),
- drops registered mailboxes until each owner reconnects,
- **drops pending offline jam alerts**.

That is acceptable for a small friend group. If you need durable mailboxes,
add a database, but that is outside the current design.

### Resource use

A Pi 5, a small VPS, or a spare PC is more than enough. The relay uses a few MB
of RAM and almost no CPU. Memory grows with the number of live rooms, mailboxes
and pending jams, all of which are capped (see [5.6 Limits](#56-limits)).

## 10. Security and privacy

### Trust model

The relay is a shared-secret message switchboard, not an account system.

| Secret | Who has it | What it grants |
| --- | --- | --- |
| Session key | Host + everyone given the `FJ1` code | Join the room as a guest. |
| Session id | Same | Identify the room. Not secret on its own. |
| `recvKey` | Only the mailbox owner | Read/own that mailbox. |
| `sendKey` | Anyone given the owner's `FJF1` code | Send a jam alert to that mailbox. |

Important consequences:

- **The session key is also effectively the host password.** The relay decides
  host vs guest from the `role` parameter and only checks the session key. A
  person who has the join code can reconnect with `role=host` and replace the
  current host (`4005`). Only share join codes with people you trust.
- **A send key can spam a mailbox.** Anyone with your `sendKey` can send you jam
  alerts. The extension filters alerts against your local friend list, so
  unwanted senders do not appear in the UI, but the relay still accepts the
  message. If a send key leaks, clear the `freejam:friends:v1` value in
  Spicetify LocalStorage so a new identity is generated, then re-share the new
  friend code.
- **The background notifier stores your `recvKey`.** The setup code and the
  local notifier config are equivalent to a mailbox password. Install the
  notifier only on a device you control, and do not commit or share the config.
- **The relay can read message contents.** TLS protects the path, but the relay
  (or the proxy that terminates TLS for it) sees plaintext. There is no
  end-to-end encryption. Do not send secrets through jam payloads.
- **The relay does not authenticate Spotify users.** Anyone who can reach the
  URL can create rooms or mailboxes, within the caps.

### What the relay never does

- It never contacts Spotify.
- It never stores playback history.
- It never broadcasts a jam to all users.
- It never stores your Spotify credentials or tokens.
- It never writes messages to disk.

### What to share, and what not to

Share:

- the `FJ1...` join code with the people in the session,
- your `FJF1...` friend code with people you actually want alerts from.

Do not post either code publicly. Do not put the relay URL and a live join code
in the same public message.

### If you need stronger isolation

- Put the relay on a private tailnet and use `ws://` there.
- Use a named tunnel hostname that is not easy to guess, and rotate the session
  key per session.
- Restrict access at the network layer (Cloudflare Access, firewall allowlist,
  VPN). The extension itself does not implement user accounts.

## 11. Relay troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `curl /health` fails | Relay not running, wrong port, firewall | Start it; check `PORT`; allow the port. |
| Cloudflare `502` / `1033` | Tunnel cannot reach the relay | Check the relay is on `127.0.0.1:8787` and `config.yml` points there. |
| `/health` works, FreeJam cannot connect | Proxy is not forwarding WebSocket upgrades | Add `Upgrade`/`Connection` headers, or check the tunnel. |
| Guest gets "Session not found" (`4004`) | Host is not connected yet | Start the host first; resend a fresh join code. |
| "Session key is wrong" (`4003`) | Truncated/corrupted code, or another session | Copy the whole `FJ1...` code. |
| Host gets `4005` | Another device claimed host with the same code | Use one host device, or start a fresh session. |
| `4009` full | Room or mailbox connection cap | Close extra devices; wait for stale connections to drop. |
| `4008` rate limit | A client is sending too fast | Restart the extension; check for a loop. |
| URL changed after reboot | Quick tunnel generated a new hostname | Get the new URL, start a fresh sync, re-share the code. |
| Friend stays offline | Different relays, or relay too old | Use the same URL on both sides; update `freejam-relay.js`. |
| Friend alert never arrives | Codes not exchanged, or sender not in the list | Add each other's `FJF1` codes; use **Send to friends**. |
| Offline alert lost | Relay restarted | Pending alerts are in memory; ask the host to resend. |
| Render takes ~1 minute | Free service was asleep | Wait; FreeJam retries with backoff. |

## 12. Example: an always-on home relay

This is the layout many people use for a small friend group. Nothing here is
required, and every value is a placeholder you replace with your own.

- An always-on machine (a Raspberry Pi, mini PC, or spare laptop) on your
  network. Call it `<relay-host>`.
- The relay runs as a systemd service (or Windows service) bound to
  `127.0.0.1:8787`.
- A Cloudflare quick tunnel, or a named tunnel with your own domain, exposes it
  publicly as `wss://<your-relay-hostname>`.
- A private VPN such as Tailscale is optional and only for administration and
  deployment, never for guests.
- The relay directory is `~/freejam` on that machine.
- On the machine where you run `git pull`, automatic deploys use
  `FREEJAM_PI_HOST=<relay-host>`.

Useful commands on the relay machine:

```bash
systemctl status freejam-relay freejam-tunnel
journalctl -u freejam-relay -f
journalctl -u freejam-tunnel -n 50 --no-pager | grep trycloudflare
sudo systemctl restart freejam-relay freejam-tunnel
```

With a quick tunnel, the public hostname changes if the machine or
`cloudflared` restarts. After a change:

1. Read the new URL from the `cloudflared` output (or your own helper script).
2. Start a fresh sync session on the host.
3. In the Friends card, click **Save relay** with the new URL.
4. Copy your friend code again so friends update theirs.

For a permanent hostname, switch to a named Cloudflare Tunnel; see
`PI-SETUP.md`.

---

## Friends and jam alerts

The Friends card lets you get a native Windows or macOS notification — plus a
short ding — when someone you added starts a jam, and join it in one click.

### One-time setup

1. Open the FreeJam panel → **Friends**.
2. Enter your name and the same public relay URL you use for sync.
3. Click **Create my friend code**.
4. Click **Copy my code** and send it to the people you trust.
5. Paste a friend's `FJF1…` code into **Add a friend** → **Add friend**.

Repeat step 5 for each friend. When they add your code too, the card shows
**online** next to their name.

### Getting alerts

- Start a sync session or a request session. FreeJam automatically sends a
  private jam alert to the friends in your list.
- You can also click **Send to friends** on an active session.
- The friend sees a notification and a **Join jam** button in their Friends
  card. **Join jam** joins the sync session, or opens/copies the request
  playlist invite link.
- If the friend is offline, the invite is delivered the next time they open
  Spotify (for up to 12 hours, unless the relay restarted).

### Desktop alerts and the ding

Alert preferences live in the **Settings** section at the bottom of the FreeJam
panel:

- **Desktop notifications** — a native Windows/macOS notification. Turning it on
  asks Spotify for permission the first time. Clicking the notification brings
  Spotify forward. If permission is blocked, FreeJam falls back to the in-app
  toast.
- **Ding sound** — a short synthesized bell. It is generated with the Web Audio
  API, so there is no audio file to download.

If notifications do not appear, allow them for Spotify in
**Settings → System → Notifications** on Windows, or
**System Settings → Notifications** on macOS.

Alerts work while Spotify is running, including minimized. They stop when
Spotify is fully quit, because the extension runs inside Spotify.

### Alerts while Spotify is closed

For that case there is an optional background notifier in `notifier/`. It is a
small Node.js 18+ helper that connects to the same private mailbox and shows a
native notification (and the same ding) when Spotify is not running.

1. Open **Settings** in the FreeJam panel.
2. Under **Alerts while Spotify is closed**, click **Copy setup code**.
3. Download or clone this repository and open `notifier/`.
4. Run the installer for your OS and paste the code:
   - Windows: `powershell -ExecutionPolicy Bypass -File .\install-notifier.ps1`
   - macOS: `bash install-notifier-macos.sh`
5. The installer starts it now and registers it to start at login.

The setup code contains your **private `recvKey`**, not your send key. Treat it
like a password and only install it on your own device. Re-copy the code after
adding or removing friends so the notifier's local filter matches your list, and
after changing the **Ding sound** setting so the background notifier matches.

The relay avoids duplicate alerts: while the Spotify app is connected, the
notifier stays silent and the extension raises the alert. If only the notifier
is connected, it alerts and the relay keeps the jam queued so the app still
shows a **Join jam** card when it opens.

See [`notifier/README.md`](notifier/README.md) for install details,
troubleshooting, and uninstall steps.

### Sending the invite

Spotify has no public direct-message API, so FreeJam cannot post into Spotify's
in-app messages for you. Instead, **Copy invite message** puts a ready-to-paste
message on your clipboard containing:

- what the jam is,
- the `FJ1` join code or playlist invite link, and
- your `FJF1` friend code.

Paste that into a Spotify playlist comment, Discord, WhatsApp, SMS, or anywhere
else. The other person pastes your friend code into FreeJam once; after that,
alerts arrive automatically.

### Privacy model

Each user gets two random keys:

| Key | Who has it | What it does |
| --- | --- | --- |
| `recvKey` | Only you | Authenticates your connection to your own mailbox. |
| `sendKey` | Anyone you give your friend code to | Lets a friend deliver a jam alert to your mailbox. |

Your friend code contains the `sendKey`, **not** the `recvKey`. A friend can
send you a jam, but cannot read your mailbox or pretend to be you. The relay
stores a mailbox per user id and forwards a jam only to that mailbox; it never
broadcasts an invite to every FreeJam user. The extension also checks the
sender against your local friend list, so a jam from someone you did not add is
ignored even if it reaches the relay.

The optional background notifier stores the `recvKey` in a local config file so
it can keep listening while Spotify is closed. That file is created with
user-only permissions on macOS and Linux and lives in your user profile on
Windows. The notifier also embeds the friend list from the setup code and
ignores alerts from any other user id.

Everyone must use the **same relay** for friend mailboxes to work. If you change
the relay URL, copy your friend code again so friends can update it.

### Friend code format

```
FJF1.<base64url(JSON)>
```

```json
{ "v": 1, "u": "<relay url>", "id": "<userId>", "sk": "<sendKey>", "n": "<name>" }
```

It contains the send key, never the receive key.

---

## How sync behaves

- **Host authoritative.** Guests never send state, only commands. The relay
  rejects state from guests and commands from hosts.
- **Latency compensation.** Guests add measured round-trip latency when
  aligning a playing track.
- **Echo suppression.** State that a guest itself just applied is not sent back
  as a user action. A state broadcast already in flight when a guest issues a
  command is ignored for a short grace window so it cannot undo that command.
- **Track changes are exact.** A guest skip sends the URI it landed on, so
  `previous` and arbitrary picks stay deterministic.
- **Stale alignment seeks are cancelled.** If the user skips or seeks while a
  remote track is still loading, the delayed alignment seek is dropped.
- **Ads stay local.** Free accounts get ads on their own schedule. The host does
  not broadcast during an ad, and a guest does not apply remote state during an
  ad; the next broadcast catches it up.
- **Reconnects.** Guests retry with backoff. A host that reconnects replaces its
  old socket. Wrong keys, full rooms and replaced hosts stop retrying and show
  an error.

---

## Limitations

- Sync mode requires FreeJam on every participant. There is no way to make a
  free account follow another device's playhead using Spotify's own APIs.
- Request mode only queues songs; it does not sync playback.
- Native seeks are detected by comparing the playhead against the expected
  position every 500 ms. Very small seeks may be corrected by the host's next
  state broadcast; use the FreeJam slider for precise seeks.
- Free accounts hear ads locally. Everyone re-converges after the ad.
- Friend alerts need FreeJam on both devices and the same relay. Native alerts
  work while Spotify is running; install the optional background notifier to
  receive them while Spotify is fully closed.
- The relay stores mailboxes and pending alerts in memory, so a relay restart
  drops them.
- Spotify has no public direct-message API. FreeJam copies an invite message
  for you to paste; it cannot post into Spotify's in-app messages.
- The extension uses Spicetify's player APIs, so Spotify UI changes can require
  an update.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No FreeJam button | Confirm `extensions = freejam.js` in `config-xpui.ini`, run `spicetify apply`, restart Spotify. |
| Invite link not created | Open the playlist → **Invite collaborators**, then paste the link into the panel. |
| Guest stuck on "Waiting for the host" | The host is not connected yet, or is using a different session id. Re-send the join code. |
| "The session key is wrong" | The join code was truncated or belongs to another session. |
| "Could not open the relay connection" | Check the relay URL, port, firewall, and whether the relay is running. |
| Sync drifts | Click **Resync**; check the latency shown in the status line. |
| Nothing queues in request mode | Keep Spotify open on the host, confirm the invite link is saved, and click **Check now**. |
| Friend stays offline | Both devices must use the same relay URL, and the relay must be running the current `freejam-relay.js`. |
| No jam alert from a friend | Add each other's `FJF1` codes, then start or resend the jam with **Send to friends**. |
| "Different relay" warning | You and that friend created codes on different relays. Use the same relay and re-share the friend code. |
| Friend alert does not arrive while offline | It is queued for up to 12 hours and delivered the next time they open Spotify with FreeJam. |
| No desktop notification while Spotify is minimized | Turn on **Desktop notifications** in Settings and allow notifications for Spotify in Windows/macOS settings. If Spotify blocks the web notification API, the alert stays in-app. |
| No alert while Spotify is fully closed | Install the optional background notifier from `notifier/` and paste the code from **Settings → Alerts while Spotify is closed**. |
| Background notifier ignores a new friend | Re-copy the setup code from Settings after adding or removing friends, then run the installer again. |
| Duplicate friend alerts | Update `freejam-relay.js` on the relay. The current relay suppresses the background notifier while the Spotify app is connected. |
| Relay field pre-filled with someone else's URL | You joined their sync session; the `FJ1` code carries their relay. Keep it for friend alerts, or switch and re-share codes. |
| Relay URL changed | Quick tunnel restarted. Get the new URL, start a fresh session, update the Friends relay, re-share codes. |

---

## Development

Both files are plain JavaScript and can be syntax-checked with:

```bash
node --check freejam.js
node --check freejam-relay.js
node --check notifier/freejam-notifier.js
```

The relay has no dependencies. The extension expects the Spicetify global
(`Spicetify.Player`, `Spicetify.Platform.PlaylistAPI`,
`Spicetify.Platform.PlaylistPermissionsAPI`, `Spicetify.Playbar`,
`Spicetify.PopupModal`, `Spicetify.LocalStorage`).
