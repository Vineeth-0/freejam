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
 * The relay does two jobs:
 *
 *   1. Sync sessions. One "room" per session id forwards playback state,
 *      commands and host-only kicks between the host and guests. Nothing is
 *      stored.
 *
 *   2. Friend mailboxes. Each user owns a mailbox keyed by a random user id.
 *      Friends send a jam invite directly to that mailbox using the owner's
 *      shareable send key, so only people you added ever get an alert. The
 *      relay never broadcasts an invite to everyone.
 *
 * Security: the session key and mailbox keys are shared secrets, not strong
 * authentication. Run behind TLS.
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
const MAX_MAILBOX_CLIENTS = 8;
const MAX_MAILBOXES = 10000;
const MAX_JAM_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_PENDING_JAMS = 20;
const MAX_WATCHED_USERS = 200;

/** @type {Map<string, {key: string, clients: Set<Client>}>} */
const rooms = new Map();

/**
 * Each user has a mailbox keyed by a stable user id. Friends send jam invites
 * directly to that mailbox. The relay never broadcasts an invite to everyone.
 *
 * @type {Map<string, {recvKey: string, sendKey: string, clients: Set<Client>, lastJam: object|null}>}
 */
const mailboxes = new Map();

/**
 * A jam sent to a friend who is offline. It is delivered when they connect and
 * prove they own the mailbox.
 *
 * @type {Map<string, Array<{sk: string, jam: object, at: number, notifiedAt: number}>>}
 */
const pendingJams = new Map();

class Client {
  constructor(socket, room, session, key, id, name, role) {
    this.socket = socket;
    this.room = room;
    this.session = session;
    this.key = key;
    this.id = id;
    this.name = name;
    this.role = role;
    this.kind = "session";
    this.clientKind = "app";
    this.userId = "";
    this.uid = "";
    this.friends = null;
    this.watching = new Set();
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
    uid: client.uid || "",
  }));

  // The stable user id is the address of a friend mailbox, so a guest must not
  // learn it for everyone else in the room: knowing an id is enough to try to
  // pre-claim that mailbox. The host keeps the ids because it is the one that
  // matches guests against its own friend list (to kick a friend by name).
  const publicMembers = members.map(({ uid, ...rest }) => rest);

  for (const client of room.clients) {
    client.send({
      t: "presence",
      count: members.length,
      members: client.role === "host" ? members : publicMembers,
    });
  }
}

function mailboxOnline(userId) {
  const box = mailboxes.get(userId);
  return Boolean(box && box.clients.size > 0);
}

function sendPresence(client) {
  const online = [];
  for (const userId of client.watching) {
    if (mailboxOnline(userId)) online.push(userId);
  }
  client.send({ t: "presence", online });
}

function notifyWatchers(userId) {
  for (const box of mailboxes.values()) {
    for (const client of box.clients) {
      if (client.watching.has(userId)) sendPresence(client);
    }
  }
}

function buildJam(raw, client) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.mode !== "sync") return null;

  const jam = {
    t: "jam",
    mode: "sync",
    hostName: safeString(raw.hostName, 64) || client.name,
    joinCode: safeString(raw.joinCode, 4096),
    sessionId: safeString(raw.sessionId, 128),
    at: Date.now(),
    from: client.userId,
    fromName: client.name,
  };

  if (!jam.joinCode || !jam.sessionId) return null;
  return jam;
}

function queuePending(userId, entry) {
  let list = pendingJams.get(userId);
  if (!list) {
    list = [];
    pendingJams.set(userId, list);
  }

  entry.notifiedAt = Number(entry.notifiedAt) || 0;
  list.push(entry);

  const cutoff = Date.now() - MAX_JAM_AGE_MS;
  while (list.length > MAX_PENDING_JAMS) list.shift();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].at < cutoff) list.splice(i, 1);
  }
}

