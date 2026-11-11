# FreeJam

FreeJam adds a shared listening session to Spotify for free accounts. Everyone
hears the same track at the same position, and anyone can skip, seek, pause or
resume. It works through Spicetify and a small relay that you host yourself. It
does not use Spotify's Premium-only Jam endpoints and does not bypass any
paywall.

> **Only one person needs to run the relay.** Everyone else just installs the
> extension and pastes the join code.

## Quick start

1. **One person hosts the relay.** Follow [Hosting the relay](#hosting-the-relay).
2. **Everyone installs FreeJam.** Follow [Install](#install).
3. **The host starts a jam.** Open FreeJam, paste the relay URL, click
   **Start sync**, and copy the `FJ1...` join code.
4. **Everyone else joins.** Paste the code into **Join a sync session** and
   click **Join sync**.

The host owns playback. Guests can request skips, seeks, pause and play; the
host applies the change for everyone.

## Install

### Spicetify Marketplace

Open **Marketplace → Extensions → FreeJam → Install**.

### Manual

1. Copy `freejam.js` into your Spicetify Extensions folder:
   - Windows: `%APPDATA%\spicetify\Extensions`
   - macOS/Linux: `~/.config/spicetify/Extensions`
2. Add it to `config-xpui.ini`:
   ```ini
   [AdditionalOptions]
   extensions = freejam.js
   ```
3. Run `spicetify apply` and restart Spotify.

A **FreeJam** button appears in the playbar.

Guests only need the extension. They do not need Node.js and they do not need to
run a relay.

## Hosting the relay

Only the host needs this. The relay is one Node.js file with no dependencies.
Use Node.js 24 or newer.

### Same Wi-Fi

On the host PC:

```bash
node freejam-relay.js
```

The relay prints a LAN address such as `ws://192.168.x.x:8787`. Paste that into
FreeJam. Allow Node through the firewall if Windows asks. This only works while
everyone is on the same network and the host PC is awake.

### Internet

If everyone is not on the same network, put the relay behind a TLS tunnel.
Cloudflare Quick Tunnel is the easiest option:

```bash
# terminal 1
node freejam-relay.js

# terminal 2
cloudflared tunnel --url http://localhost:8787
```

Use the `wss://...trycloudflare.com` address that Cloudflare prints. The URL
changes when the tunnel restarts, so start a fresh jam and share the new relay
address if that happens.

For a stable address, use a named Cloudflare Tunnel, a VPS with Caddy or nginx,
or a Docker host. The final address must start with `wss://` when it leaves your
machine.

### Keep it running

Linux with systemd:

```bash
sudo cp freejam-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now freejam-relay
```

Edit the unit first if your paths differ. It assumes the relay lives in
`/home/freejam/freejam`, runs as the `freejam` user, and binds to
`127.0.0.1` for use behind a tunnel.

On Windows, use Task Scheduler or NSSM. Docker works too:

```bash
docker build -t freejam-relay .
docker run -d --restart unless-stopped -p 8787:8787 freejam-relay
```

Change the publish side to `-p 127.0.0.1:8787:8787` when the relay only needs to
be reachable through a tunnel.

The relay keeps everything in memory. Restarting it drops active sessions.

### Check it

```bash
curl http://127.0.0.1:8787/health
```

You should see `FreeJam relay is running.`

## Start a jam (host)

1. Open the FreeJam panel.
2. Paste the relay address into **Playback sync**.
3. Enter your name and click **Start sync**.
4. Click **Copy join code** and send the `FJ1...` code to everyone.

## Join a jam (guest)

1. Open the FreeJam panel.
2. Paste the `FJ1...` code into **Join a sync session**.
3. Enter your name and click **Join sync**.

The status line shows the host, member count and latency. The panel updates live
as people join or leave.

## Controls

- **Previous / Play-Pause / Next**
- Seek slider
- **Resync** (guest) — request the host's current state
- **Leave sync**
- **Kick** (host) — remove one guest

Spotify's own controls work too. Pausing, playing, skipping or dragging
Spotify's seek bar is detected and forwarded. The FreeJam slider is the exact
path; native seek detection is best-effort.

## Join codes

A join code looks like `FJ1.<base64url>` and contains the relay address, session
id and guest session key. Treat it like a room password.

The host also has a separate host credential that is stored only on the host
device. It is never included in a join code, so a guest cannot take over as
host.

## How sync works

FreeJam is host-authoritative:

- The host broadcasts the current track, playhead and pause state.
- A guest sends a command (`track`, `next`, `prev`, `seek`, `pause`, `play`).
- The host applies it and broadcasts the result.
- A guest that skips or picks a song sends the exact track URI, so everyone
  lands on the same song.

FreeJam compensates for latency and ignores its own echo. Very small native
seeks may be corrected by the host's next state update.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| No FreeJam button | Confirm `extensions = freejam.js` in `config-xpui.ini`, run `spicetify apply`, restart Spotify. |
| Guest stuck on "Waiting for the host" | The host is not connected, or the code is from a different session. Re-send the code. |
| "The session key is wrong" | The code was truncated or belongs to another session. Copy the whole code. |
| "Could not open the relay connection" | Check the relay URL, port, firewall, and that the relay is running. |
| Sync drifts | Click **Resync**. Check the latency shown in the status line. |
| Host gets `4005` | Another device used the same host credential. Use one host device, or start a fresh session. |
| `/health` works but FreeJam cannot connect | The WebSocket upgrade is blocked. Check the proxy's `Upgrade` and `Connection` headers. |
| Relay address changed | The tunnel restarted. Start a fresh session and share the new address. |

## Security and privacy

- Use `wss://` for any relay that leaves your machine. `ws://` is only for a
  trusted LAN or private VPN.
- The relay can read the messages it forwards. There is no end-to-end
  encryption.
- The host credential stays on the host device. Join codes contain only the
  guest session key.
- The relay never contacts Spotify, never stores playback history, and never
  writes messages to disk.
- Only share join codes with people you trust. A guest can change playback
  through the host.

## Files

| File | Purpose |
| --- | --- |
| `freejam.js` | The Spicetify extension. |
| `freejam-relay.js` | The relay. Only the host runs it. |
| `freejam-relay.service` | systemd unit for the relay. |
| `freejam-tunnel.service` | systemd unit for a Cloudflare Quick Tunnel. |
| `Dockerfile` | Container image for the relay. |

## Development

Both JavaScript files are plain Node/browser JavaScript. Syntax-check them with:

```bash
node --check freejam.js
node --check freejam-relay.js
```

There is no build step. To test the relay:

```bash
node freejam-relay.js
curl http://127.0.0.1:8787/health
```

## License

MIT
