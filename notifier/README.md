# FreeJam background notifier

The FreeJam extension shows native Windows and macOS notifications while
Spotify is running, including when it is minimized. This optional helper covers
the one case the extension cannot: **Spotify is fully quit**.

The notifier is a tiny Node.js script. It connects to the same private friend
mailbox as FreeJam and shows an OS notification when someone you added starts a
jam. It has no npm dependencies.

## Requirements

- Node.js 18 or newer.
- The same relay URL and friend list as the FreeJam extension.
- A notifier setup code from FreeJam (see below).

## Get the setup code

1. Open Spotify and the FreeJam panel.
2. Open **Settings** at the bottom of the panel.
3. Under **Alerts while Spotify is closed**, click **Copy setup code**.

The code starts with `FJN1.`. It contains your **private receive key**, so treat
it like a password. Do not paste it into a chat, issue, or public site.

Re-copy the code after you add or remove a friend, or after changing the
**Ding sound** setting. The notifier filters alerts against the friend list and
sound setting that were in the code.

## Windows

1. Install Node.js 18+ from <https://nodejs.org/>.
2. Open PowerShell in this folder.
3. Run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install-notifier.ps1
   ```

4. Paste the `FJN1...` code when asked.
5. The installer copies the notifier to `%APPDATA%\FreeJam\notifier`, saves the
   config, and adds a startup shortcut so it runs at login.

To test it immediately:

```powershell
node "$env:APPDATA\FreeJam\notifier\freejam-notifier.js" --test
```

Windows shows the alert as a notification-area balloon. If nothing appears,
check **Settings → System → Notifications** and Focus Assist / Do Not Disturb.

## macOS

1. Install Node.js 18+ from <https://nodejs.org/>.
2. Open Terminal in this folder.
3. Run:

   ```bash
   bash install-notifier-macos.sh
   ```

4. Paste the `FJN1...` code when asked.
5. The installer copies the notifier to
   `~/Library/Application Support/FreeJam/notifier`, saves the config, and
   creates a LaunchAgent at
   `~/Library/LaunchAgents/com.freejam.notifier.plist`.

To test it immediately:

```bash
node "$HOME/Library/Application Support/FreeJam/notifier/freejam-notifier.js" --test
```

macOS may ask you to allow notifications for Terminal, iTerm, or Script Editor.
If no alert appears, open **System Settings → Notifications** and allow the app
that runs `osascript`.

## Uninstall

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall-notifier.ps1
```

macOS:

```bash
bash uninstall-notifier-macos.sh
```

Add `-KeepConfig` (Windows) or `--keep-config` (macOS) if you want to keep the
saved setup code.

## Privacy and security

- The config contains your `recvKey`, the private key that authenticates your
  mailbox. Anyone with it can read your jam alerts. Keep it on your own device.
- The config is written with user-only permissions on macOS and Linux. On
  Windows it lives in your user profile.
- The notifier only notifies for user IDs in the friend list embedded in the
  setup code. A stranger who guesses your user id still cannot deliver an alert
  without your `sendKey`.
- The notifier does not read playback history, playlists, or Spotify account
  data.
- The relay stores mailboxes and pending alerts in memory. A relay restart
  drops pending alerts.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `Node.js 18 or newer is required` | Install Node.js and reopen the terminal. |
| `The setup code is missing relay details` | Copy a fresh `FJN1...` code from FreeJam. |
| `The relay rejected the receive key` | The friend identity was recreated. Copy a fresh code. |
| No notification while Spotify is closed | Check that the notifier is running: Windows Task Manager → `node.exe`, or macOS `launchctl list \| grep freejam`. |
| Notifications work, but not for a new friend | Re-copy the setup code and run the installer again. |
| No sound | Check the OS volume and notification sound settings. The notifier generates `ding.wav` next to its config; you can replace it with any WAV file. |
| Duplicate alerts | The relay suppresses the notifier while the Spotify app is connected. If you see duplicates, update `freejam-relay.js` on the relay. |

## Run manually

```bash
node freejam-notifier.js --config /path/to/notifier.json
```

Useful flags:

- `--install FJN1...` save a setup code
- `--test` show a test notification
- `--uninstall` remove the saved config
- `--help` show usage