function deliverPending(client) {
  const list = pendingJams.get(client.userId);
  if (!list || !list.length) return;

  const now = Date.now();
  const box = client.room;
  const isNotifier = client.clientKind === "notifier";
  let deliveredToApp = false;

  for (const entry of list) {
    if (entry.at + MAX_JAM_AGE_MS <= now) continue;
    // A pending invite is only valid if it was sent with the mailbox's current
    // send key. This drops anything queued by someone who guessed the user id.
    if (box.sendKey && entry.sk !== box.sendKey) continue;

    if (isNotifier) {
      // A notifier may announce a pending jam while Spotify is closed, but it
      // must not consume the invite. The app still needs it when it opens.
      if (client.friends && !client.friends.has(entry.jam.from)) continue;
      if (entry.notifiedAt) continue;
      entry.notifiedAt = now;
      client.send(entry.jam);
      continue;
    }

    const jam = Object.assign({}, entry.jam);
    if (entry.notifiedAt && now - entry.notifiedAt < MAX_JAM_AGE_MS) {
      // The background notifier already announced this one. The app still gets
      // the Join jam card, but should not fire a second notification.
      jam.suppressNotify = true;
    }
    client.send(jam);
    deliveredToApp = true;
  }

  if (deliveredToApp) pendingJams.delete(client.userId);
}

