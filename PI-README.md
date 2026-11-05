# FreeJam on this Raspberry Pi

This Pi is set up as the **always-on relay** for FreeJam sync mode and friend
alerts. It does not run Spotify; the host's PC still runs Spotify + FreeJam and
owns playback.

## Current relay address

```
wss://random-words-here.trycloudflare.com
```

Paste that into FreeJam's relay field on the host, click **Start sync**, and send
the resulting `FJ1...` join code to your friend. Use the same URL in the Friends
card so friend mailboxes work.

This is a Cloudflare **quick tunnel**. The URL stays the same while the tunnel
keeps running, but it changes if `cloudflared` restarts or the Pi reboots. To get
the current URL at any time:

```bash
freejam-url
# or: ~/freejam/show-url.sh
```

## Services

Both services are enabled and start automatically at boot:

| Service | Purpose |
| --- | --- |
| `freejam-relay.service` | WebSocket relay on `127.0.0.1:8787` |
| `freejam-tunnel.service` | Cloudflare quick tunnel to the relay |

Useful commands:

```bash
systemctl status freejam-relay freejam-tunnel
journalctl -u freejam-relay -f
journalctl -u freejam-tunnel -f
sudo systemctl restart freejam-relay freejam-tunnel
```

The relay is bound to `127.0.0.1` on purpose. The only way in is through the
Cloudflare tunnel, so no port forwarding or router changes are needed.

## Updating the relay

From the FreeJam repo on the host PC:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy-relay.ps1 -PiHost <pi-address>
```

Or set `FREEJAM_PI_HOST` once and let the `post-merge` git hook deploy it
automatically after `git pull`:

```powershell
$env:FREEJAM_PI_HOST = "192.168.x.x"
git pull
```

The relay must be restarted after every `freejam-relay.js` change. Friend
mailboxes are part of the current relay; an old relay will reject friend
connections.

## If the URL changes

After a reboot or a tunnel restart:

```bash
freejam-url
```

Send the new `wss://...` URL / new `FJ1...` code to your friend. In the Friends
card, click **Save relay** with the new URL, then copy your friend code again so
friends update theirs.

## Stable URL (optional)

A named Cloudflare Tunnel with your own domain gives a permanent hostname such as
`wss://relay.example.com`. That requires a Cloudflare account and a domain. See
`PI-SETUP.md` for the exact steps. Everything else stays the same.

## Files

| File | What it is |
| --- | --- |
| `freejam-relay.js` | dependency-free relay server |
| `freejam.js` | Spicetify extension (for the host/friend PCs, not the Pi) |
| `freejam-relay.service` | systemd unit for the relay |
| `freejam-tunnel.service` | systemd unit for the quick tunnel |
| `show-url.sh` | prints the current URL and checks health (if installed) |
| `PI-SETUP.md` | full setup and troubleshooting guide |
| `DEPLOY.md` / `README.md` | project documentation |

## Notes

- Node: `/usr/bin/node` v18.20.4 (system package).
- Relay user: `freejam`.
- Relay port: `8787` (loopback only).
- The relay does not store playback history. It keeps a small per-user mailbox
  for friend alerts, including one pending alert while a friend is offline (up
  to 12 hours).
- The `FJ1...` code is a room password, not strong authentication. Share it only
  with people you want in the session.
- A friend code contains a mailbox send key, not the owner's private receive
  key. The relay never broadcasts a jam to everyone.
