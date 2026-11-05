#!/usr/bin/env node
/*
 * FreeJam relay — a tiny dependency-free WebSocket relay for FreeJam sync mode.
 *
 * Run:
 *   node freejam-relay.js
 *
 * Options (environment variables):
 *   PORT=8787        Port to listen on.
 *   HOST=0.0.0.0     Interface to bind.
 *
 * The relay keeps one "room" per session id and forwards JSON messages to the
 * other participants in the same room. It never stores playback history.
 *
 * Security: this is intended for a LAN, a private VPN, or a trusted deployment
 * behind TLS. The session key is a room password, not strong authentication.
 */

"use strict";

const http = require("http");
const crypto = require("crypto");
const os = require("os");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_PAYLOAD = 64 * 1024;
const MAX_BUFFER = 256 * 1024;
const MAX_MESSAGES_PER_SECOND = 40;
const MAX_CLIENTS_PER_ROOM = 32;

/** @type {Map<string, {key: string, clients: Set<Client>}>} */
const rooms = new Map();

class Client {
  constructor(socket, room, session, key, id, name, role) {
    this.socket = socket;
    this.room = room;
    this.session = session;
    this.key = key;
    this.id = id;
    this.name = name;
    this.role = role;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    this.msgWindowStart = Date.now();
    this.msgCount = 0;
  }

  send(message) {
    if (this.closed) return;
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    this.socket.write(encodeFrame(0x1, payload));
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    const reasonBuffer = Buffer.from(reason, "utf8").subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    try {
      this.socket.write(encodeFrame(0x8, payload));
    } catch {
      /* ignore */
    }
    this.socket.end();
  }
}

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer, onFrame) {
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const b1 = buffer[offset];
    const b2 = buffer[offset + 1];
    const fin = (b1 & 0x80) !== 0;
    const opcode = b1 & 0x0f;
    const masked = (b2 & 0x80) !== 0;
    let length = b2 & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(MAX_PAYLOAD)) {
        return { buffer: Buffer.alloc(0), error: "Frame too large" };
      }
      length = Number(bigLength);
      headerLength = 10;
    }

    if (length > MAX_PAYLOAD) {
      return { buffer: Buffer.alloc(0), error: "Frame too large" };
    }

    let maskKey = null;
    if (masked) {
      if (offset + headerLength + 4 > buffer.length) break;
      maskKey = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      headerLength += 4;
    }

    if (offset + headerLength + length > buffer.length) break;

    let payload = buffer.subarray(
      offset + headerLength,
      offset + headerLength + length
    );

    if (masked) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= maskKey[i % 4];
      }
    }

    onFrame(opcode, fin, payload);
    offset += headerLength + length;
  }

  return { buffer: buffer.subarray(offset), error: null };
}

