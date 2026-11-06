#!/usr/bin/env node
/*
 * FreeJam background notifier — native desktop alerts when Spotify is closed.
 *
 * The Spicetify extension can already raise a Windows/macOS notification while
 * Spotify is running, even minimized. This small helper is for the remaining
 * case: Spotify is fully quit. It connects to the same friend mailbox as the
 * extension and shows an OS notification when an added friend starts a jam.
 *
 * It needs Node.js 18 or newer and has no npm dependencies.
 *
 * Usage:
 *   node freejam-notifier.js --install FJN1...
 *   node freejam-notifier.js --test
 *   node freejam-notifier.js
 *
 * The setup code is created by the FreeJam extension. It contains your private
 * receive key, so treat it like a password and only install it on your own
 * device.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { spawn } = require("child_process");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const CODE_PREFIX = "FJN1.";
const MAX_BUFFER = 1024 * 1024;
const PING_INTERVAL_MS = 30000;
const MAX_SEEN_JAMS = 100;

let configPath = "";
let dingPath = "";

// ---------------------------------------------------------------------------
// Config and setup codes
// ---------------------------------------------------------------------------

function defaultConfigPath() {
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || os.homedir(),
      "FreeJam",
      "notifier.json"
    );
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "FreeJam",
      "notifier.json"
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "freejam",
    "notifier.json"
  );
}

function normalizeRelayUrl(input) {
  let value = String(input || "").trim();
  if (!value) return "";
  if (/^https:\/\//i.test(value)) value = `wss://${value.slice(8)}`;
  else if (/^http:\/\//i.test(value)) value = `ws://${value.slice(7)}`;
  else if (!/^wss?:\/\//i.test(value)) value = `ws://${value}`;
  return value.replace(/\/+$/, "");
}

function decodeSetupCode(code) {
  const value = String(code || "").trim();
  if (!value.startsWith(CODE_PREFIX)) {
    throw new Error(`The setup code must start with ${CODE_PREFIX}.`);
  }

  const raw = value
    .slice(CODE_PREFIX.length)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);

  let payload;
  try {
    payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    throw new Error("The setup code is not valid base64 JSON.");
  }

  if (!payload || payload.v !== 1) {
    throw new Error("Unsupported notifier setup code version.");
  }
  if (
    typeof payload.u !== "string" ||
    typeof payload.id !== "string" ||
    typeof payload.rk !== "string" ||
    !payload.u ||
    !payload.id ||
    !payload.rk
  ) {
    throw new Error("The setup code is missing relay details.");
  }

  const relayUrl = normalizeRelayUrl(payload.u);
  if (!/^wss?:\/\//i.test(relayUrl)) {
    throw new Error("The setup code has an invalid relay URL.");
  }

  return {
    version: 1,
    relayUrl,
    userId: payload.id,
    recvKey: payload.rk,
    name:
      typeof payload.n === "string" && payload.n.trim()
        ? payload.n.trim().slice(0, 64)
        : "FreeJam",
    friends: Array.isArray(payload.f)
      ? payload.f
          .filter((id) => typeof id === "string" && id)
          .slice(0, 200)
      : [],
    sound: payload.snd !== 0,
  };
}

function loadConfig(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not read ${file}: ${err.message}`);
  }

  if (!parsed || parsed.version !== 1) {
    throw new Error("Unsupported notifier config version.");
  }
  if (
    typeof parsed.relayUrl !== "string" ||
    typeof parsed.userId !== "string" ||
    typeof parsed.recvKey !== "string" ||
    !parsed.relayUrl ||
    !parsed.userId ||
    !parsed.recvKey
  ) {
    throw new Error("The notifier config is missing relay details.");
  }

  return {
    version: 1,
    relayUrl: normalizeRelayUrl(parsed.relayUrl),
    userId: parsed.userId,
    recvKey: parsed.recvKey,
    name: typeof parsed.name === "string" ? parsed.name.slice(0, 64) : "FreeJam",
    friends: Array.isArray(parsed.friends)
      ? parsed.friends
          .filter((id) => typeof id === "string" && id)
          .slice(0, 200)
      : [],
    sound: parsed.sound !== false,
  };
}

function saveConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows ignores POSIX modes. */
  }
}