function handleMailboxMessage(client, message) {
  if (message.t === "hello") {
    const name = safeString(message.name, 64);
    if (name) client.name = name;

    // The recv key authenticated this connection, so the owner is allowed to
    // (re)register their send key. This also repairs a mailbox that a stranger
    // created before the owner first connected.
    const sendKey = safeString(message.sendKey, 256);
    if (sendKey) client.room.sendKey = sendKey;

    if (Array.isArray(message.friends)) {
      client.friends = new Set(
        message.friends
          .map((id) => safeString(id, 128))
          .filter(Boolean)
          .slice(0, MAX_WATCHED_USERS)
      );
    }

    client.send({
      t: "hello-ok",
      userId: client.userId,
      sendKey: client.room.sendKey || "",
    });
    notifyWatchers(client.userId);
    deliverPending(client);
    return;
  }

  if (message.t === "watch") {
    const ids = Array.isArray(message.ids) ? message.ids : [];
    client.watching = new Set(
      ids
        .map((id) => safeString(id, 128))
        .filter((id) => id && id !== client.userId)
        .slice(0, MAX_WATCHED_USERS)
    );
    sendPresence(client);
    return;
  }

  if (message.t === "dm") {
    const to = safeString(message.to, 128);
    const sendKey = safeString(message.sendKey, 256);
    if (!to || !sendKey || to === client.userId) return;

    let target = mailboxes.get(to);
    if (!target) {
      if (mailboxes.size >= MAX_MAILBOXES) return;
      target = { recvKey: "", sendKey: "", clients: new Set(), lastJam: null };
      mailboxes.set(to, target);
    }
    if (target.sendKey && target.sendKey !== sendKey) return;
    if (!target.sendKey) target.sendKey = sendKey;

    const jam = buildJam(message.jam, client);
    if (!jam) return;
    target.lastJam = jam;

    const appClients = [];
    const notifierClients = [];
    for (const other of target.clients) {
      if (other.clientKind === "notifier") notifierClients.push(other);
      else appClients.push(other);
    }

    if (appClients.length > 0) {
      // Spotify is open, so the extension itself will raise the OS alert.
      // Keep the background notifier silent to avoid a duplicate.
      for (const other of appClients) other.send(jam);
    } else {
      // Only announce through notifiers whose cached friend list contains the
      // sender. A stale notifier must not suppress the app's later alert.
      const eligibleNotifiers = notifierClients.filter(
        (other) => !other.friends || other.friends.has(client.userId)
      );
      for (const other of eligibleNotifiers) other.send(jam);

      // If only the notifier is connected, queue a copy so the app still has a
      // Join jam card the next time it opens. notifiedAt suppresses a second
      // notification from the app in that case.
      queuePending(to, {
        sk: sendKey,
        jam,
        at: Date.now(),
        notifiedAt: eligibleNotifiers.length > 0 ? Date.now() : 0,
      });
    }
    return;
  }

  if (message.t === "jam-clear") {
    const to = safeString(message.to, 128);
    const sendKey = safeString(message.sendKey, 256);
    const target = mailboxes.get(to);
    if (!target || !target.sendKey || target.sendKey !== sendKey) return;

    target.lastJam = null;
    for (const other of target.clients) {
      other.send({ t: "jam-clear", from: client.userId });
    }
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

  if (client.kind === "mailbox") {
    handleMailboxMessage(client, message);
    return;
  }

  if (message.t === "hello") {
    const name = safeString(message.name, 64);
    if (name) client.name = name;
    // The role is fixed by the connection URL. A guest must not be able to
    // claim the host role by sending hello, or it could kick or spoof state.
    broadcastPresence(client.room);
    return;
  }

  // Only the host may remove a guest. The target is matched by connection id,
  // never by a name or user id, so a kick cannot hit the wrong socket.
  if (message.t === "kick") {
    if (client.role !== "host") return;
    const targetId = safeString(message.target, 64);
    if (!targetId || targetId === client.id) return;

    let target = null;
    for (const other of client.room.clients) {
      if (other.id === targetId && other.role !== "host") {
        target = other;
        break;
      }
    }
    if (!target) return;

    target.send({
      t: "kicked",
      by: client.name || "the host",
      reason: "Removed from the sync session",
    });
    target.close(4006, "Removed by the host");
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
        "Sync sessions: point the FreeJam extension at this WebSocket URL, for",
        "example:",
        `  ws://<this-machine-ip>:${PORT}`,
        "",
        "Friend mailboxes: friends send jam invites only to the mailboxes of",
        "people who added them. Nothing is broadcast to everyone.",
        "",
        "Keep this process running while you use FreeJam.",
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
  const userId = safeString(url.searchParams.get("user"), 128);
  const uid = safeString(url.searchParams.get("uid"), 128);
  const roomKey = safeString(url.searchParams.get("key"), 256);
  const id = safeString(url.searchParams.get("id"), 64) || crypto.randomBytes(8).toString("hex");
  const name = safeString(url.searchParams.get("name"), 64) || "Listener";
  const isMailbox = Boolean(userId);
  const clientKind =
    url.searchParams.get("client") === "notifier" ? "notifier" : "app";

  if ((!isMailbox && !session) || !roomKey) {
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

  let role;
  let container;
  let collection;
  let collectionKey;
  let client;
  let sessionLabel;

  if (isMailbox) {
    role = "member";
    sessionLabel = `mailbox:${userId}`;

    let box = mailboxes.get(userId);
    if (!box) {
      if (mailboxes.size >= MAX_MAILBOXES) {
        const reject = new Client(
          socket,
          null,
          sessionLabel,
          roomKey,
          id,
          name,
          role
        );
        reject.close(4009, "Relay is at capacity");
        return;
      }
      box = { recvKey: roomKey, sendKey: "", clients: new Set(), lastJam: null };
      mailboxes.set(userId, box);
    } else if (box.recvKey !== roomKey) {
      // A mailbox may be reclaimed only while it is inert: no client connected
      // and no owner ever completed hello. This stops a drive-by connection that
      // merely guessed a user id from permanently poisoning that mailbox.
      if (!box.recvKey || (box.clients.size === 0 && !box.sendKey)) {
        box.recvKey = roomKey;
      } else {
        const reject = new Client(
          socket,
          box,
          sessionLabel,
          roomKey,
          id,
          name,
          role
        );
        reject.close(4003, "Invalid mailbox key");
        return;
      }
    }

    if (box.clients.size >= MAX_MAILBOX_CLIENTS) {
      const reject = new Client(
        socket,
        box,
        sessionLabel,
        roomKey,
        id,
        name,
        role
      );
      reject.close(4009, "Mailbox has too many connections");
      return;
    }

    container = box;
    collection = mailboxes;
    collectionKey = userId;
    client = new Client(socket, box, sessionLabel, roomKey, id, name, role);
    client.kind = "mailbox";
    client.clientKind = clientKind;
    client.userId = userId;
    client.uid = userId;
    box.clients.add(client);

    console.log(
      `[mailbox] ${userId.slice(0, 8)}… ${name} (${id}) ${clientKind} — ${box.clients.size} connected`
    );

    notifyWatchers(userId);
  } else {
    role = url.searchParams.get("role") === "host" ? "host" : "guest";
    sessionLabel = session;

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

    container = room;
    collection = rooms;
    collectionKey = session;
    client = new Client(socket, room, session, roomKey, id, name, role);
    client.uid = uid;
    room.clients.add(client);

    console.log(
      `[join] ${session.slice(0, 8)}… ${role} ${name} (${id}) — ${room.clients.size} in room`
    );

    broadcastPresence(room);
  }

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
    if (!container.clients.has(client)) return;
    container.clients.delete(client);
    client.closed = true;

    console.log(
      `[leave] ${sessionLabel.slice(0, 12)}… ${role} ${name} — ${container.clients.size} connected`
    );

    if (isMailbox) {
      // Keep the mailbox so its keys and last jam survive a reconnect.
      notifyWatchers(userId);
    } else if (container.clients.size === 0) {
      collection.delete(collectionKey);
    } else {
      broadcastPresence(container);
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