function safeString(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function broadcastPresence(room) {
  const members = Array.from(room.clients).map((client) => ({
    id: client.id,
    name: client.name,
    role: client.role,
  }));

  const message = {
    t: "presence",
    count: members.length,
    members,
  };

  for (const client of room.clients) {
    client.send(message);
  }
}

function handleMessage(client, raw) {
  if (raw.length > MAX_PAYLOAD) {
    client.close(1009, "Message too large");
    return;
  }

  const now = Date.now();
  if (now - client.msgWindowStart > 1000) {
    client.msgWindowStart = now;
    client.msgCount = 0;
  }
  client.msgCount += 1;
  if (client.msgCount > MAX_MESSAGES_PER_SECOND) {
    client.close(4008, "Rate limit exceeded");
    return;
  }

  let message;
  try {
    message = JSON.parse(raw.toString("utf8"));
  } catch {
    return;
  }

  if (!message || typeof message !== "object" || typeof message.t !== "string") {
    return;
  }

  if (message.t === "ping") {
    client.send({
      t: "pong",
      id: message.id,
      ts: message.ts,
      serverTs: Date.now(),
    });
    return;
  }

  if (message.t === "hello") {
    const name = safeString(message.name, 64);
    const role = message.role === "host" ? "host" : "guest";
    if (name) client.name = name;
    client.role = role;
    broadcastPresence(client.room);
    return;
  }

  if (message.t !== "state" && message.t !== "cmd") {
    return;
  }

  // Only the host owns playback state, and only guests issue commands. This
  // stops a guest from spoofing the host's state or causing feedback loops.
  if (message.t === "state" && client.role !== "host") return;
  if (message.t === "cmd" && client.role !== "guest") return;

  // Never let a client spoof who sent a message.
  message.from = client.id;
  message.fromName = client.name;
  message.fromRole = client.role;

  for (const other of client.room.clients) {
    if (other !== client) other.send(message);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(
      [
        "FreeJam relay is running.",
        "",
        "Point the FreeJam extension at this WebSocket URL, for example:",
        `  ws://<this-machine-ip>:${PORT}`,
        "",
        "Keep this process running while the listening session is active.",
        "This relay does not store messages.",
        "",
      ].join("\n")
    );
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.on("upgrade", (req, socket) => {
  socket.setNoDelay(true);
  socket.setTimeout(0);

  const upgrade = String(req.headers.upgrade || "").toLowerCase();
  if (upgrade !== "websocket") {
    socket.destroy();
    return;
  }

  const version = String(req.headers["sec-websocket-version"] || "");
  if (version !== "13") {
    socket.write("HTTP/1.1 426 Upgrade Required\r\n\r\n");
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    socket.destroy();
    return;
  }

  const session = safeString(url.searchParams.get("session"), 128);
  const roomKey = safeString(url.searchParams.get("key"), 256);
  const id = safeString(url.searchParams.get("id"), 64) || crypto.randomBytes(8).toString("hex");
  const name = safeString(url.searchParams.get("name"), 64) || "Listener";
  const role = url.searchParams.get("role") === "host" ? "host" : "guest";

  if (!session || !roomKey) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n")
  );

  let room = rooms.get(session);
  if (!room) {
    // Only a host may create a room. Otherwise someone who learns or guesses a
    // session id could lock the real host out by registering the room first.
    if (role !== "host") {
      const reject = new Client(socket, room, session, roomKey, id, name, role);
      reject.close(4004, "Session not found");
      return;
    }
    room = { key: roomKey, clients: new Set() };
    rooms.set(session, room);
  } else if (room.key !== roomKey) {
    const reject = new Client(socket, room, session, roomKey, id, name, role);
    reject.close(4003, "Invalid session key");
    return;
  } else if (role !== "host" && room.clients.size >= MAX_CLIENTS_PER_ROOM) {
    const reject = new Client(socket, room, session, roomKey, id, name, role);
    reject.close(4009, "Session is full");
    return;
  }

  // A reconnecting host replaces the previous host socket. The session key
  // proves it is the same host, so this is safe.
  if (role === "host") {
    for (const other of room.clients) {
      if (other.role === "host" && other.id !== id) {
        other.close(4005, "Replaced by a new host");
      }
    }
  }

  const client = new Client(socket, room, session, roomKey, id, name, role);
  room.clients.add(client);

  console.log(
    `[join] ${session.slice(0, 8)}… ${role} ${name} (${id}) — ${room.clients.size} in room`
  );

  broadcastPresence(room);

  socket.on("data", (chunk) => {
    if (client.closed) return;

    client.buffer = Buffer.concat([client.buffer, chunk]);
    if (client.buffer.length > MAX_BUFFER) {
      client.close(1009, "Buffer overflow");
      return;
    }

    const result = decodeFrames(
      client.buffer,
      (opcode, fin, payload) => {
        if (opcode === 0x8) {
          client.close(1000, "");
          return;
        }
        if (opcode === 0x9) {
          socket.write(encodeFrame(0xa, payload));
          return;
        }
        if (opcode === 0xa) {
          return;
        }
        if (opcode === 0x1 || opcode === 0x0) {
          client.fragments.push(Buffer.from(payload));
          if (fin) {
            const raw = Buffer.concat(client.fragments);
            client.fragments = [];
            handleMessage(client, raw);
          }
        }
      }
    );

    client.buffer = result.buffer;

    if (result.error) {
      client.close(1009, result.error);
    }
  });

  const cleanup = () => {
    if (!room.clients.has(client)) return;
    room.clients.delete(client);
    client.closed = true;

    console.log(
      `[leave] ${session.slice(0, 8)}… ${role} ${name} — ${room.clients.size} in room`
    );

    if (room.clients.size === 0) {
      rooms.delete(session);
    } else {
      broadcastPresence(room);
    }
  };

  socket.on("close", cleanup);
  socket.on("end", cleanup);
  socket.on("error", cleanup);
});

server.listen(PORT, HOST, () => {
  console.log(`FreeJam relay listening on ws://${HOST}:${PORT}`);

  const lanAddresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);

  for (const address of lanAddresses) {
    console.log(`  LAN address: ws://${address}:${PORT}`);
  }

  console.log("Press Ctrl+C to stop.");
});