// ---------------------------------------------------------------------------
// A tiny dependency-free WebSocket client
// ---------------------------------------------------------------------------

function createWebSocket(rawUrl, handlers) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    handlers.onClose(0, "Invalid relay URL");
    return null;
  }

  const secure =
    parsed.protocol === "wss:" || parsed.protocol === "https:";
  if (
    parsed.protocol !== "ws:" &&
    parsed.protocol !== "wss:" &&
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:"
  ) {
    handlers.onClose(0, "Unsupported relay URL protocol");
    return null;
  }

  const key = crypto.randomBytes(16).toString("base64");
  const request = (secure ? https : http).request({
    protocol: secure ? "https:" : "http:",
    hostname: parsed.hostname,
    port: parsed.port || (secure ? 443 : 80),
    path: `${parsed.pathname || "/"}${parsed.search || ""}`,
    method: "GET",
    headers: {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": key,
      "Sec-WebSocket-Version": "13",
      "User-Agent": "FreeJam-Notifier/1.0",
    },
  });

  let settled = false;
  const fail = (err) => {
    if (settled) return;
    settled = true;
    try {
      request.destroy();
    } catch {
      /* ignore */
    }
    handlers.onClose(0, (err && err.message) || "Connection failed");
  };

  request.on("upgrade", (res, socket, head) => {
    const expected = crypto
      .createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");
    if (res.headers["sec-websocket-accept"] !== expected) {
      socket.destroy();
      fail(new Error("Bad WebSocket handshake"));
      return;
    }

    settled = true;
    const ws = new RelaySocket(socket, handlers);
    handlers.onOpen(ws);
    if (head && head.length) ws.feed(head);
  });

  request.on("response", (res) => {
    res.resume();
    fail(new Error(`Relay rejected the connection (HTTP ${res.statusCode})`));
  });

  request.on("error", fail);
  request.end();

  return {
    close() {
      try {
        request.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

class RelaySocket {
  constructor(socket, handlers) {
    this.socket = socket;
    this.handlers = handlers;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;

    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.on("data", (chunk) => this.feed(chunk));
    socket.on("close", () => this.finish(1006, "Connection closed"));
    socket.on("end", () => this.finish(1006, "Connection ended"));
    socket.on("error", (err) => {
      this.handlers.onError(err);
      this.finish(1006, err.message);
    });
  }

  feed(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_BUFFER) {
      this.close(1009, "Message too large");
      return;
    }
    this.parse();
  }

  parse() {
    let offset = 0;

    while (offset + 2 <= this.buffer.length) {
      const b1 = this.buffer[offset];
      const b2 = this.buffer[offset + 1];
      const fin = (b1 & 0x80) !== 0;
      const opcode = b1 & 0x0f;
      const masked = (b2 & 0x80) !== 0;
      let length = b2 & 0x7f;
      let headerLength = 2;

      if (length === 126) {
        if (offset + 4 > this.buffer.length) break;
        length = this.buffer.readUInt16BE(offset + 2);
        headerLength = 4;
      } else if (length === 127) {
        if (offset + 10 > this.buffer.length) break;
        const bigLength = this.buffer.readBigUInt64BE(offset + 2);
        if (bigLength > BigInt(MAX_BUFFER)) {
          this.close(1009, "Frame too large");
          return;
        }
        length = Number(bigLength);
        headerLength = 10;
      }

      if (length > MAX_BUFFER) {
        this.close(1009, "Frame too large");
        return;
      }

      let maskKey = null;
      if (masked) {
        if (offset + headerLength + 4 > this.buffer.length) break;
        maskKey = this.buffer.subarray(
          offset + headerLength,
          offset + headerLength + 4
        );
        headerLength += 4;
      }

      if (offset + headerLength + length > this.buffer.length) break;

      let payload = this.buffer.subarray(
        offset + headerLength,
        offset + headerLength + length
      );
      if (masked) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      offset += headerLength + length;
      this.handleFrame(opcode, fin, payload);
    }

    this.buffer = this.buffer.subarray(offset);
  }

  handleFrame(opcode, fin, payload) {
    if (opcode === 0x8) {
      let code = 1000;
      let reason = "";
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        reason = payload.subarray(2).toString("utf8");
      }
      this.finish(code, reason);
      return;
    }

    if (opcode === 0x9) {
      this.sendFrame(0xa, payload);
      return;
    }

    if (opcode === 0xa) return;

    if (opcode === 0x1 || opcode === 0x2) {
      this.fragments = [payload];
      this.fragmentOpcode = opcode;
      if (fin) this.emitMessage();
      return;
    }

    if (opcode === 0x0) {
      if (this.fragmentOpcode) {
        this.fragments.push(payload);
        if (fin) this.emitMessage();
      }
    }
  }

  emitMessage() {
    const payload = Buffer.concat(this.fragments);
    const opcode = this.fragmentOpcode;
    this.fragments = [];
    this.fragmentOpcode = 0;
    if (opcode === 0x1) {
      this.handlers.onMessage(payload.toString("utf8"));
    }
  }

  sendFrame(opcode, payload) {
    if (this.closed) return false;
    try {
      this.socket.write(encodeClientFrame(opcode, payload));
      return true;
    } catch (err) {
      this.handlers.onError(err);
      return false;
    }
  }

  send(message) {
    return this.sendFrame(
      0x1,
      Buffer.from(JSON.stringify(message), "utf8")
    );
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    const reasonBuffer = Buffer.from(String(reason).slice(0, 123), "utf8");
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    this.sendFrame(0x8, payload);
    this.finish(code, reason);
  }

  finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    this.handlers.onClose(code, reason);
  }
}

