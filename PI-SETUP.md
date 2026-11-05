# Hosting the FreeJam relay on a Raspberry Pi

The relay is one Node.js file with no dependencies. A Raspberry Pi 5 is far more
than enough: it uses a few MB of RAM and almost no CPU, and it can run 24/7.

The only hard requirement is that guests can reach the relay over the internet
with **TLS**, so the extension gets a `wss://` URL. Do **not** expose a bare
`ws://` port to the internet.

Recommended setup:

```
Spotify guest ──wss://──> Cloudflare ──tunnel──> cloudflared ──> relay on 127.0.0.1:8787
```

Cloudflare Tunnel works without a public IP or router port forwarding, including
behind CGNAT. No inbound ports need to be opened on your network.

---

## 1. Install Node.js 18+ on the Pi

Check the version:

```bash
node -v
```

If it is missing or older than 18, install Node 20:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

`aarch64` / ARM64 is fully supported.

## 2. Copy the relay to the Pi

From your PC (replace the hostname and user as needed):

```bash
scp freejam-relay.js package.json pi@raspberrypi.local:~/freejam/
```

Or create the folder and copy the file however you prefer:

```bash
mkdir -p ~/freejam
```

## 3. Test it manually

```bash
cd ~/freejam
HOST=127.0.0.1 node freejam-relay.js
```

In another terminal:

```bash
curl http://127.0.0.1:8787/health
```

You should see `FreeJam relay is running.` Stop it with `Ctrl+C`; the systemd
service below will keep it running in the background.

`HOST=127.0.0.1` means the relay is only reachable from the Pi itself. That is
what you want when Cloudflare Tunnel is in front of it. If you also want to use
it on your LAN, use `HOST=0.0.0.0` and allow port `8787` in the firewall.

## 4. Run the relay as a service

Copy the included unit file:

```bash
sudo cp freejam-relay.service /etc/systemd/system/freejam-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now freejam-relay
```

Check it:

```bash
systemctl status freejam-relay
journalctl -u freejam-relay -n 30 --no-pager
```

The unit assumes:

- the relay lives in `/home/pi/freejam`
- Node is at `/usr/bin/node`
- the service runs as user `pi`

Edit the unit if your paths or user differ. If you installed Node with `nvm`,
use the output of `which node` for `ExecStart`.

---

## 5. Put Cloudflare Tunnel in front

You have two choices.

### Option A — Quick Tunnel (no account, no domain)

Good for trying it out. The URL changes whenever `cloudflared` restarts, so the
join code changes too.

Install `cloudflared` on the Pi (ARM64):

```bash
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cloudflared-linux-arm64.deb
cloudflared --version
```

Run it manually first:

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

It prints a URL like:

```
https://random-words-here.trycloudflare.com
```

Use this in FreeJam:

```
wss://random-words-here.trycloudflare.com
```

To keep it running after logout, use the included quick-tunnel unit:

```bash
sudo cp freejam-tunnel.service /etc/systemd/system/freejam-tunnel.service
sudo systemctl daemon-reload
sudo systemctl enable --now freejam-tunnel
```

The unit expects `cloudflared` at `/usr/bin/cloudflared` (where the .deb installs
it). Check with `which cloudflared` and edit `ExecStart` if yours is elsewhere.

Read the current URL from the log:

```bash
journalctl -u freejam-tunnel -n 50 --no-pager | grep trycloudflare
```

Quick tunnels are intended for testing rather than production, and the URL
changes on restart. For a stable address, use Option B.

### Option B — Named Tunnel (stable URL, needs a domain)

You need a domain whose DNS is managed by Cloudflare (the free plan is enough).

1. Authorize `cloudflared` on the Pi:

   ```bash
   cloudflared tunnel login
   ```

   On a headless Pi it prints a URL. Open that URL on your phone or PC, log in
   to Cloudflare, and authorize the domain. The certificate is saved to
   `~/.cloudflared/cert.pem`.

2. Create the tunnel:

   ```bash
   cloudflared tunnel create freejam
   ```

   Note the tunnel UUID it prints.

3. Create `~/.cloudflared/config.yml`:

   ```yaml
   tunnel: <TUNNEL-UUID>
   credentials-file: /home/pi/.cloudflared/<TUNNEL-UUID>.json

   ingress:
     - hostname: relay.example.com
       service: http://127.0.0.1:8787
     - service: http_status:404
   ```

   Replace `relay.example.com` with the hostname you want, and the UUID with
   the one from step 2. The hostname must be on the domain you authorized.

4. Create the DNS record:

   ```bash
   cloudflared tunnel route dns freejam relay.example.com
   ```

5. Install and start the service:

   ```bash
   sudo cloudflared --config /home/pi/.cloudflared/config.yml service install
   sudo systemctl enable --now cloudflared
   ```

6. Test it:

   ```bash
   curl https://relay.example.com/health
   ```

7. In FreeJam use:

   ```
   wss://relay.example.com
   ```

The hostname is stable across reboots and tunnel restarts, so the join code
stays valid until the session key is regenerated.

---

## 6. Start a session

On your own machine:

1. Open FreeJam.
2. Paste the relay URL:
   - named tunnel: `wss://relay.example.com`
   - quick tunnel: `wss://random-words.trycloudflare.com`
3. Click **Start sync**.
4. Copy the `FJ1...` join code and send it to your friend.

The Pi only runs the relay. The host still needs Spotify and FreeJam open, just
like before.

---

## Security notes

- The relay does not store playback history. It keeps one small mailbox per
  user so a friend's jam alert can wait for them offline (up to 12 hours), then
  deletes the pending alert.
- A friend code contains a mailbox send key, not the owner's private receive
  key. The relay never broadcasts a jam to all users.
- Bind it to `127.0.0.1` when Cloudflare Tunnel is the only way in.
- The `FJ1...` key is a room password, not strong authentication. Only share it
  with people you trust.
- Keep `cloudflared` updated (`sudo apt update && sudo apt upgrade` or reinstall
  the .deb).
- Do not forward port `8787` directly to the internet without TLS.

## Updating the relay

From the FreeJam repo on your PC:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy-relay.ps1 -PiHost <pi-address>
```

This copies `freejam-relay.js` to `~/freejam` and restarts the service. The
`post-merge` git hook runs the same script automatically when
`FREEJAM_PI_HOST` is set.

## Troubleshooting

**`node: command not found`**
Install Node.js, or fix the `ExecStart` path in the unit file.

**`systemctl status freejam-relay` shows a restart loop**
Run the relay manually with the same environment to see the error:

```bash
cd /home/pi/freejam
HOST=127.0.0.1 PORT=8787 node freejam-relay.js
```

**Cloudflare returns 502 / 1033**
`cloudflared` cannot reach the relay. Check that the relay is running and that
`config.yml` points to `http://127.0.0.1:8787`.

**Quick tunnel URL changed after reboot**
That is expected. Get the new URL from `journalctl -u freejam-tunnel` and send a
fresh join code, or switch to a named tunnel for a stable hostname.

**Guests cannot connect**
Confirm `curl https://<your-url>/health` works from outside your network, and
that you used `wss://`, not `ws://`.
