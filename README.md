# FreeJam

A Spicetify extension that gives free Spotify accounts a Jam-style shared
listening session without calling Spotify's Premium-only Jam endpoints and
without bypassing any paywall.

FreeJam has two independent modes:

| Mode | Guests need FreeJam? | What it does |
| --- | --- | --- |
| **Request mode** | No | A normal collaborative playlist acts as a request inbox. New songs guests add are queued on the host's device. |
| **Sync mode** | Yes | Host-authoritative playback sync over a tiny relay. Skips, seeks and play/pause from any participant are applied for everyone. |
| **Friends** | Yes | A private alert when someone you added starts a jam. Only added friends can reach your mailbox; nothing is broadcast to everyone. |

Both modes work on free accounts. FreeJam is a cooperative third-party player,
not Spotify Jam.

## Files

- `freejam.js` — the Spicetify extension (loads in every Spotify client).
- `freejam-relay.js` — dependency-free Node.js WebSocket relay used by sync mode
  and friend mailboxes.
- `scripts/sync-to-spicetify.ps1` — copies the extension into Spicetify and
  applies it.
- `hooks/post-merge` — git hook that runs the sync script after a pull.
- `README.md` — this file. See also `DEPLOY.md` and `PI-SETUP.md`.

## Install the extension

1. Copy `freejam.js` into your Spicetify **Extensions** folder
   (`%APPDATA%\spicetify\Extensions` on Windows).
2. Add it to `config-xpui.ini`:
   ```ini
   [AdditionalOptions]
   extensions = freejam.js
   ```
3. Run `spicetify apply` and restart Spotify.

A **FreeJam** button appears in the playbar. Click it to open the panel.

## Updating (automatic)

The repo includes a `post-merge` hook that copies `freejam.js` into Spicetify,
enables it if needed, and runs `spicetify apply` after every pull. Install the
hook once:

```powershell
cd C:\Users\<your-name>\freejam
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-git-hooks.ps1
```

After that, updating is just:

```powershell
cd C:\Users\<your-name>\freejam
git pull
```

The hook only runs when `freejam.js` changed, and `spicetify apply` restarts
Spotify so the new version loads immediately. A `pre-push` hook does the same
when you push from this repo. If you do not want Spotify to restart, set
`FREEJAM_NO_RESTART=1` before pulling or pushing:

```powershell
$env:FREEJAM_NO_RESTART = "1"
git pull
```

To preview what the hook would do:

```powershell
$env:FREEJAM_DRY_RUN = "1"
git pull
```

The Pi relay is a separate machine. If `freejam-relay.js` changes, the same
post-merge hook can deploy it automatically when `FREEJAM_PI_HOST` is set:

```powershell
$env:FREEJAM_PI_HOST = "192.168.x.x"
$env:FREEJAM_PI_USER = "freejam"          # optional
$env:FREEJAM_PI_DIR = "~/freejam"          # optional
$env:FREEJAM_PI_SERVICE = "freejam-relay"  # optional
git pull
```

Or run the deploy script directly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy-relay.ps1 -PiHost 192.168.x.x
```

If the Pi is offline, the script prints a warning and does not block the pull.
Without `FREEJAM_PI_HOST`, relay changes are skipped. The manual fallback is:

```bash
scp freejam-relay.js user@<pi-host>:~/freejam/
ssh user@<pi-host> "sudo systemctl restart freejam-relay"
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

### 1. Run the relay

The relay is a single file with no dependencies. Run it on the host machine or
on any machine everyone can reach:

```bash
node freejam-relay.js
```

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on. |
| `HOST` | `0.0.0.0` | Interface to bind. |

The relay prints the addresses to use, for example:

```
FreeJam relay listening on ws://0.0.0.0:8787
  LAN address: ws://192.168.x.x:8787
  LAN address: ws://192.168.x.x:8787
```

- **Same Wi-Fi / LAN:** use the `192.168.x.x` address.
- **Internet (different networks):** the relay must be reachable publicly
  with TLS, so use a `wss://` URL. Do not expose a bare `ws://` relay to the
  internet. Two free options:
  - **Render:** deploy the included `FreeJam-deploy` folder as a Node web
    service and use `wss://<name>.onrender.com`.
  - **Cloudflare Quick Tunnel:** run the relay, then
    `cloudflared tunnel --url http://localhost:8787`, and use
    `wss://<random>.trycloudflare.com`.
  See `DEPLOY.md` for step-by-step instructions, including a VPS/Caddy setup.
  FreeJam converts a pasted `https://` URL to `wss://` automatically.
- **Raspberry Pi / home server:** a Pi 5 is more than enough to run the relay
  24/7. See `PI-SETUP.md` for Node.js, `systemd`, and Cloudflare Tunnel setup.

### 2. Host

1. Open the FreeJam panel.
2. Under **Playback sync**, paste the relay URL (for example
   `wss://your-relay.onrender.com` over the internet, or
   `ws://192.168.x.x:8787` on the same Wi-Fi).
3. Enter your name and click **Start sync**.
4. Copy the **FJ1…** join code and send it to your friends.

### 3. Guest

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
Treat it like a room password.

---

## Friends and jam alerts

The Friends card lets you get a Spotify notification when someone you added
starts a jam, and join it in one click.

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
  Spotify (for up to 12 hours).

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

Everyone must use the **same relay** for friend mailboxes to work. If you change
the relay URL, copy your friend code again so friends can update it.

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

## Security

The relay is a dumb message forwarder for playback and a mailbox for jam
alerts. It is safe to run on a LAN or expose publicly behind TLS, as long as
the join code and friend codes are only shared with people you trust.

- The session key is a **room password**, not strong authentication.
- Only a host can create a room, so a guest cannot squat a session id.
- Only the host can broadcast state; only guests can send commands.
- A friend code contains a mailbox **send key**, not the owner's private
  receive key. It lets that friend send a jam alert, not read the mailbox.
- A mailbox only accepts a DM whose send key matches the mailbox's registered
  key. The extension additionally drops alerts from senders not in your local
  friend list.
- Messages are capped in size and rate-limited.
- For use over the internet, terminate TLS in front of the relay (Render,
  Caddy, nginx, Cloudflare Tunnel, etc.) and give people a `wss://` URL.

## Limitations

- Sync mode requires FreeJam on every participant. There is no way to make a
  free account follow another device's playhead using Spotify's own APIs.
- Request mode only queues songs; it does not sync playback.
- Native seeks are detected by comparing the playhead against the expected
  position every 500 ms. Very small seeks may be corrected by the host's next
  state broadcast; use the FreeJam slider for precise seeks.
- Free accounts hear ads locally. Everyone re-converges after the ad.
- Friend alerts need FreeJam on both devices and the same relay.
- Spotify has no public direct-message API. FreeJam copies an invite message
  for you to paste; it cannot post into Spotify's in-app messages.
- The extension uses Spicetify's player APIs, so Spotify UI changes can require
  an update.

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

## Development

Both files are plain JavaScript and can be syntax-checked with:

```bash
node --check freejam.js
node --check freejam-relay.js
```

The relay has no dependencies. The extension expects the Spicetify global
(`Spicetify.Player`, `Spicetify.Platform.PlaylistAPI`,
`Spicetify.Platform.PlaylistPermissionsAPI`, `Spicetify.Playbar`,
`Spicetify.PopupModal`, `Spicetify.LocalStorage`).