function encodeClientFrame(opcode, payload) {
  const length = payload.length;
  const mask = crypto.randomBytes(4);
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) {
    masked[i] = payload[i] ^ mask[i % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

// ---------------------------------------------------------------------------
// Notification sound
// ---------------------------------------------------------------------------

function buildDingWav() {
  const sampleRate = 44100;
  const duration = 0.9;
  const total = Math.floor(sampleRate * duration);
  const data = Buffer.alloc(total * 2);

  // A soft bell chord: C5 warmth, C6 lead, G6 sparkle, C7 shimmer.
  const notes = [
    { freq: 523.25, start: 0, dur: 0.42, gain: 0.12 },
    { freq: 1046.5, start: 0, dur: 0.55, gain: 0.34 },
    { freq: 1567.98, start: 0.085, dur: 0.66, gain: 0.26 },
    { freq: 2093.0, start: 0.085, dur: 0.38, gain: 0.07 },
  ];

  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    let sample = 0;

    for (const note of notes) {
      if (t < note.start || t > note.start + note.dur) continue;
      const local = t - note.start;
      const attack = Math.min(1, local / 0.008);
      const decay = Math.exp(-local * 6.5);
      sample +=
        Math.sin(2 * Math.PI * note.freq * local) *
        note.gain *
        attack *
        decay;
    }

    sample = Math.tanh(sample * 1.2) * 0.8;
    const value = Math.max(-1, Math.min(1, sample));
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

function ensureDingFile() {
  if (dingPath) return dingPath;
  const file = path.join(path.dirname(configPath), "ding.wav");
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < 1000) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buildDingWav(), { mode: 0o600 });
    }
    dingPath = file;
    return file;
  } catch (err) {
    console.error(`[FreeJam] Could not create ding.wav: ${err.message}`);
    return "";
  }
}

function spawnDetached(command, args, options = {}) {
  try {
    const child = spawn(
      command,
      args,
      Object.assign(
        {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        },
        options
      )
    );
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Platform notifications
// ---------------------------------------------------------------------------

function notify(title, body, options = {}) {
  if (process.platform === "win32") {
    notifyWindows(title, body, options);
  } else if (process.platform === "darwin") {
    notifyMac(title, body, options);
  } else {
    notifyLinux(title, body, options);
  }
}

function notifyWindows(title, body, options) {
  const titleB64 = Buffer.from(title, "utf8").toString("base64");
  const bodyB64 = Buffer.from(String(body).slice(0, 240), "utf8").toString(
    "base64"
  );
  const wav = options.sound ? ensureDingFile() : "";
  const wavLiteral = wav ? `'${wav.replace(/'/g, "''")}'` : "";
  const soundLine = wavLiteral
    ? `try { (New-Object System.Media.SoundPlayer ${wavLiteral}).PlaySync() } catch {}`
    : "";

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${titleB64}'))
$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${bodyB64}'))
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.BalloonTipTitle = $title
$n.BalloonTipText = $body
$n.Visible = $true
$n.Add_BalloonTipClicked({ try { Start-Process 'spotify:' } catch {} })
$n.ShowBalloonTip(10000)
${soundLine}
for ($i = 0; $i -lt 100; $i++) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 100
}
$n.Visible = $false
$n.Dispose()
`;

  spawnDetached("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-Command",
    script,
  ]);
}

function notifyMac(title, body, options) {
  spawnDetached(
    "osascript",
    [
      "-e",
      'display notification (system attribute "FJ_BODY") with title (system attribute "FJ_TITLE")',
    ],
    {
      env: Object.assign({}, process.env, {
        FJ_TITLE: title,
        FJ_BODY: body,
      }),
    }
  );

  if (options.sound) {
    const wav = ensureDingFile();
    if (wav) spawnDetached("afplay", [wav]);
  }
}

function notifyLinux(title, body, options) {
  spawnDetached("notify-send", ["--app-name=FreeJam", title, body]);

  if (options.sound) {
    const wav = ensureDingFile();
    if (wav) {
      if (!spawnDetached("paplay", [wav])) {
        spawnDetached("aplay", ["-q", wav]);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Relay connection
// ---------------------------------------------------------------------------

const seenJams = new Set();

function handleJam(jam, config) {
  if (!jam || typeof jam !== "object") return;
  if (jam.suppressNotify) return;
  if (typeof jam.from !== "string" || !jam.from) return;

  if (!config.friends.includes(jam.from)) {
    console.log("[FreeJam] Ignored a jam from a sender not in your friend list.");
    return;
  }

  const key = `${jam.from}:${Number(jam.at) || 0}`;
  if (seenJams.has(key)) return;
  seenJams.add(key);
  if (seenJams.size > MAX_SEEN_JAMS) {
    const oldest = seenJams.values().next().value;
    seenJams.delete(oldest);
  }

  const what = jam.mode === "sync" ? "a playback sync" : "a listening session";
  const title = `${jam.fromName || "A friend"} started ${what}`;
  console.log(`[FreeJam] ${title}`);

  notify(title, "Open FreeJam to join.", {
    sound: config.sound !== false,
  });
}

function run(config) {
  let socket = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let pingTimer = null;
  let stopped = false;

  function stop() {
    stopped = true;
    clearTimeout(reconnectTimer);
    clearInterval(pingTimer);
    if (socket) {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  }

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  function scheduleReconnect(reason) {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    console.error(
      `[FreeJam] ${reason} Retrying in ${Math.round(reconnectDelay / 1000)}s.`
    );
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(Math.round(reconnectDelay * 1.7), 30000);
  }

  function connect() {
    if (stopped) return;

    let url;
    try {
      url = new URL(config.relayUrl);
    } catch {
      console.error("[FreeJam] The relay URL in the config is invalid.");
      stopped = true;
      return;
    }

    url.searchParams.set("user", config.userId);
    url.searchParams.set("key", config.recvKey);
    url.searchParams.set("id", `notifier-${crypto.randomBytes(6).toString("hex")}`);
    url.searchParams.set("name", config.name || "FreeJam");
    url.searchParams.set("client", "notifier");

    const ws = createWebSocket(url.toString(), {
      onOpen(sock) {
        reconnectDelay = 1000;
        console.log("[FreeJam] Notifier connected.");
        sock.send({
          t: "hello",
          name: config.name || "FreeJam",
          friends: config.friends,
        });

        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (!sock.closed) {
            sock.send({
              t: "ping",
              id: crypto.randomBytes(4).toString("hex"),
              ts: Date.now(),
            });
          }
        }, PING_INTERVAL_MS);
      },

      onMessage(raw) {
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          return;
        }
        if (message && message.t === "jam") handleJam(message, config);
      },

      onClose(code, reason) {
        clearInterval(pingTimer);
        pingTimer = null;
        socket = null;

        if (code === 4003) {
          console.error(
            "[FreeJam] The relay rejected the receive key. Copy a fresh notifier setup code from FreeJam."
          );
          stopped = true;
          return;
        }
        scheduleReconnect(
          `Connection closed${reason ? `: ${reason}` : "."}`
        );
      },

      onError(err) {
        console.error(`[FreeJam] Connection error: ${err.message}`);
      },
    });

    socket = ws;
  }

  connect();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { command: "run", configPath: "", code: "" };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--config" || arg === "-c") {
      out.configPath = argv[i + 1] || "";
      i += 1;
    } else if (arg.startsWith("--config=")) {
      out.configPath = arg.slice("--config=".length);
    } else if (arg === "--install") {
      out.command = "install";
      out.code = argv[i + 1] || "";
      i += 1;
    } else if (arg.startsWith("--install=")) {
      out.command = "install";
      out.code = arg.slice("--install=".length);
    } else if (arg === "--uninstall") {
      out.command = "uninstall";
    } else if (arg === "--test") {
      out.command = "test";
    } else if (arg === "--help" || arg === "-h") {
      out.command = "help";
    } else if (arg === "--version") {
      out.command = "version";
    } else if (!out.code && arg.startsWith(CODE_PREFIX)) {
      out.command = "install";
      out.code = arg;
    }
  }

  return out;
}

function printHelp() {
  console.log(
    [
      "FreeJam background notifier",
      "",
      "Usage:",
      "  node freejam-notifier.js --install FJN1...   save a setup code",
      "  node freejam-notifier.js --test             show a test alert",
      "  node freejam-notifier.js                    run until stopped",
      "",
      "Options:",
      "  --config <path>   use a custom config file",
      "  --uninstall       remove the saved config",
      "  --help            show this help",
      "",
      "The setup code is created by the FreeJam extension under",
      "Friends -> Alerts while Spotify is closed.",
    ].join("\n")
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  configPath = args.configPath || defaultConfigPath();

  if (args.command === "help") {
    printHelp();
    return;
  }

  if (args.command === "version") {
    console.log("FreeJam notifier 1.0.0");
    return;
  }

  if (args.command === "install") {
    if (!args.code) {
      console.error("Paste the FJN1 setup code after --install.");
      process.exitCode = 1;
      return;
    }
    try {
      const config = decodeSetupCode(args.code);
      saveConfig(configPath, config);
      ensureDingFile();
      console.log(`FreeJam notifier configured at ${configPath}`);
      console.log("Run with --test to check notifications.");
    } catch (err) {
      console.error(`[FreeJam] ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (args.command === "uninstall") {
    try {
      fs.rmSync(configPath, { force: true });
      console.log(`Removed ${configPath}`);
    } catch (err) {
      console.error(`[FreeJam] Could not remove the config: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (args.command === "test") {
    try {
      const config = loadConfig(configPath);
      notify("FreeJam", "Background alerts are working.", {
        sound: config.sound !== false,
      });
      setTimeout(() => process.exit(0), 1200);
    } catch (err) {
      console.error(`[FreeJam] ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  try {
    const config = loadConfig(configPath);
    run(config);
  } catch (err) {
    console.error(`[FreeJam] ${err.message}`);
    console.error("Create a setup code in FreeJam and run --install first.");
    process.exitCode = 1;
  }
}

main();
