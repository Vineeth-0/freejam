/*
 * FreeJam — collaborative listening for free Spotify accounts.
 *
 * Two independent modes:
 *
 * 1. Request mode (no guest install)
 *    FreeJam creates a normal private playlist and a regular "Invite
 *    collaborators" link. Guests open the link in the Spotify desktop/mobile
 *    app and add songs. This device watches the playlist and queues anything
 *    new. No Premium, no Jam API, no paywall bypass.
 *
 * 2. Sync mode (FreeJam on every device)
 *    A tiny relay (freejam-relay.js) connects the participants. The host is
 *    authoritative: their track, playhead, pause state and queue are broadcast
 *    to everyone. Skips, seeks, play/pause from any participant are forwarded
 *    to the host and then re-broadcast, so everyone stays together.
 *
 * Sync mode is a cooperative third-party player, not Spotify Jam. Free
 * accounts never call Spotify's Premium-only Jam endpoints.
 */

(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const STORAGE_KEY = "freejam:session:v2";
  const POLL_INTERVAL_MS = 4000;
  const PAGE_SIZE = 100;
  const MAX_QUEUE_PER_POLL = 25;
  const MAX_HISTORY = 50;
  const SNAPSHOT_CAP = 5000;
  const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const ERROR_NOTIFY_COOLDOWN_MS = 2 * 60 * 1000;

  const SYNC_TICK_MS = 500;
  const SYNC_STATE_INTERVAL_MS = 2000;
  const SYNC_PING_INTERVAL_MS = 10000;
  const SYNC_DRIFT_THRESHOLD_MS = 600;
  const SYNC_SEEK_THRESHOLD_MS = 900;
  const SYNC_HOST_SEEK_THRESHOLD_MS = 800;
  const SYNC_RECONNECT_MAX_MS = 15000;
  const SYNC_TRACK_GRACE_MS = 4000;
  const SYNC_CMD_GRACE_MS = 1200;

  const FRIENDS_STORAGE_KEY = "freejam:friends:v1";
  const ALERTS_STORAGE_KEY = "freejam:alerts:v1";
  const LAYOUT_STORAGE_KEY = "freejam:layout:v1";
  const FRIEND_CODE_PREFIX = "FJF1.";
  const NOTIFIER_CODE_PREFIX = "FJN1.";
  const FRIEND_PING_INTERVAL_MS = 15000;
  const FRIEND_RECONNECT_MAX_MS = 15000;
  const FRIEND_JAM_NOTIFY_COOLDOWN_MS = 45 * 1000;
  const MAX_FRIENDS = 200;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  function defaultState() {
    return {
      version: 2,
      playlistUri: null,
      playlistUrl: null,
      inviteUrl: null,
      inviteCreatedAt: null,
      name: null,
      startedAt: null,
      lastTotal: 0,
      paused: false,
      pendingCount: 0,
      requests: [],
      processed: [],
      lastError: null,
      lastRelayUrl: "",
      syncConfig: null,
    };
  }

  let state = defaultState();
  let seen = new Set();
  let sessionToken = 0;
  let pollTimer = null;
  let polling = false;
  let busy = false;
  let endArmedUntil = 0;
  let syncLeaveArmedUntil = 0;
  let lastErrorNotifyAt = 0;
  let audioContext = null;

  const alerts = {
    os: true,
    sound: true,
  };

  // Which parts of the panel are visible. Settings always stays visible so
  // people can bring back anything they hid.
  const DEFAULT_LAYOUT = {
    session: true,
    sync: true,
    friends: true,
    requests: true,
    hint: true,
  };

  const layout = { ...DEFAULT_LAYOUT };

  const activeNotifications = new Set();

  const ui = {
    button: null,
    root: null,
  };

  const sync = {
    role: null,
    relayUrl: "",
    sessionId: "",
    key: "",
    name: "",
    selfId: "",
    ws: null,
    connected: false,
    members: [],
    error: null,
    hostId: null,
    hostName: null,
    latencyMs: 0,
    lastLocal: null,
    applyingUntil: 0,
    appliedPaused: null,
    appliedPausedUntil: 0,
    expectedUri: null,
    expectedUntil: 0,
    manualSkipAt: 0,
    ignoreStateUntil: 0,
    applyToken: 0,
    trackChangedAt: 0,
    lastCmdAt: 0,
    lastBroadcastAt: 0,
    lastPanelUpdate: 0,
    seeking: false,
    stateTimer: null,
    tickTimer: null,
    pingTimer: null,
    reconnectTimer: null,
    reconnectDelay: 1000,
    pingId: "",
    pingSentAt: 0,
  };

  const friends = {
    identity: null,
    list: [],
    ws: null,
    connected: false,
    relayUrl: "",
    selfId: "",
    online: new Set(),
    error: null,
    reconnectTimer: null,
    reconnectDelay: 1000,
    pingTimer: null,
    pingId: "",
    pingSentAt: 0,
    latencyMs: 0,
    incomingJam: null,
    pendingJam: null,
    lastNotifyAt: 0,
    handshaken: false,
    handshakeTimer: null,
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function $(selector, root) {
    return root ? root.querySelector(selector) : null;
  }

  function waitFor(predicate, timeout = 20000, interval = 100) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const check = () => {
        let value;
        try {
          value = predicate();
        } catch {
          value = null;
        }
        if (value) return resolve(value);
        if (Date.now() - startedAt >= timeout) return resolve(null);
        setTimeout(check, interval);
      };
      check();
    });
  }

  function playlistIdFromUri(uri) {
    if (!uri) return null;
    const match = String(uri).match(
      /(?:spotify:playlist:|open\.spotify\.com\/playlist\/)([A-Za-z0-9]+)/
    );
    return match ? match[1] : null;
  }

  function playlistUrlFromUri(uri) {
    const id = playlistIdFromUri(uri);
    return id ? `https://open.spotify.com/playlist/${id}` : null;
  }

  function parsePlaylistInput(raw) {
    if (!raw) return null;
    const value = String(raw).trim();
    if (/^spotify:playlist:[A-Za-z0-9]+$/.test(value)) return value;
    const match = value.match(
      /(?:open\.spotify\.com\/playlist\/|spotify:playlist:)([A-Za-z0-9]+)/
    );
    if (match) return `spotify:playlist:${match[1]}`;
    if (/^[A-Za-z0-9]{22}$/.test(value)) return `spotify:playlist:${value}`;
    return null;
  }

  function defaultSessionName() {
    const now = new Date();
    const date = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
    const time = [
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
    ].join(":");
    return `FreeJam · ${date} ${time}`;
  }

  function timeAgo(timestamp) {
    const diff = Math.max(0, Date.now() - timestamp);
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function formatMs(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function isQueueableItem(item) {
    return Boolean(
      item &&
        item.uid &&
        typeof item.uri === "string" &&
        item.uri.startsWith("spotify:track:")
    );
  }

  function addedAtMs(item) {
    const value = item ? item.addedAt : null;
    if (!value) return 0;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return value;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function trackMeta(item) {
    const artists = Array.isArray(item.artists)
      ? item.artists
          .map((artist) => (artist ? artist.name : null))
          .filter(Boolean)
          .join(", ")
      : item.artist || "";

    return {
      uid: item.uid,
      uri: item.uri,
      name: item.name || "Unknown track",
      artists,
      addedBy:
        (item.addedBy && (item.addedBy.displayName || item.addedBy.username)) ||
        "someone",
      addedAt: item.addedAt || null,
      queuedAt: Date.now(),
    };
  }

  function getNowPlaying() {
    try {
      const item = Spicetify.Player.data && Spicetify.Player.data.item;
      if (!item || !item.name) return null;
      const artists = Array.isArray(item.artists)
        ? item.artists
            .map((artist) => (artist ? artist.name : null))
            .filter(Boolean)
            .join(", ")
        : item.artist || "";
      return artists ? `${item.name} — ${artists}` : item.name;
    } catch {
      return null;
    }
  }

  function randomId(bytes) {
    const array = new Uint8Array(bytes);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(array);
    } else {
      for (let i = 0; i < array.length; i += 1) {
        array[i] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join(
      ""
    );
  }

  function base64UrlEncode(text) {
    return btoa(text)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  function base64UrlDecode(text) {
    const padded =
      text.replace(/-/g, "+").replace(/_/g, "/") +
      "===".slice((text.length + 3) % 4);
    return atob(padded);
  }

  function encodeJoinCode(config) {
    const payload = JSON.stringify({
      v: 1,
      u: config.relayUrl,
      s: config.sessionId,
      k: config.key,
    });
    return `FJ1.${base64UrlEncode(payload)}`;
  }

  function decodeJoinCode(code) {
    if (!code) return null;
    const value = String(code).trim();
    if (!value.startsWith("FJ1.")) return null;
    try {
      const payload = JSON.parse(base64UrlDecode(value.slice(4)));
      if (
        !payload ||
        payload.v !== 1 ||
        typeof payload.u !== "string" ||
        typeof payload.s !== "string" ||
        typeof payload.k !== "string"
      ) {
        return null;
      }
      return {
        relayUrl: payload.u,
        sessionId: payload.s,
        key: payload.k,
      };
    } catch {
      return null;
    }
  }

  function normalizeRelayUrl(input) {
    let value = String(input || "").trim();
    if (!value) return "";
    if (/^https:\/\//i.test(value)) value = `wss://${value.slice(8)}`;
    else if (/^http:\/\//i.test(value)) value = `ws://${value.slice(7)}`;
    else if (!/^wss?:\/\//i.test(value)) value = `ws://${value}`;
    return value.replace(/\/+$/, "");
  }

  function encodeFriendCode(identity) {
    const payload = JSON.stringify({
      v: 1,
      u: identity.relayUrl,
      id: identity.userId,
      sk: identity.sendKey,
      n: identity.name || "A friend",
    });
    return `${FRIEND_CODE_PREFIX}${base64UrlEncode(payload)}`;
  }

  function decodeFriendCode(code) {
    if (!code) return null;
    const value = String(code).trim();
    if (!value.startsWith(FRIEND_CODE_PREFIX)) return null;
    try {
      const payload = JSON.parse(
        base64UrlDecode(value.slice(FRIEND_CODE_PREFIX.length))
      );
      if (
        !payload ||
        payload.v !== 1 ||
        typeof payload.u !== "string" ||
        typeof payload.id !== "string" ||
        typeof payload.sk !== "string" ||
        !payload.u ||
        !payload.id ||
        !payload.sk
      ) {
        return null;
      }
      return {
        relayUrl: normalizeRelayUrl(payload.u),
        userId: payload.id,
        sendKey: payload.sk,
        name: typeof payload.n === "string" && payload.n.trim()
          ? payload.n.trim().slice(0, 64)
          : "A friend",
      };
    } catch {
      return null;
    }
  }

  function encodeNotifierCode(identity) {
    const payload = JSON.stringify({
      v: 1,
      u: identity.relayUrl,
      id: identity.userId,
      rk: identity.recvKey,
      n: identity.name || "A friend",
      f: friends.list.map((friend) => friend.userId),
      snd: alerts.sound ? 1 : 0,
    });
    return `${NOTIFIER_CODE_PREFIX}${base64UrlEncode(payload)}`;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  function loadState() {
    try {
      const raw = Spicetify.LocalStorage.get(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 2) return;
      if (
        parsed.playlistUri &&
        !/^spotify:playlist:[A-Za-z0-9]+$/.test(parsed.playlistUri)
      ) {
        return;
      }

      state = Object.assign(defaultState(), parsed);
      if (!Array.isArray(state.requests)) state.requests = [];
      if (!Array.isArray(state.processed)) state.processed = [];
      state.lastError = null;
      state.pendingCount = 0;
      seen = new Set(state.processed);

      const config = parsed.syncConfig;
      if (
        config &&
        (config.role === "host" || config.role === "guest") &&
        typeof config.relayUrl === "string" &&
        typeof config.sessionId === "string" &&
        typeof config.key === "string" &&
        config.relayUrl &&
        config.sessionId &&
        config.key
      ) {
        sync.role = config.role;
        sync.relayUrl = config.relayUrl;
        sync.sessionId = config.sessionId;
        sync.key = config.key;
        sync.name = config.name || "";
      }
    } catch (err) {
      console.warn("[FreeJam] Could not load saved session", err);
    }
  }

  function saveState() {
    try {
      state.processed = Array.from(seen);
      state.syncConfig = sync.role
        ? {
            role: sync.role,
            relayUrl: sync.relayUrl,
            sessionId: sync.sessionId,
            key: sync.key,
            name: sync.name,
          }
        : null;
      Spicetify.LocalStorage.set(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      console.warn("[FreeJam] Could not save session", err);
    }
  }

  function loadFriends() {
    try {
      const raw = Spicetify.LocalStorage.get(FRIENDS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1) return;

      const identity = parsed.identity;
      if (
        identity &&
        typeof identity.userId === "string" &&
        typeof identity.recvKey === "string" &&
        typeof identity.sendKey === "string" &&
        typeof identity.relayUrl === "string" &&
        identity.userId &&
        identity.recvKey &&
        identity.sendKey
      ) {
        friends.identity = {
          userId: identity.userId,
          recvKey: identity.recvKey,
          sendKey: identity.sendKey,
          name: typeof identity.name === "string" ? identity.name : "Me",
          relayUrl: normalizeRelayUrl(identity.relayUrl),
          createdAt: Number(identity.createdAt) || Date.now(),
        };
      }

      if (Array.isArray(parsed.list)) {
        const seenIds = new Set();
        friends.list = parsed.list
          .filter(
            (friend) =>
              friend &&
              typeof friend.userId === "string" &&
              typeof friend.sendKey === "string" &&
              friend.userId &&
              friend.sendKey &&
              !seenIds.has(friend.userId)
          )
          .slice(0, MAX_FRIENDS)
          .map((friend) => {
            seenIds.add(friend.userId);
            return {
              userId: friend.userId,
              sendKey: friend.sendKey,
              name:
                typeof friend.name === "string" && friend.name.trim()
                  ? friend.name.trim().slice(0, 64)
                  : "A friend",
              relayUrl: normalizeRelayUrl(friend.relayUrl || ""),
              addedAt: Number(friend.addedAt) || Date.now(),
            };
          });
      }
    } catch (err) {
      console.warn("[FreeJam] Could not load friends", err);
    }
  }

  function saveFriends() {
    try {
      Spicetify.LocalStorage.set(
        FRIENDS_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          identity: friends.identity,
          list: friends.list,
        })
      );
    } catch (err) {
      console.warn("[FreeJam] Could not save friends", err);
    }
  }

  function loadAlerts() {
    try {
      const raw = Spicetify.LocalStorage.get(ALERTS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1) return;
      alerts.os = parsed.os !== false;
      alerts.sound = parsed.sound !== false;
    } catch (err) {
      console.warn("[FreeJam] Could not load alert settings", err);
    }
  }

  function saveAlerts() {
    try {
      Spicetify.LocalStorage.set(
        ALERTS_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          os: alerts.os,
          sound: alerts.sound,
        })
      );
    } catch (err) {
      console.warn("[FreeJam] Could not save alert settings", err);
    }
  }

  function loadLayout() {
    try {
      const raw = Spicetify.LocalStorage.get(LAYOUT_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1) return;
      for (const key of Object.keys(DEFAULT_LAYOUT)) {
        layout[key] = parsed[key] !== false;
      }
    } catch (err) {
      console.warn("[FreeJam] Could not load panel layout", err);
    }
  }

  function saveLayout() {
    try {
      Spicetify.LocalStorage.set(
        LAYOUT_STORAGE_KEY,
        JSON.stringify({ version: 1, ...layout })
      );
    } catch (err) {
      console.warn("[FreeJam] Could not save panel layout", err);
    }
  }

  // ---------------------------------------------------------------------------
  // Desktop alerts and the notification ding
  // ---------------------------------------------------------------------------

  function systemNotificationsSupported() {
    return (
      typeof window !== "undefined" &&
      typeof window.Notification === "function"
    );
  }

  function notificationPermission() {
    if (!systemNotificationsSupported()) return "unsupported";
    try {
      return window.Notification.permission || "default";
    } catch {
      return "denied";
    }
  }

  function ensureNotificationPermission(request = false) {
    if (!systemNotificationsSupported()) return Promise.resolve(false);
    if (notificationPermission() === "granted") return Promise.resolve(true);
    if (notificationPermission() === "denied" || !request) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value === "granted");
      };
      const timer = setTimeout(() => done("denied"), 15000);

      try {
        const maybe = window.Notification.requestPermission(done);
        if (maybe && typeof maybe.then === "function") {
          maybe.then(done, () => done("denied"));
        }
      } catch {
        done("denied");
      }
    });
  }

  function getAudioContext() {
    if (audioContext) return audioContext;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try {
      audioContext = new Ctor();
    } catch (err) {
      console.warn("[FreeJam] Could not create the audio context", err);
      return null;
    }
    return audioContext;
  }

  function primeAudio() {
    const ctx = getAudioContext();
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
  }

  function playDing() {
    if (!alerts.sound) return;
    const ctx = getAudioContext();
    if (!ctx || ctx.state === "closed") return;

    const start = () => {
      if (ctx.state === "closed") return;
      const now = ctx.currentTime + 0.02;
      const master = ctx.createGain();
      master.gain.setValueAtTime(0.72, now);
      master.connect(ctx.destination);

      // A soft two-note bell: low warmth, a bright C6, then a G6 sparkle.
      const notes = [
        { freq: 523.25, at: 0, dur: 0.42, gain: 0.12 },
        { freq: 1046.5, at: 0, dur: 0.55, gain: 0.34 },
        { freq: 1567.98, at: 0.085, dur: 0.66, gain: 0.26 },
        { freq: 2093.0, at: 0.085, dur: 0.38, gain: 0.07 },
      ];

      for (const note of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const at = now + note.at;
        osc.type = "sine";
        osc.frequency.setValueAtTime(note.freq, at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(note.gain, at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + note.dur);
        osc.connect(gain);
        gain.connect(master);
        osc.start(at);
        osc.stop(at + note.dur + 0.05);
      }
    };

    if (ctx.state === "suspended") {
      ctx.resume().then(start).catch(() => {});
    } else {
      start();
    }
  }

  function showSystemNotification(title, body, options = {}) {
    if (!alerts.os || !systemNotificationsSupported()) return false;
    if (notificationPermission() !== "granted") return false;

    try {
      const notification = new window.Notification(title, {
        body,
        tag: options.tag || "freejam",
        silent: true,
      });
      activeNotifications.add(notification);

      const cleanup = () => activeNotifications.delete(notification);
      notification.onclose = cleanup;
      notification.onerror = cleanup;
      notification.onclick = () => {
        try {
          window.focus();
        } catch {
          /* ignore */
        }
        try {
          notification.close();
        } catch {
          /* ignore */
        }
      };

      setTimeout(() => {
        try {
          notification.close();
        } catch {
          /* ignore */
        }
      }, 15000);
      return true;
    } catch (err) {
      console.warn("[FreeJam] Desktop notification failed", err);
      return false;
    }
  }

  function showAlert(title, body, options = {}) {
    const shown = showSystemNotification(title, body, options);
    if (!shown) {
      const text = title === "FreeJam" ? body : `${title} — ${body}`;
      Spicetify.showNotification(
        text,
        Boolean(options.error),
        options.duration || 8000
      );
    }
    if (alerts.sound && options.sound !== false) playDing();
    return shown;
  }

  function showJamAlert(jam) {
    const what =
      jam.mode === "sync" ? "a playback sync" : "a listening session";
    return showAlert(
      `${jam.fromName || "A friend"} started ${what}`,
      "Open FreeJam to join.",
      {
        tag: `freejam-jam-${jam.from || "friend"}`,
        duration: 8000,
      }
    );
  }

  // ---------------------------------------------------------------------------
  // Spotify API wrappers
  // ---------------------------------------------------------------------------

  async function fetchPage(uri, offset, limit) {
    return Spicetify.Platform.PlaylistAPI.getContents(uri, { offset, limit });
  }

  async function fetchAllItems(uri, cap = SNAPSHOT_CAP) {
    const items = [];
    let offset = 0;
    let total = 0;

    while (offset < cap) {
      const page = await fetchPage(uri, offset, PAGE_SIZE);
      if (!page || !Array.isArray(page.items) || page.items.length === 0) {
        if (page && Number.isFinite(page.totalLength)) total = page.totalLength;
        break;
      }
      items.push(...page.items);
      total = Number.isFinite(page.totalLength) ? page.totalLength : items.length;
      offset += page.items.length;
      if (offset >= total) break;
    }

    // If the playlist is huge and we stopped early, still snapshot the tail so
    // polling can never mistake old songs for new requests.
    if (offset < total && total > PAGE_SIZE) {
      try {
        const tail = await fetchPage(
          uri,
          Math.max(0, total - PAGE_SIZE),
          PAGE_SIZE
        );
        if (tail && Array.isArray(tail.items)) items.push(...tail.items);
      } catch (err) {
        console.warn("[FreeJam] Could not snapshot the end of the playlist", err);
      }
    }

    return { items, total };
  }

  async function createInvite(uri) {
    const api = Spicetify.Platform.PlaylistPermissionsAPI;
    if (!api || typeof api.getPermissionGrant !== "function") {
      throw new Error(
        "This Spotify version doesn't expose invite links. Use “Invite collaborators” in the playlist menu and paste the link in FreeJam."
      );
    }

    const grant = await api.getPermissionGrant(uri, "CONTRIBUTOR");
    const token = grant && grant.token;
    if (!token) throw new Error("Spotify did not return an invite token.");

    const base = playlistUrlFromUri(uri);
    return {
      token,
      url: `${base}?pt=${encodeURIComponent(token)}`,
    };
  }

  async function queueTrack(uri) {
    if (typeof Spicetify.addToQueue !== "function") {
      throw new Error("The queue API is not ready yet.");
    }
    const result = Spicetify.addToQueue([{ uri }]);
    if (!result || typeof result.then !== "function") {
      throw new Error("The queue is not available. Start playback, then retry.");
    }
    await result;
  }

  async function copyText(text) {
    try {
      const api = Spicetify.Platform.ClipboardAPI;
      if (api && typeof api.copy === "function") {
        await api.copy(text);
        return true;
      }
    } catch (err) {
      console.warn("[FreeJam] ClipboardAPI failed", err);
    }

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      console.warn("[FreeJam] navigator.clipboard failed", err);
    }

    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch (err) {
      console.warn("[FreeJam] execCommand copy failed", err);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Request mode: polling
  // ---------------------------------------------------------------------------

  function schedulePoll(delay = POLL_INTERVAL_MS) {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (!state.playlistUri) return;
    pollTimer = setTimeout(runPoll, delay);
  }

  function notifyError(message) {
    if (Date.now() - lastErrorNotifyAt < ERROR_NOTIFY_COOLDOWN_MS) return;
    lastErrorNotifyAt = Date.now();
    Spicetify.showNotification(`FreeJam: ${message}`, true, 6000);
  }

  async function pollOnce() {
    const token = sessionToken;
    const uri = state.playlistUri;
    if (!uri) return;

    const top = await fetchPage(uri, 0, PAGE_SIZE);
    if (token !== sessionToken || state.playlistUri !== uri) return;
    if (!top || !Array.isArray(top.items)) {
      throw new Error("Unexpected response while reading the request playlist.");
    }

    const total = Number.isFinite(top.totalLength)
      ? top.totalLength
      : top.items.length;

    // Playlist order can be newest-first at the top and oldest-first at the
    // bottom depending on how a guest added the song. Look at both ends.
    let items = top.items.slice().reverse();
    if (total > PAGE_SIZE) {
      const tail = await fetchPage(
        uri,
        Math.max(PAGE_SIZE, total - PAGE_SIZE),
        PAGE_SIZE
      );
      if (token !== sessionToken || state.playlistUri !== uri) return;
      if (tail && Array.isArray(tail.items)) items = items.concat(tail.items);
    }

    let changed = false;
    if (state.lastTotal !== total) {
      state.lastTotal = total;
      changed = true;
    }

    const fresh = [];
    const freshUids = new Set();
    for (const item of items) {
      if (!isQueueableItem(item)) continue;
      if (seen.has(item.uid) || freshUids.has(item.uid)) continue;
      freshUids.add(item.uid);
      fresh.push(item);
    }

    fresh.sort((a, b) => addedAtMs(a) - addedAtMs(b));

    if (fresh.length === 0) {
      if (state.pendingCount !== 0) {
        state.pendingCount = 0;
        changed = true;
      }
      if (state.lastError) {
        state.lastError = null;
        changed = true;
      }
      if (changed) {
        saveState();
        updateButton();
        updatePanel();
      }
      return;
    }

    if (state.paused) {
      if (state.pendingCount !== fresh.length) {
        state.pendingCount = fresh.length;
        changed = true;
      }
      if (state.lastError) {
        state.lastError = null;
        changed = true;
      }
      if (changed) {
        saveState();
        updatePanel();
      }
      return;
    }

    const batch = fresh.slice(0, MAX_QUEUE_PER_POLL);
    const queued = [];

    for (const item of batch) {
      try {
        await queueTrack(item.uri);
      } catch (err) {
        if (token !== sessionToken || state.playlistUri !== uri) return;
        state.lastError =
          (err && err.message) || "Could not add the request to the queue.";
        notifyError(state.lastError);
        break;
      }

      if (token !== sessionToken || state.playlistUri !== uri) return;

      seen.add(item.uid);
      const meta = trackMeta(item);
      queued.push(meta);
      state.requests.unshift(meta);
      if (state.requests.length > MAX_HISTORY) {
        state.requests.length = MAX_HISTORY;
      }
    }

    state.pendingCount = Math.max(0, fresh.length - queued.length);
    if (queued.length > 0) {
      state.lastError = null;
      notifyQueued(queued);
    }

    saveState();
    updateButton();
    updatePanel();
  }

  async function runPoll() {
    if (!state.playlistUri) return;
    if (polling) {
      schedulePoll(1000);
      return;
    }

    const token = sessionToken;
    polling = true;
    try {
      await pollOnce();
    } catch (err) {
      if (token !== sessionToken) return;
      state.lastError =
        (err && err.message) || "Could not read the request playlist.";
      notifyError(state.lastError);
      updatePanel();
      updateButton();
    } finally {
      polling = false;
      schedulePoll();
    }
  }

  function notifyQueued(batch) {
    if (!batch.length) return;
    if (batch.length === 1) {
      const item = batch[0];
      const by = item.addedBy ? ` · added by ${item.addedBy}` : "";
      Spicetify.showNotification(`FreeJam queued “${item.name}”${by}`, false, 4000);
    } else {
      Spicetify.showNotification(
        `FreeJam queued ${batch.length} new requests`,
        false,
        4000
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Request mode: lifecycle
  // ---------------------------------------------------------------------------

  async function createSession(name, existingUri = null, isAdoption = false) {
    if (state.playlistUri) {
      Spicetify.showNotification("A FreeJam session is already active.", true);
      return;
    }
    if (busy) return;

    busy = true;
    sessionToken += 1;
    try {
      let sessionName = name || defaultSessionName();
      let uri = existingUri;

      if (uri) {
        try {
          const metadata = await Spicetify.Platform.PlaylistAPI.getMetadata(uri);
          if (metadata && metadata.name) sessionName = metadata.name;
        } catch (err) {
          console.warn("[FreeJam] Could not read playlist metadata", err);
        }
      } else {
        uri = await Spicetify.Platform.RootlistAPI.createPlaylist(
          sessionName,
          { before: "start" },
          true
        );
        if (!uri) throw new Error("Spotify did not create the playlist.");

        try {
          await Spicetify.Platform.PlaylistAPI.updateDetails(uri, {
            name: sessionName,
            description:
              "FreeJam request inbox — songs added here are queued on the host's device. Created with the FreeJam Spicetify extension.",
          });
        } catch (err) {
          console.warn("[FreeJam] Could not set the playlist description", err);
        }
      }

      let processed = new Set();
      let total = 0;
      if (isAdoption || existingUri) {
        const snapshot = await fetchAllItems(uri);
        processed = new Set(
          snapshot.items.filter(isQueueableItem).map((item) => item.uid)
        );
        total = snapshot.total;
      }

      let invite = null;
      try {
        invite = await createInvite(uri);
      } catch (err) {
        console.warn("[FreeJam] Automatic invite link failed", err);
      }

      state = Object.assign(defaultState(), {
        playlistUri: uri,
        playlistUrl: playlistUrlFromUri(uri),
        inviteUrl: invite ? invite.url : null,
        inviteCreatedAt: invite ? Date.now() : null,
        name: sessionName,
        startedAt: Date.now(),
        lastTotal: total,
        lastRelayUrl: state.lastRelayUrl,
        syncConfig: state.syncConfig,
      });
      seen = processed;

      saveState();
      updateButton();
      updatePanel(true);
      schedulePoll(600);

      if (invite && invite.url) {
        announceJam();
        const copied = await copyText(invite.url);
        Spicetify.showNotification(
          copied
            ? "FreeJam started. Invite link copied — send it to your friends."
            : "FreeJam started. Copy the invite link from the FreeJam panel.",
          false,
          6000
        );
      } else {
        Spicetify.showNotification(
          "FreeJam started, but the invite link needs to be added manually in the panel.",
          true,
          8000
        );
      }
    } finally {
      busy = false;
    }
  }

  function endSession() {
    clearTimeout(pollTimer);
    pollTimer = null;

    const hadPlaylist = Boolean(state.playlistUrl);
    const lastRelayUrl = state.lastRelayUrl;
    if (hadPlaylist) clearFriendsJam();
    sessionToken += 1;
    state = defaultState();
    state.lastRelayUrl = lastRelayUrl;
    seen = new Set();
    endArmedUntil = 0;

    if (sync.role || state.lastRelayUrl) {
      saveState();
    } else {
      try {
        Spicetify.LocalStorage.remove(STORAGE_KEY);
      } catch (err) {
        console.warn("[FreeJam] Could not clear saved session", err);
      }
    }

    updateButton();
    updatePanel(true);
    Spicetify.showNotification(
      hadPlaylist
        ? "FreeJam request session ended. The playlist was left in your library."
        : "FreeJam request session ended.",
      false,
      5000
    );
  }

  async function regenerateInvite() {
    if (!state.playlistUri) return;
    if (busy) return;

    busy = true;
    try {
      const invite = await createInvite(state.playlistUri);
      state.inviteUrl = invite.url;
      state.inviteCreatedAt = Date.now();
      saveState();
      updatePanel(true);
      announceJam();
      Spicetify.showNotification("New invite link created (valid for 7 days).");
    } finally {
      busy = false;
    }
  }

  function savePastedInvite() {
    const input = $('[data-fj="pasteInvite"]', ui.root);
    const value = input ? input.value.trim() : "";
    if (!value) return;

    if (!/^https?:\/\/open\.spotify\.com\/playlist\/[A-Za-z0-9]+/.test(value)) {
      Spicetify.showNotification(
        "That doesn't look like a Spotify playlist invite link.",
        true
      );
      return;
    }

    state.inviteUrl = value;
    state.inviteCreatedAt = null;
    saveState();
    updatePanel(true);
    Spicetify.showNotification("Invite link saved.");
  }

  function inviteExpiryText() {
    if (!state.inviteCreatedAt) return null;

    const remaining = state.inviteCreatedAt + INVITE_TTL_MS - Date.now();
    if (remaining <= 0) {
      return {
        warn: true,
        text: "This invite link has expired. Create a new one.",
      };
    }

    const days = Math.floor(remaining / 86400000);
    const hours = Math.floor((remaining % 86400000) / 3600000);

    if (remaining < 86400000) {
      return {
        warn: true,
        text: `Invite expires in ${hours}h. Create a new one soon.`,
      };
    }
    return { warn: false, text: `Invite expires in ${days}d ${hours}h.` };
  }

  function openPlaylist() {
    if (!state.playlistUri) return;

    const id = playlistIdFromUri(state.playlistUri);
    try {
      Spicetify.PopupModal.hide();
    } catch {
      /* ignore */
    }

    try {
      if (Spicetify.Platform.History && Spicetify.Platform.History.push) {
        Spicetify.Platform.History.push(`/playlist/${id}`);
        return;
      }
    } catch (err) {
      console.warn("[FreeJam] Could not navigate to the playlist", err);
    }

    if (state.playlistUrl) window.open(state.playlistUrl, "_blank");
  }

  // ---------------------------------------------------------------------------
  // Sync mode: transport
  // ---------------------------------------------------------------------------

  function sendSync(message) {
    if (!sync.ws || sync.ws.readyState !== WebSocket.OPEN) return false;
    try {
      sync.ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      console.warn("[FreeJam] Could not send a sync message", err);
      return false;
    }
  }

  function connectSync() {
    if (!sync.role || !sync.relayUrl || !sync.sessionId || !sync.key) return;

    closeSyncSocket();
    sync.selfId = randomId(8);
    sync.error = null;

    let url;
    try {
      url = new URL(sync.relayUrl);
      url.searchParams.set("session", sync.sessionId);
      url.searchParams.set("key", sync.key);
      url.searchParams.set("id", sync.selfId);
      url.searchParams.set(
        "name",
        sync.name || (sync.role === "host" ? "Host" : "Guest")
      );
      url.searchParams.set("role", sync.role);
      if (friends.identity && friends.identity.userId) {
        url.searchParams.set("uid", friends.identity.userId);
      }
    } catch (err) {
      sync.error = "Invalid relay URL.";
      refreshSyncPanel();
      return;
    }

    let socket;
    try {
      socket = new WebSocket(url.toString());
    } catch (err) {
      sync.error = "Could not open the relay connection.";
      refreshSyncPanel();
      scheduleSyncReconnect();
      return;
    }

    sync.ws = socket;

    socket.onopen = () => {
      if (sync.ws !== socket) return;
      sync.connected = true;
      sync.error = null;
      sync.reconnectDelay = 1000;
      sync.lastLocal = null;
      sendSync({ t: "hello", name: sync.name, role: sync.role });
      startSyncTimers();
      if (sync.role === "guest") sendSync({ t: "cmd", action: "sync" });
      refreshPanelSections();
    };

    socket.onmessage = (event) => {
      if (sync.ws !== socket) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      handleSyncMessage(message);
    };

    socket.onerror = () => {
      if (sync.ws !== socket) return;
      sync.error = "Relay connection error.";
      refreshPanelSections();
    };

    socket.onclose = (event) => {
      if (sync.ws !== socket) return;
      sync.connected = false;
      sync.ws = null;
      stopSyncTimers();

      const code = event && Number(event.code);
      if (code === 4003) {
        sync.error = "The session key is wrong. Leave and join with a new code.";
      } else if (code === 4004) {
        sync.error = "The host is not online yet. Waiting for the host…";
      } else if (code === 4009) {
        sync.error = "This sync session is full.";
      } else if (code === 4005) {
        sync.error = "This host connection was replaced by a newer one.";
      } else if (code === 4006) {
        // The host removed this guest. Do not reconnect.
        sync.error = "You were removed from the sync session by the host.";
        leaveSync(true);
        Spicetify.showNotification(
          "You were removed from the sync session by the host.",
          true,
          6000
        );
        return;
      }

      refreshPanelSections();

      // A wrong key, a full room, or a replaced host will not fix itself by
      // retrying — and reconnecting as the replaced host would fight forever.
      if (sync.role && code !== 4003 && code !== 4009 && code !== 4005) {
        scheduleSyncReconnect();
      }
    };
  }

  function closeSyncSocket() {
    clearTimeout(sync.reconnectTimer);
    sync.reconnectTimer = null;
    stopSyncTimers();

    const socket = sync.ws;
    sync.ws = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }

    sync.connected = false;
    sync.members = [];
    sync.hostId = null;
    sync.hostName = null;
    sync.lastLocal = null;
  }

  function scheduleSyncReconnect() {
    if (!sync.role) return;
    clearTimeout(sync.reconnectTimer);

    const delay = sync.reconnectDelay;
    sync.reconnectTimer = setTimeout(() => {
      sync.reconnectTimer = null;
      if (sync.role && !sync.connected) connectSync();
    }, delay);

    sync.reconnectDelay = Math.min(
      Math.round(sync.reconnectDelay * 1.7),
      SYNC_RECONNECT_MAX_MS
    );
  }

  function startSyncTimers() {
    stopSyncTimers();

    sync.tickTimer = setInterval(syncTick, SYNC_TICK_MS);
    sync.stateTimer = setInterval(() => {
      if (sync.role === "host") broadcastState(false);
    }, SYNC_STATE_INTERVAL_MS);
    sync.pingTimer = setInterval(() => {
      if (!sync.connected) return;
      sync.pingId = randomId(4);
      sync.pingSentAt = Date.now();
      sendSync({ t: "ping", id: sync.pingId, ts: sync.pingSentAt });
    }, SYNC_PING_INTERVAL_MS);
  }

  function stopSyncTimers() {
    clearInterval(sync.tickTimer);
    clearInterval(sync.stateTimer);
    clearInterval(sync.pingTimer);
    sync.tickTimer = null;
    sync.stateTimer = null;
    sync.pingTimer = null;
  }

  function handleSyncMessage(message) {
    if (!message || typeof message !== "object") return;

    if (message.t === "presence") {
      sync.members = Array.isArray(message.members) ? message.members : [];
      const host = sync.members.find(
        (member) => member && member.role === "host"
      );
      if (host) {
        sync.hostId = host.id;
        sync.hostName = host.name || "the host";
      } else if (sync.role === "guest") {
        sync.hostId = null;
        sync.hostName = null;
      }
      refreshPanelSections();
      return;
    }

    if (message.t === "pong") {
      if (message.id && message.id === sync.pingId) {
        const rtt = Date.now() - (sync.pingSentAt || Date.now());
        sync.latencyMs = Math.max(0, Math.min(500, Math.round(rtt / 2)));
      }
      return;
    }

    if (message.t === "state") {
      if (sync.role !== "guest") return;
      if (message.from === sync.selfId) return;
      applyRemoteState(message);
      return;
    }

    if (message.t === "cmd") {
      if (sync.role !== "host") return;
      if (message.from === sync.selfId) return;
      handleRemoteCommand(message);
      return;
    }

    if (message.t === "kicked") {
      if (sync.role !== "guest") return;
      const by = String(message.by || "the host");
      leaveSync(true);
      Spicetify.showNotification(
        `Removed from the sync session by ${by}.`,
        true,
        6000
      );
      return;
    }

    if (message.t === "error") {
      sync.error = String(message.message || "Relay error.");
      refreshPanelSections();
    }
  }

  // ---------------------------------------------------------------------------
  // Sync mode: playback
  // ---------------------------------------------------------------------------

  function isLocalPlaying() {
    const local = Spicetify.Player.origin && Spicetify.Player.origin._state;
    return local ? !local.isPaused : false;
  }

  function isLocalAd() {
    const local = Spicetify.Player.origin && Spicetify.Player.origin._state;
    if (!local) return false;
    if (local.adBreakContext) return true;
    const item = local.item;
    return Boolean(
      item &&
        (item.isAd ||
          item.type === "ad" ||
          item.metadata?.["is_ad"] === "true")
    );
  }

  function getLocalPosition() {
    const local = Spicetify.Player.origin && Spicetify.Player.origin._state;
    if (!local) return 0;

    const base = Number(local.positionAsOfTimestamp) || 0;
    // Spotify freezes the playhead while paused or buffering. Advancing it
    // there would make us think the user had seeked when playback resumed.
    if (local.isPaused || local.isBuffering) return base;

    const timestamp = Number(local.timestamp) || Date.now();
    const speed = Number(local.speed);
    const rate = Number.isFinite(speed) && speed > 0 ? speed : 1;
    return base + Math.max(0, Date.now() - timestamp) * rate;
  }

  function isSyncableUri(uri) {
    return (
      typeof uri === "string" &&
      (uri.startsWith("spotify:track:") || uri.startsWith("spotify:episode:"))
    );
  }

  function getLocalState() {
    const local = Spicetify.Player.origin && Spicetify.Player.origin._state;
    if (!local || !local.item) return null;

    const item = local.item;
    const artists = Array.isArray(item.artists)
      ? item.artists
          .map((artist) => (artist ? artist.name : null))
          .filter(Boolean)
          .join(", ")
      : "";

    return {
      uri: item.uri,
      name: item.name || "",
      artists,
      pos: getLocalPosition(),
      paused: Boolean(local.isPaused),
      duration: Number(local.duration) || 0,
      at: Date.now(),
    };
  }

  function playTrack(uri) {
    if (typeof Spicetify.Player.playUri === "function") {
      return Spicetify.Player.playUri(uri);
    }
    if (
      Spicetify.Platform.PlayerAPI &&
      typeof Spicetify.Platform.PlayerAPI.play === "function"
    ) {
      return Spicetify.Platform.PlayerAPI.play({ uri }, {}, {});
    }
    throw new Error("Playback API unavailable.");
  }

  function broadcastState(force) {
    if (sync.role !== "host" || !sync.connected) return;
    // Ads are per-listener. Never push an ad to guests, and never pull a guest
    // out of an ad it is currently required to hear.
    if (isLocalAd()) return;

    const snapshot = getLocalState();
    if (!snapshot || !isSyncableUri(snapshot.uri)) return;

    const now = Date.now();
    if (!force && now - sync.lastBroadcastAt < 1200) return;
    sync.lastBroadcastAt = now;

    sendSync({
      t: "state",
      from: sync.selfId,
      uri: snapshot.uri,
      name: snapshot.name,
      artists: snapshot.artists,
      pos: Math.round(snapshot.pos),
      paused: snapshot.paused,
      duration: Math.round(snapshot.duration),
      at: now,
    });
  }

  function clampPosition(value, duration) {
    const position = Math.max(0, Math.round(Number(value) || 0));
    if (!duration || duration <= 0) return position;
    return Math.min(position, Math.max(0, Math.round(duration) - 250));
  }

  function noteLocalPosition(position) {
    const snapshot = getLocalState();
    if (!snapshot) return;
    snapshot.pos = Math.max(0, Number(position) || 0);
    snapshot.at = Date.now();
    sync.lastLocal = snapshot;
  }

  // Applying a track takes a moment (the player has to load it), so the
  // alignment seek runs a little later. Any newer local action or newer host
  // state must cancel that pending seek — otherwise it lands on top of a fresh
  // skip or seek and drags playback back.
  function beginApply() {
    sync.applyToken += 1;
    return sync.applyToken;
  }

  function cancelPendingApply() {
    sync.applyToken += 1;
  }

  function applyRemoteState(message) {
    if (!message || !isSyncableUri(message.uri)) return;
    // Let a free account finish its ad. The next host broadcast catches it up.
    if (isLocalAd()) return;
    // The host broadcasts every couple of seconds. A state message already in
    // flight when this guest issued a command describes the situation before
    // that command, so applying it would undo the guest's own skip or seek.
    if (Date.now() < sync.ignoreStateUntil) return;
    const receivedAt = Date.now();
    const paused = Boolean(message.paused);
    const latency = Math.max(0, Math.min(500, sync.latencyMs || 0));
    const baseTarget = Math.max(
      0,
      Math.round((Number(message.pos) || 0) + (paused ? 0 : latency))
    );

    const local = Spicetify.Player.origin && Spicetify.Player.origin._state;
    const currentUri = local && local.item ? local.item.uri : null;
    const currentPaused = local ? Boolean(local.isPaused) : true;
    const currentPos = getLocalPosition();
    const duration = local ? Number(local.duration) || 0 : 0;

    const needsTrack = currentUri !== message.uri;
    const needsPause = !needsTrack && currentPaused !== paused;
    const needsSeek =
      !needsTrack &&
      Math.abs(currentPos - baseTarget) > SYNC_DRIFT_THRESHOLD_MS;

    if (!needsTrack && !needsPause && !needsSeek) return;

    const applyToken = beginApply();
    sync.applyingUntil = receivedAt + 1500;
    // Remember the pause state we are applying so the resulting play/pause
    // event is not echoed back, while the opposite user action still is.
    sync.appliedPaused = paused;
    sync.appliedPausedUntil = receivedAt + 1500;

    if (needsTrack) {
      // Remember the track we are applying so the guest's own songchange
      // handler does not echo it back as a user action.
      sync.expectedUri = message.uri;
      sync.expectedUntil = receivedAt + SYNC_TRACK_GRACE_MS;

      Promise.resolve()
        .then(() => playTrack(message.uri))
        .then(() => {
          if (paused) Spicetify.Player.pause();
          setTimeout(() => {
            // A newer apply or a local skip/seek happened while the track was
            // loading. Do not drag playback back to the old position.
            if (applyToken !== sync.applyToken) {
              sync.expectedUntil = 0;
              return;
            }
            try {
              const target = clampPosition(
                paused ? baseTarget : baseTarget + (Date.now() - receivedAt),
                duration
              );
              Spicetify.Player.seek(target);
              noteLocalPosition(target);
              if (!paused && !isLocalPlaying()) {
                Spicetify.Player.play();
              }
              sync.expectedUntil = 0;
            } catch (err) {
              console.warn("[FreeJam] Could not align playback", err);
            }
          }, 350);
        })
        .catch((err) => {
          console.warn("[FreeJam] Could not play the host's track", err);
          sync.error =
            "Could not play the host's track. Is it available on your account?";
          refreshSyncPanel();
        });
      return;
    }

    if (needsPause) {
      if (paused) Spicetify.Player.pause();
      else Spicetify.Player.play();
    }

    if (needsSeek) {
      try {
        const target = clampPosition(
          paused ? baseTarget : baseTarget + (Date.now() - receivedAt),
          duration
        );
        Spicetify.Player.seek(target);
        noteLocalPosition(target);
      } catch (err) {
        console.warn("[FreeJam] Could not seek", err);
      }
    }
  }

  function handleRemoteCommand(message) {
    const now = Date.now();
    sync.applyingUntil = now + 1200;

    switch (message.action) {
      case "track": {
        // A guest skipped or picked a track. The guest sends the exact URI it
        // landed on, so next/previous/arbitrary picks all resolve to the same
        // song on the host instead of guessing a direction.
        if (!isSyncableUri(message.uri)) break;

        const paused = Boolean(message.paused);
        const requested = Math.max(0, Number(message.value) || 0);
        sync.applyingUntil = now + SYNC_TRACK_GRACE_MS;
        const applyToken = beginApply();

        Promise.resolve()
          .then(() => playTrack(message.uri))
          .then(() => {
            if (paused) Spicetify.Player.pause();
            setTimeout(() => {
              if (applyToken !== sync.applyToken) return;
              try {
                const local =
                  Spicetify.Player.origin && Spicetify.Player.origin._state;
                const duration = local ? Number(local.duration) || 0 : 0;
                Spicetify.Player.seek(clampPosition(requested, duration));
                if (!paused && !isLocalPlaying()) Spicetify.Player.play();
              } catch (err) {
                console.warn("[FreeJam] Could not align the guest's track", err);
              }
              sync.applyingUntil = 0;
              broadcastState(true);
            }, 350);
          })
          .catch((err) => {
            console.warn("[FreeJam] Could not play the guest's track", err);
            sync.applyingUntil = 0;
            broadcastState(true);
          });
        return;
      }
      case "next":
        Spicetify.Player.next();
        break;
      case "prev":
        Spicetify.Player.back();
        break;
      case "pause":
        Spicetify.Player.pause();
        break;
      case "play":
        Spicetify.Player.play();
        break;
      case "seek": {
        const local =
          Spicetify.Player.origin && Spicetify.Player.origin._state;
        const duration = (local && Number(local.duration)) || 0;
        Spicetify.Player.seek(
          clampPosition(Number(message.value) || 0, duration)
        );
        break;
      }
      case "queue": {
        if (isSyncableUri(message.uri)) {
          try {
            Spicetify.addToQueue([{ uri: message.uri }]);
          } catch (err) {
            console.warn("[FreeJam] Could not queue a remote track", err);
          }
        }
        break;
      }
      case "sync":
      default:
        break;
    }

    setTimeout(() => {
      sync.applyingUntil = 0;
      broadcastState(true);
    }, 250);
  }

  function sendCommand(action, value, extra) {
    if (!sync.connected) return false;

    const now = Date.now();
    // Coalesce rapid seek updates (a slider drag), but never drop a discrete
    // skip, pause, or play just because it follows another command closely.
    if (action === "seek" && now - sync.lastCmdAt < 180) return false;
    sync.lastCmdAt = now;
    sync.applyingUntil = now + 1200;
    sync.ignoreStateUntil = now + SYNC_CMD_GRACE_MS;
    // A local action supersedes any alignment seek still waiting to run.
    cancelPendingApply();

    const message = { t: "cmd", action, value, at: now };
    if (extra) Object.assign(message, extra);
    return sendSync(message);
  }

  function isExpectedRemoteChange(local) {
    return Boolean(
      local &&
        sync.expectedUri &&
        local.uri === sync.expectedUri &&
        Date.now() < sync.expectedUntil
    );
  }

  function onLocalSongChange() {
    if (sync.role === "host") {
      setTimeout(() => broadcastState(true), 150);
      return;
    }
    if (sync.role !== "guest" || !sync.connected) return;

    sync.trackChangedAt = Date.now();

    if (isLocalAd()) return;

    const local = getLocalState();
    if (isExpectedRemoteChange(local)) {
      sync.expectedUntil = 0;
      return;
    }
    // Do not gate this on applyingUntil: a real skip by the guest can happen
    // while a remote seek/pause is still settling, and dropping it would leave
    // the guest fighting the host's next broadcast.

    const prev = sync.lastLocal;
    const manual =
      Date.now() - sync.manualSkipAt < SYNC_TRACK_GRACE_MS;
    if (
      !manual &&
      prev &&
      prev.duration > 0 &&
      prev.pos >= prev.duration - 3000
    ) {
      // Natural end of the track. The host advances everyone.
      return;
    }

    if (!local || !isSyncableUri(local.uri)) return;

    // Send the exact track the guest landed on. This makes next, previous and
    // clicking an arbitrary song all deterministic on the host.
    sendCommand("track", Math.round(local.pos), {
      uri: local.uri,
      paused: local.paused,
    });
  }

  function onLocalPlayPause() {
    if (sync.role === "host") {
      setTimeout(() => broadcastState(true), 100);
      return;
    }
    if (sync.role !== "guest" || !sync.connected) return;
    if (isLocalAd()) return;
    if (isExpectedRemoteChange(getLocalState())) return;
    // Ignore only the event produced by a state we just applied. If the user
    // did the opposite (paused after a remote play, etc.) it still goes out.
    if (
      sync.appliedPaused !== null &&
      Date.now() < sync.appliedPausedUntil &&
      isLocalPlaying() === !sync.appliedPaused
    ) {
      return;
    }

    const prev = sync.lastLocal;
    if (prev && prev.duration > 0 && prev.pos >= prev.duration - 3000) {
      return;
    }

    sendCommand(isLocalPlaying() ? "play" : "pause");
  }

  function hostTick() {
    const snapshot = getLocalState();
    if (!snapshot) return;

    const prev = sync.lastLocal;
    sync.lastLocal = snapshot;

    const local = Spicetify.Player.origin && Spicetify.Player.origin._state;
    if (local && local.isBuffering) return;

    if (!prev) {
      broadcastState(true);
      return;
    }

    if (prev.uri !== snapshot.uri || prev.paused !== snapshot.paused) {
      broadcastState(true);
      return;
    }

    const expected = prev.paused
      ? prev.pos
      : prev.pos + (snapshot.at - prev.at);

    if (Math.abs(snapshot.pos - expected) > SYNC_HOST_SEEK_THRESHOLD_MS) {
      broadcastState(true);
    }
  }

  function guestTick() {
    const snapshot = getLocalState();
    if (!snapshot) return;

    let prev = sync.lastLocal;
    sync.lastLocal = snapshot;

    const local = Spicetify.Player.origin && Spicetify.Player.origin._state;
    if (isLocalAd() || (local && local.isBuffering)) return;
    if (!prev) return;
    if (isExpectedRemoteChange(snapshot)) return;
    if (prev.paused !== snapshot.paused) return;

    if (prev.uri !== snapshot.uri) {
      // The track changed between two ticks (a skip, or the host moved on).
      // Baseline from the start of the new track so a seek made inside the
      // same tick window is still detected instead of being swallowed.
      const changedAt = sync.trackChangedAt;
      if (!changedAt || snapshot.at - changedAt > SYNC_TRACK_GRACE_MS) return;
      prev = {
        uri: snapshot.uri,
        pos: 0,
        paused: snapshot.paused,
        at: changedAt,
      };
    }

    const expected = prev.paused
      ? prev.pos
      : prev.pos + (snapshot.at - prev.at);

    // Best-effort detection of a native seek by the guest. The FreeJam seek
    // slider is exact; the host's next state broadcast also corrects tiny
    // drift that falls below this threshold.
    if (Math.abs(snapshot.pos - expected) > SYNC_SEEK_THRESHOLD_MS) {
      sendCommand("seek", Math.round(snapshot.pos));
    }
  }

  function syncTick() {
    if (!sync.connected) return;

    if (sync.role === "host") hostTick();
    else if (sync.role === "guest") guestTick();

    if (Date.now() - sync.lastPanelUpdate >= 1000) {
      sync.lastPanelUpdate = Date.now();
      updateSyncControls();
    }
  }

  function leaveSync(silent = false) {
    if (sync.role === "host") clearFriendsJam();
    closeSyncSocket();

    sync.role = null;
    sync.relayUrl = "";
    sync.sessionId = "";
    sync.key = "";
    sync.name = "";
    sync.error = null;
    sync.latencyMs = 0;
    sync.applyingUntil = 0;
    sync.appliedPaused = null;
    sync.appliedPausedUntil = 0;
    sync.expectedUri = null;
    sync.expectedUntil = 0;
    sync.manualSkipAt = 0;
    sync.ignoreStateUntil = 0;
    sync.applyToken = 0;
    sync.trackChangedAt = 0;
    sync.lastCmdAt = 0;
    sync.reconnectDelay = 1000;

    if (state.playlistUri || state.lastRelayUrl) {
      saveState();
    } else {
      try {
        Spicetify.LocalStorage.remove(STORAGE_KEY);
      } catch {
        /* ignore */
      }
    }

    refreshPanelSections();
    if (!silent) {
      Spicetify.showNotification("Left the playback sync session.");
    }
  }

  // ---------------------------------------------------------------------------
  // Friends: mailboxes and jam alerts
  // ---------------------------------------------------------------------------

  function friendIdentityName() {
    return (
      (friends.identity && friends.identity.name) ||
      sync.name ||
      "A friend"
    );
  }

  function sendFriends(message) {
    if (!friends.ws || friends.ws.readyState !== WebSocket.OPEN) return false;
    try {
      friends.ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      console.warn("[FreeJam] Could not send a friend message", err);
      return false;
    }
  }

  function connectFriends() {
    if (!friends.identity || !friends.identity.relayUrl) return;

    closeFriendsSocket();
    friends.selfId = randomId(8);
    friends.error = null;
    friends.relayUrl = friends.identity.relayUrl;

    let url;
    try {
      url = new URL(friends.relayUrl);
      url.searchParams.set("user", friends.identity.userId);
      url.searchParams.set("key", friends.identity.recvKey);
      url.searchParams.set("id", friends.selfId);
      url.searchParams.set("name", friendIdentityName());
      url.searchParams.set("client", "app");
    } catch {
      friends.error = "Invalid relay URL.";
      refreshFriendsPanel();
      return;
    }

    let socket;
    try {
      socket = new WebSocket(url.toString());
    } catch {
      friends.error = "Could not open the relay connection.";
      refreshFriendsPanel();
      scheduleFriendsReconnect();
      return;
    }

    friends.ws = socket;

    socket.onopen = () => {
      if (friends.ws !== socket) return;
      friends.connected = true;
      friends.error = null;
      friends.reconnectDelay = 1000;
      friends.handshaken = false;

      sendFriends({
        t: "hello",
        name: friendIdentityName(),
        sendKey: friends.identity.sendKey,
      });
      watchFriends();
      startFriendsPing();
      flushPendingJam();
      refreshFriendsPanel();

      clearTimeout(friends.handshakeTimer);
      friends.handshakeTimer = setTimeout(() => {
        if (
          friends.ws === socket &&
          friends.connected &&
          !friends.handshaken
        ) {
          friends.error =
            "The relay did not answer the friend handshake. Update freejam-relay.js on the relay.";
          refreshFriendsPanel();
        }
      }, 6000);
    };

    socket.onmessage = (event) => {
      if (friends.ws !== socket) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      handleFriendsMessage(message);
    };

    socket.onerror = () => {
      if (friends.ws !== socket) return;
      friends.error = "Friend relay connection error.";
      refreshFriendsPanel();
    };

    socket.onclose = (event) => {
      if (friends.ws !== socket) return;
      friends.connected = false;
      friends.ws = null;
      friends.online = new Set();
      friends.handshaken = false;
      clearTimeout(friends.handshakeTimer);
      friends.handshakeTimer = null;
      stopFriendsPing();

      const code = event && Number(event.code);
      if (code === 4003) {
        friends.error =
          "This friend identity belongs to another key. Recreate your friend code.";
      } else if (code === 4009) {
        friends.error = "Too many connections to your friend mailbox.";
      } else if (!friends.error) {
        friends.error =
          "Could not connect to the friend relay. Make sure it is running the current freejam-relay.js.";
      }

      refreshFriendsPanel();
      if (friends.identity && code !== 4003) scheduleFriendsReconnect();
    };
  }

  function closeFriendsSocket() {
    clearTimeout(friends.reconnectTimer);
    friends.reconnectTimer = null;
    clearTimeout(friends.handshakeTimer);
    friends.handshakeTimer = null;
    friends.handshaken = false;
    stopFriendsPing();

    const socket = friends.ws;
    friends.ws = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }

    friends.connected = false;
    friends.online = new Set();
  }

  function scheduleFriendsReconnect() {
    if (!friends.identity || !friends.identity.relayUrl) return;
    clearTimeout(friends.reconnectTimer);

    const delay = friends.reconnectDelay;
    friends.reconnectTimer = setTimeout(() => {
      friends.reconnectTimer = null;
      if (friends.identity && !friends.connected) connectFriends();
    }, delay);

    friends.reconnectDelay = Math.min(
      Math.round(friends.reconnectDelay * 1.7),
      FRIEND_RECONNECT_MAX_MS
    );
  }

  function startFriendsPing() {
    stopFriendsPing();
    friends.pingTimer = setInterval(() => {
      if (!friends.connected) return;
      friends.pingId = randomId(4);
      friends.pingSentAt = Date.now();
      sendFriends({ t: "ping", id: friends.pingId, ts: friends.pingSentAt });
    }, FRIEND_PING_INTERVAL_MS);
  }

  function stopFriendsPing() {
    clearInterval(friends.pingTimer);
    friends.pingTimer = null;
  }

  function watchFriends() {
    sendFriends({
      t: "watch",
      ids: friends.list.map((friend) => friend.userId),
    });
  }

  function flushPendingJam() {
    if (!friends.connected || !friends.pendingJam) return;
    const jam = friends.pendingJam;
    friends.pendingJam = null;
    for (const friend of friends.list) {
      sendFriends({
        t: "dm",
        to: friend.userId,
        sendKey: friend.sendKey,
        jam,
      });
    }
  }

  function buildLocalJam() {
    if (sync.role === "host" && sync.sessionId) {
      return {
        mode: "sync",
        hostName: friendIdentityName(),
        joinCode: encodeJoinCode({
          relayUrl: sync.relayUrl,
          sessionId: sync.sessionId,
          key: sync.key,
        }),
        sessionId: sync.sessionId,
        inviteUrl: "",
        expiresAt: 0,
      };
    }

    if (state.playlistUri && state.inviteUrl) {
      return {
        mode: "request",
        hostName: friendIdentityName(),
        joinCode: "",
        sessionId: "",
        inviteUrl: state.inviteUrl,
        expiresAt:
          (state.inviteCreatedAt || Date.now()) + INVITE_TTL_MS,
      };
    }

    return null;
  }

  function announceJam() {
    if (!friends.identity) return false;

    const jam = buildLocalJam();
    if (!jam) return false;

    friends.pendingJam = jam;
    if (friends.connected) {
      flushPendingJam();
    } else if (friends.identity && friends.identity.relayUrl) {
      connectFriends();
    }

    return friends.list.length > 0;
  }

  function clearFriendsJam() {
    if (!friends.connected) return;
    for (const friend of friends.list) {
      sendFriends({
        t: "jam-clear",
        to: friend.userId,
        sendKey: friend.sendKey,
      });
    }
  }

  function setIncomingJam(jam) {
    friends.incomingJam = jam;
    if (jam.mode === "request" && jam.expiresAt && jam.expiresAt <= Date.now()) {
      friends.incomingJam = null;
      return;
    }

    if (
      !jam.suppressNotify &&
      Date.now() - friends.lastNotifyAt >= FRIEND_JAM_NOTIFY_COOLDOWN_MS
    ) {
      friends.lastNotifyAt = Date.now();
      showJamAlert(jam);
    }

    updateButton();
    refreshFriendsPanel();
  }

  function clearIncomingJam() {
    friends.incomingJam = null;
    updateButton();
    refreshFriendsPanel();
  }

  function handleFriendsMessage(message) {
    if (!message || typeof message !== "object") return;

    if (message.t === "hello-ok") {
      friends.handshaken = true;
      clearTimeout(friends.handshakeTimer);
      friends.handshakeTimer = null;

      if (
        friends.identity &&
        typeof message.sendKey === "string" &&
        message.sendKey &&
        message.sendKey !== friends.identity.sendKey
      ) {
        // The relay learned a different send key (for example a friend sent an
        // invite before this device first connected). The recv key proves we
        // own the mailbox, so re-register our key.
        sendFriends({
          t: "hello",
          name: friendIdentityName(),
          sendKey: friends.identity.sendKey,
        });
      }
      flushPendingJam();
      refreshFriendsPanel();
      return;
    }

    if (message.t === "presence") {
      friends.online = new Set(
        Array.isArray(message.online) ? message.online : []
      );
      refreshFriendsPanel();
      return;
    }

    if (message.t === "pong") {
      if (message.id && message.id === friends.pingId) {
        const rtt = Date.now() - (friends.pingSentAt || Date.now());
        friends.latencyMs = Math.max(0, Math.min(500, Math.round(rtt / 2)));
      }
      return;
    }

    if (message.t === "jam") {
      // Only accept jams from people this user explicitly added. This is the
      // final guard: even if the relay forwarded something, it never reaches
      // the UI unless the sender is in the local friend list.
      const friend = friends.list.find(
        (entry) => entry.userId === message.from
      );
      if (!friend) return;
      setIncomingJam(message);
      return;
    }

    if (message.t === "jam-clear") {
      if (friends.incomingJam && friends.incomingJam.from === message.from) {
        clearIncomingJam();
      }
      return;
    }

    if (message.t === "error") {
      friends.error = String(message.message || "Friend relay error.");
      refreshFriendsPanel();
    }
  }

  function joinIncomingJam() {
    const jam = friends.incomingJam;
    if (!jam) return;

    if (jam.mode === "sync") {
      if (sync.role === "host") {
        Spicetify.showNotification(
          "Leave your own sync session before joining a friend's.",
          true
        );
        return;
      }

      const config = decodeJoinCode(jam.joinCode);
      if (!config) {
        Spicetify.showNotification("This jam invite is invalid or expired.", true);
        return;
      }

      sync.role = "guest";
      sync.relayUrl = normalizeRelayUrl(config.relayUrl);
      sync.sessionId = config.sessionId;
      sync.key = config.key;
      sync.name = sync.name || friendIdentityName();
      sync.error = null;
      sync.reconnectDelay = 1000;
      state.lastRelayUrl = sync.relayUrl;
      saveState();
      connectSync();
      refreshPanelSections();
      Spicetify.showNotification(`Joining ${jam.fromName || "your friend"}'s sync.`);
      clearIncomingJam();
      return;
    }

    if (jam.mode === "request") {
      if (!jam.inviteUrl) {
        Spicetify.showNotification("This invite link is missing.", true);
        return;
      }
      copyText(jam.inviteUrl);
      try {
        window.open(jam.inviteUrl, "_blank");
      } catch {
        /* ignore */
      }
      Spicetify.showNotification(
        "Invite link copied and opened. Add songs from the Spotify app.",
        false,
        6000
      );
      clearIncomingJam();
    }
  }

  function friendInviteMessage() {
    if (!friends.identity) return "";
    const code = encodeFriendCode(friends.identity);
    const jam = buildLocalJam();
    const lines = [];

    if (jam && jam.mode === "sync") {
      lines.push(`${friendIdentityName()} is hosting a FreeJam playback sync.`);
      lines.push(`Join code: ${jam.joinCode}`);
    } else if (jam && jam.mode === "request") {
      lines.push(`${friendIdentityName()} started a FreeJam listening session.`);
      lines.push(`Add songs here: ${jam.inviteUrl}`);
    } else {
      lines.push(`${friendIdentityName()} invited you to FreeJam.`);
    }

    lines.push("");
    lines.push(`Add me as a friend in FreeJam with this code:`);
    lines.push(code);
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Panel UI
  // ---------------------------------------------------------------------------

  function injectStyles() {
    if (document.querySelector("style.freejam-styles")) return;

    const style = document.createElement("style");
    style.className = "freejam-styles";
    style.textContent = `
      .fj-root {
        --fj-accent: var(--spice-button, #1db954);
        --fj-accent-soft: rgba(29, 185, 84, 0.16);
        --fj-border: rgba(255, 255, 255, 0.09);
        --fj-border-strong: rgba(255, 255, 255, 0.18);
        --fj-radius: 14px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 0 22px 24px;
        color: var(--spice-text, #fff);
        font-size: 14px;
        line-height: 1.45;
      }
      .fj-root *,
      .fj-root *::before,
      .fj-root *::after {
        box-sizing: border-box;
      }
      .fj-root [hidden] {
        display: none !important;
      }
      /* The panel scrolls inside itself; Spotify's own modal frame is left alone. */
      .fj-root {
        max-height: min(70vh, 640px);
        overflow-y: auto;
        overscroll-behavior: contain;
      }
      .fj-section > summary { cursor: pointer; }
      .fj-block {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .fj-section {
        border: 1px solid var(--fj-border);
        border-radius: var(--fj-radius);
        background: linear-gradient(
          180deg,
          rgba(255, 255, 255, 0.045),
          rgba(255, 255, 255, 0.015)
        );
        overflow: hidden;
        transition: border-color 0.15s ease;
      }
      .fj-section:hover {
        border-color: var(--fj-border-strong);
      }
      .fj-section > summary {
        position: relative;
        display: flex;
        align-items: baseline;
        gap: 8px;
        padding: 13px 44px 13px 16px;
        cursor: pointer;
        font-weight: 700;
        font-size: 13px;
        list-style: none;
        user-select: none;
      }
      .fj-section > summary:focus-visible,
      .fj-input:focus-visible {
        outline: 3px solid #7fc8ff;
        outline-offset: 2px;
      }
      .fj-section > summary::-webkit-details-marker {
        display: none;
      }
      .fj-section > summary::after {
        content: "";
        position: absolute;
        top: 50%;
        right: 18px;
        width: 8px;
        height: 8px;
        margin-top: -6px;
        border-right: 2px solid var(--spice-subtext, #b3b3b3);
        border-bottom: 2px solid var(--spice-subtext, #b3b3b3);
        transform: rotate(45deg);
        transition: transform 0.15s ease, margin-top 0.15s ease;
      }
      .fj-section[open] > summary::after {
        margin-top: -2px;
        transform: rotate(-135deg);
      }
      .fj-section-label {
        color: var(--spice-text, #fff);
      }
      .fj-section-sub {
        color: var(--spice-subtext, #b3b3b3);
        font-size: 11px;
        font-weight: 500;
      }
      .fj-section-body {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 0 14px 14px;
      }
      .fj-status {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 11px 13px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.055);
        font-size: 13px;
      }
      .fj-root > .fj-status {
        padding: 14px 16px;
        border: 1px solid var(--fj-border);
        border-radius: var(--fj-radius);
        background:
          radial-gradient(
            130% 180% at 0% 0%,
            rgba(29, 185, 84, 0.2),
            transparent 62%
          ),
          linear-gradient(
            135deg,
            rgba(255, 255, 255, 0.07),
            rgba(255, 255, 255, 0.015)
          );
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
      }
      .fj-dot {
        width: 8px;
        height: 8px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: var(--fj-accent, #1db954);
        box-shadow: 0 0 0 4px rgba(29, 185, 84, 0.18);
      }
      .fj-dot.off {
        background: #888;
        box-shadow: none;
      }
      .fj-card {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 16px;
        border: 1px solid var(--fj-border);
        border-radius: 12px;
        background: linear-gradient(
          180deg,
          rgba(255, 255, 255, 0.045),
          rgba(255, 255, 255, 0.015)
        );
      }
      .fj-card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .fj-card-title {
        font-weight: 700;
        font-size: 14px;
        letter-spacing: 0.01em;
      }
      .fj-subtitle {
        font-weight: 700;
        font-size: 12px;
        letter-spacing: 0.02em;
      }
      .fj-badge {
        padding: 3px 10px;
        border: 1px solid rgba(29, 185, 84, 0.24);
        border-radius: 999px;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        background: var(--fj-accent-soft, rgba(29, 185, 84, 0.16));
        color: #1ed760;
        white-space: nowrap;
      }
      .fj-badge.off {
        border-color: var(--fj-border);
        background: rgba(255, 255, 255, 0.08);
        color: var(--spice-subtext, #b3b3b3);
      }
      .fj-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .fj-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        padding-top: 2px;
      }
      .fj-divider {
        height: 1px;
        margin: 2px 0;
        background: rgba(255, 255, 255, 0.08);
      }
      .fj-input {
        flex: 1 1 auto;
        min-width: 0;
        padding: 10px 12px;
        border: 1px solid var(--fj-border);
        border-radius: 10px;
        outline: none;
        color: inherit;
        background: rgba(0, 0, 0, 0.2);
        font: inherit;
        font-size: 13px;
        transition: border-color 0.15s ease, box-shadow 0.15s ease,
          background 0.15s ease;
      }
      .fj-input::placeholder {
        color: var(--spice-subtext, #b3b3b3);
        opacity: 0.8;
      }
      .fj-input:hover {
        border-color: var(--fj-border-strong);
      }
      .fj-input:focus {
        border-color: var(--fj-accent, #1db954);
        background: rgba(0, 0, 0, 0.26);
        box-shadow: 0 0 0 3px var(--fj-accent-soft, rgba(29, 185, 84, 0.16));
      }
      .fj-name {
        flex: 0 1 140px;
      }
      .fj-mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
      }
      .fj-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        flex: 0 0 auto;
        padding: 9px 16px;
        border: 0;
        border-radius: 999px;
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        font-weight: 700;
        background: var(--fj-accent, #1db954);
        color: var(--spice-button-text, #000);
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
        transition: transform 0.1s ease, filter 0.15s ease,
          box-shadow 0.15s ease;
      }
      .fj-btn:hover {
        filter: brightness(1.08);
      }
      .fj-btn:active {
        transform: scale(0.97);
      }
      @media (prefers-reduced-motion: reduce) {
        .fj-btn {
          transition: none;
        }
        .fj-btn:active {
          transform: none;
        }
      }
      .fj-btn:focus-visible {
        outline: 2px solid var(--fj-accent, #1db954);
        outline-offset: 2px;
      }
      .fj-btn.secondary {
        background: rgba(255, 255, 255, 0.06);
        color: var(--spice-text, #fff);
        box-shadow: inset 0 0 0 1px var(--fj-border-strong);
      }
      .fj-btn.secondary:hover {
        background: rgba(255, 255, 255, 0.11);
      }
      .fj-btn.danger {
        background: transparent;
        color: #f15e6c;
        box-shadow: inset 0 0 0 1px rgba(241, 94, 108, 0.45);
      }
      .fj-btn.ghost {
        background: transparent;
        color: var(--spice-subtext, #b3b3b3);
        box-shadow: none;
      }
      .fj-btn.ghost:hover {
        color: var(--spice-text, #fff);
      }
      .fj-btn.small {
        padding: 5px 11px;
        font-size: 11px;
      }
      .fj-hint,
      .fj-muted {
        color: var(--spice-subtext, #b3b3b3);
        font-size: 12px;
        line-height: 1.5;
      }
      .fj-setting {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        padding: 12px 0;
      }
      .fj-setting + .fj-setting {
        border-top: 1px solid rgba(255, 255, 255, 0.06);
      }
      .fj-setting-text {
        min-width: 0;
      }
      .fj-setting-title {
        font-weight: 600;
        font-size: 13px;
      }
      .fj-setting-desc {
        margin-top: 2px;
        color: var(--spice-subtext, #b3b3b3);
        font-size: 12px;
        line-height: 1.4;
      }
      .fj-switch {
        position: relative;
        flex: 0 0 auto;
        width: 40px;
        height: 22px;
        padding: 0;
        border: 0;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.18);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
        cursor: pointer;
        transition: background 0.15s ease, box-shadow 0.15s ease;
      }
      .fj-switch::after {
        content: "";
        position: absolute;
        top: 3px;
        left: 3px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
        transition: transform 0.15s ease;
      }
      .fj-switch:hover {
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.24);
      }
      .fj-switch[aria-checked="true"] {
        background: var(--fj-accent, #1db954);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
      }
      .fj-switch[aria-checked="true"]::after {
        transform: translateX(18px);
      }
      .fj-switch:disabled {
        opacity: 0.45;
        cursor: default;
      }
      .fj-switch:focus-visible {
        outline: 2px solid var(--fj-accent, #1db954);
        outline-offset: 2px;
      }
      .fj-warn {
        color: #f6c358;
        font-size: 12px;
        line-height: 1.5;
      }
      .fj-now {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        font-size: 12px;
      }
      .fj-now-name {
        color: var(--spice-text, #fff);
        font-weight: 600;
      }
      .fj-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .fj-item {
        display: flex;
        gap: 12px;
        align-items: center;
        padding: 9px 8px;
        margin: 0 -8px;
        border-radius: 10px;
        transition: background 0.12s ease;
      }
      .fj-item:hover {
        background: rgba(255, 255, 255, 0.045);
      }
      .fj-item-info {
        flex: 1 1 auto;
        min-width: 0;
      }
      .fj-item-name {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .fj-item-meta {
        color: var(--spice-subtext, #b3b3b3);
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .fj-avatar {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        color: #fff;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.02em;
        background: linear-gradient(135deg, #2a6b45, #1db954);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.15);
      }
      .fj-avatar.off {
        background: linear-gradient(135deg, #3a3a3a, #565656);
        color: rgba(255, 255, 255, 0.75);
      }
      .fj-avatar .fj-dot {
        position: absolute;
        right: -1px;
        bottom: -1px;
        width: 10px;
        height: 10px;
        border: 2px solid var(--spice-card, #121212);
        box-shadow: none;
      }
      .fj-avatar .fj-dot.off {
        background: #888;
      }
      .fj-empty {
        padding: 10px 0;
        color: var(--spice-subtext, #b3b3b3);
        font-size: 12px;
      }
      .fj-sync-status {
        padding: 10px 12px;
        border: 1px solid var(--fj-border);
        background: rgba(0, 0, 0, 0.16);
        font-size: 12px;
      }
      .fj-jam {
        flex-wrap: wrap;
        padding: 12px;
        border: 1px solid rgba(29, 185, 84, 0.3);
        background: linear-gradient(
          135deg,
          rgba(29, 185, 84, 0.18),
          rgba(29, 185, 84, 0.05)
        );
      }
    `;
    document.head.appendChild(style);
  }

  function buildStartForm() {
    const wrap = el("div", "fj-card");
    wrap.append(el("div", "fj-card-title", "Start a FreeJam session"));

    const nameRow = el("div", "fj-row");
    const nameInput = document.createElement("input");
    nameInput.className = "fj-input";
    nameInput.placeholder = "Session name";
    nameInput.value = defaultSessionName();
    nameInput.dataset.fj = "name";
    const startButton = el("button", "fj-btn", "Start session");
    startButton.dataset.action = "start";
    nameRow.append(nameInput, startButton);
    wrap.append(nameRow);

    const adoptRow = el("div", "fj-row");
    const adoptInput = document.createElement("input");
    adoptInput.className = "fj-input";
    adoptInput.placeholder = "…or paste an existing playlist link";
    adoptInput.dataset.fj = "adopt";
    const adoptButton = el("button", "fj-btn secondary", "Use playlist");
    adoptButton.dataset.action = "adopt";
    adoptRow.append(adoptInput, adoptButton);
    wrap.append(adoptRow);

    wrap.append(
      el(
        "div",
        "fj-hint",
        "Request sessions use a collaborative playlist as a shared inbox. Starting one creates it for you; guests add songs there and this device queues new additions. Use an existing playlist if you already have one. Playback sync is separate and does not need a playlist."
      )
    );

    return wrap;
  }

  function actionButton(action, label, variant) {
    const button = el("button", `fj-btn ${variant || ""}`.trim(), label);
    button.dataset.action = action;
    return button;
  }

  function buildSessionCard() {
    const wrap = el("div", "fj-card");

    const head = el("div", "fj-card-head");
    head.append(el("div", "fj-card-title", state.name || "FreeJam session"));
    const badge = el("span", "fj-badge", state.paused ? "Paused" : "Live");
    if (state.paused) badge.classList.add("off");
    head.append(badge);
    wrap.append(head);

    if (state.inviteUrl) {
      const row = el("div", "fj-row");
      const input = document.createElement("input");
      input.className = "fj-input fj-mono";
      input.readOnly = true;
      input.value = state.inviteUrl;
      input.dataset.fj = "invite";
      input.addEventListener("focus", () => input.select());
      const copyButton = el("button", "fj-btn", "Copy invite");
      copyButton.dataset.action = "copy";
      row.append(input, copyButton);
      wrap.append(row);

      const expiry = inviteExpiryText();
      if (expiry) {
        wrap.append(el("div", expiry.warn ? "fj-warn" : "fj-hint", expiry.text));
      }
    } else {
      wrap.append(
        el(
          "div",
          "fj-warn",
          "Couldn't create an invite link automatically. Open the playlist, use “Invite collaborators”, then paste the link below."
        )
      );
    }

    const pasteRow = el("div", "fj-row");
    const pasteInput = document.createElement("input");
    pasteInput.className = "fj-input";
    pasteInput.placeholder = "Paste an invite link (…?pt=…)";
    pasteInput.dataset.fj = "pasteInvite";
    const saveButton = el("button", "fj-btn secondary", "Save link");
    saveButton.dataset.action = "saveInvite";
    pasteRow.append(pasteInput, saveButton);
    wrap.append(pasteRow);

    const actions = el("div", "fj-actions");
    actions.append(
      actionButton("open", "Open playlist", "secondary"),
      actionButton("regenerate", "New invite link", "secondary"),
      actionButton("announceJam", "Invite all friends", "secondary"),
      actionButton("retry", "Check now", "secondary"),
      actionButton(
        state.paused ? "resume" : "pause",
        state.paused ? "Resume queue" : "Pause queue",
        "secondary"
      ),
      actionButton("end", "End session", "danger")
    );
    wrap.append(actions);

    return wrap;
  }

  function buildSyncSetupCard() {
    const wrap = el("div", "fj-card");

    const head = el("div", "fj-card-head");
    head.append(el("div", "fj-card-title", "Playback sync"));
    head.append(el("span", "fj-badge", "Beta"));
    wrap.append(head);

    wrap.append(
      el(
        "div",
        "fj-hint",
        "Sync shares playback controls. Everyone needs FreeJam. FreeJam is self-hosted: you run your own relay (node freejam-relay.js), on the same Wi-Fi or through a tunnel you run yourself. There is no shared relay, and FreeJam never starts one for you."
      )
    );

    wrap.append(el("div", "fj-subtitle", "Host a sync session"));
    const hostRow = el("div", "fj-row");
    const relayInput = document.createElement("input");
    relayInput.className = "fj-input";
    relayInput.placeholder = "Your own relay: ws://YOUR_RELAY_IP:8787";
    relayInput.dataset.fj = "relayUrl";
    relayInput.value = sync.relayUrl || state.lastRelayUrl || "";
    const hostNameInput = document.createElement("input");
    hostNameInput.className = "fj-input fj-name";
    hostNameInput.placeholder = "Your name";
    hostNameInput.dataset.fj = "syncHostName";
    const hostButton = el("button", "fj-btn", "Start sync");
    hostButton.dataset.action = "syncHost";
    hostRow.append(relayInput, hostNameInput, hostButton);
    wrap.append(hostRow);

    wrap.append(el("div", "fj-divider"));

    wrap.append(el("div", "fj-subtitle", "Join a sync session"));
    const joinRow = el("div", "fj-row");
    const codeInput = document.createElement("input");
    codeInput.className = "fj-input fj-mono";
    codeInput.placeholder = "Paste the host's FJ1 join code";
    codeInput.dataset.fj = "joinCode";
    const joinNameInput = document.createElement("input");
    joinNameInput.className = "fj-input fj-name";
    joinNameInput.placeholder = "Your name";
    joinNameInput.dataset.fj = "syncJoinName";
    const joinButton = el("button", "fj-btn", "Join sync");
    joinButton.dataset.action = "syncJoin";
    joinRow.append(codeInput, joinNameInput, joinButton);
    wrap.append(joinRow);

    wrap.append(
      el(
        "div",
        "fj-hint",
        "Same Wi-Fi: use the host's LAN address printed by the relay. Remote: put the relay behind TLS and use a wss:// URL."
      )
    );

    return wrap;
  }

  function buildActiveSyncCard() {
    const wrap = el("div", "fj-card");

    const head = el("div", "fj-card-head");
    head.append(el("div", "fj-card-title", "Playback sync"));
    head.append(
      el("span", "fj-badge", sync.role === "host" ? "Host" : "Guest")
    );
    wrap.append(head);

    const status = el("div", "fj-status fj-sync-status");
    status.dataset.fj = "syncStatus";
    wrap.append(status);

    if (sync.role === "host") {
      const row = el("div", "fj-row");
      const codeInput = document.createElement("input");
      codeInput.className = "fj-input fj-mono";
      codeInput.readOnly = true;
      codeInput.value = encodeJoinCode({
        relayUrl: sync.relayUrl,
        sessionId: sync.sessionId,
        key: sync.key,
      });
      codeInput.dataset.fj = "syncCode";
      codeInput.addEventListener("focus", () => codeInput.select());
      const copyButton = el("button", "fj-btn", "Copy join code");
      copyButton.dataset.action = "syncCopyCode";
      row.append(codeInput, copyButton);
      wrap.append(row);
      wrap.append(
        el(
          "div",
          "fj-hint",
          "Send this code to the people you want in the session. It contains the relay address and the session key."
        )
      );
    }


    const actions = el("div", "fj-actions");
    if (sync.role === "host") {
      actions.append(actionButton("announceJam", "Invite all friends", "secondary"));
    }
    if (sync.role === "guest") {
      actions.append(actionButton("syncResync", "Resync", "secondary"));
    }
    actions.append(actionButton("syncLeave", "Leave sync", "danger"));
    wrap.append(actions);

    return wrap;
  }

  function buildFriendsSetupCard() {
    const wrap = el("div", "fj-card");

    const head = el("div", "fj-card-head");
    head.append(el("div", "fj-card-title", "Friends"));
    head.append(el("span", "fj-badge off", "Setup"));
    wrap.append(head);

    wrap.append(
      el(
        "div",
        "fj-hint",
        "Add friends to get an alert when they start a jam. Only people you add can send you an invite — FreeJam never broadcasts to everyone."
      )
    );

    const nameRow = el("div", "fj-row");
    const nameInput = document.createElement("input");
    nameInput.className = "fj-input fj-name";
    nameInput.placeholder = "Your name";
    nameInput.value = sync.name || "";
    nameInput.dataset.fj = "friendName";
    nameRow.append(nameInput);
    wrap.append(nameRow);

    const relayRow = el("div", "fj-row");
    const relayInput = document.createElement("input");
    relayInput.className = "fj-input";
    relayInput.placeholder = "Your own relay: wss://your-relay.example.com";
    relayInput.value = state.lastRelayUrl || sync.relayUrl || "";
    relayInput.dataset.fj = "friendRelay";
    const createButton = el("button", "fj-btn", "Create my friend code");
    createButton.dataset.action = "friendsCreate";
    relayRow.append(relayInput, createButton);
    wrap.append(relayRow);

    wrap.append(
      el(
        "div",
        "fj-hint",
        "Use the relay you host yourself (the same one as your sync sessions). Friends outside your network need a wss:// address."
      )
    );

    return wrap;
  }

  function friendInitials(name) {
    const parts = String(name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }

  function syncMemberForFriend(friend) {
    if (!friend || sync.role !== "host") return null;
    return (
      sync.members.find(
        (member) =>
          member &&
          member.role !== "host" &&
          member.uid &&
          member.uid === friend.userId
      ) || null
    );
  }

  function buildFriendRow(friend) {
    const row = el("div", "fj-item");
    const online = friends.online.has(friend.userId);
    const member = syncMemberForFriend(friend);

    const avatar = el(
      "span",
      `fj-avatar${online ? "" : " off"}`,
      friendInitials(friend.name)
    );
    const dot = el("span", "fj-dot");
    if (!online) dot.classList.add("off");
    avatar.append(dot);
    row.append(avatar);

    const info = el("div", "fj-item-info");
    info.append(el("div", "fj-item-name", friend.name));
    info.append(
      el(
        "div",
        "fj-item-meta",
        member ? "in this sync" : online ? "online" : "offline"
      )
    );
    row.append(info);

    if (member) {
      const kick = el("button", "fj-btn secondary", "Kick");
      kick.dataset.action = "friendsKick";
      kick.dataset.friendId = friend.userId;
      kick.dataset.memberId = member.id;
      row.append(kick);
    } else if (buildLocalJam()) {
      const invite = el("button", "fj-btn secondary", "Invite");
      invite.dataset.action = "friendsInviteOne";
      invite.dataset.friendId = friend.userId;
      row.append(invite);
    }
    const remove = el("button", "fj-btn danger", "Remove");
    remove.dataset.action = "friendsRemove";
    remove.dataset.friendId = friend.userId;
    row.append(remove);

    return row;
  }

  function settingRow(title, description, control) {
    const row = el("div", "fj-setting");
    const text = el("div", "fj-setting-text");
    text.append(el("div", "fj-setting-title", title));
    if (description) text.append(el("div", "fj-setting-desc", description));
    row.append(text, control);
    return row;
  }

  function switchButton(action, label, on, disabled) {
    const button = el("button", "fj-switch");
    button.type = "button";
    button.dataset.action = action;
    button.setAttribute("role", "switch");
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-checked", on ? "true" : "false");
    button.disabled = Boolean(disabled);
    return button;
  }

  function buildNotificationCard() {
    const wrap = el("div", "fj-card");

    const head = el("div", "fj-card-head");
    head.append(el("div", "fj-card-title", "Notifications"));
    wrap.append(head);

    const permission = notificationPermission();
    const osOn = alerts.os && permission === "granted";

    wrap.append(
      settingRow(
        "Desktop notifications",
        "Show a Windows or macOS notification when a friend starts a jam.",
        switchButton(
          "settingsToggleOs",
          "Desktop notifications",
          osOn,
          permission === "unsupported"
        )
      )
    );

    wrap.append(
      settingRow(
        "Ding sound",
        "Play a short chime with each alert.",
        switchButton("settingsToggleSound", "Ding sound", alerts.sound)
      )
    );

    let statusText;
    let statusClass = "fj-hint";
    if (permission === "unsupported") {
      statusText =
        "This Spotify version cannot show desktop notifications. Alerts stay inside Spotify.";
    } else if (permission === "denied") {
      statusText =
        "Notifications are blocked. Allow them for Spotify in your system settings, then turn this on again.";
      statusClass = "fj-warn";
    } else if (permission === "granted") {
      statusText = osOn
        ? "On. Notifications also appear when Spotify is minimized."
        : "Desktop notifications are off. Turn them on to get alerts outside Spotify.";
    } else {
      statusText =
        "Turn on desktop notifications to allow Spotify to show them.";
    }
    wrap.append(el("div", statusClass, statusText));

    if (friends.identity) {
      wrap.append(el("div", "fj-divider"));
      wrap.append(
        el("div", "fj-subtitle", "Alerts while Spotify is closed")
      );
      wrap.append(
        el(
          "div",
          "fj-hint",
          "Spotify must be running for its own notifications. For alerts when it is fully closed, install the optional background notifier on this device. Re-copy the code after changing your friends or the ding setting."
        )
      );
      const backgroundActions = el("div", "fj-actions");
      backgroundActions.append(
        actionButton("settingsCopyNotifier", "Copy setup code", "secondary")
      );
      wrap.append(backgroundActions);
    } else {
      wrap.append(el("div", "fj-divider"));
      wrap.append(
        el(
          "div",
          "fj-hint",
          "Create your friend code in Friends to set up background alerts and the relay."
        )
      );
    }

    return wrap;
  }

  function buildLayoutCard() {
    const wrap = el("div", "fj-card");

    const head = el("div", "fj-card-head");
    head.append(el("div", "fj-card-title", "Panel sections"));
    const headActions = el("div", "fj-actions");
    const compact = el("button", "fj-btn ghost small", "Compact");
    compact.dataset.action = "settingsCompactSections";
    const showAll = el("button", "fj-btn ghost small", "Show all");
    showAll.dataset.action = "settingsResetSections";
    headActions.append(compact, showAll);
    head.append(headActions);
    wrap.append(head);

    wrap.append(
      el(
        "div",
        "fj-hint",
        "Hide the parts of the panel you do not use. Compact keeps the session and friends cards and hides the rest. Settings always stays visible."
      )
    );

    const sections = [
      ["session", "Session card", "Start a session or manage the active one."],
      ["sync", "Playback sync", "Relay setup for synced playback."],
      ["friends", "Friends", "Friend codes and your friend list."],
      ["requests", "Recent requests", "The request inbox summary."],
      ["hint", "Help text", "The explanation at the bottom of the panel."],
    ];

    for (const [key, title, description] of sections) {
      const control = switchButton("settingsToggleSection", title, layout[key]);
      control.dataset.section = key;
      wrap.append(settingRow(title, description, control));
    }

    return wrap;
  }

  function buildRelayCard() {
    if (!friends.identity) return null;

    const wrap = el("div", "fj-card");

    const head = el("div", "fj-card-head");
    head.append(el("div", "fj-card-title", "Friend relay"));
    wrap.append(head);

    wrap.append(
      el(
        "div",
        "fj-hint",
        "The relay you host yourself for jam alerts. Everyone in the group connects to the same one."
      )
    );

    const relayRow = el("div", "fj-row");
    const relayInput = document.createElement("input");
    relayInput.className = "fj-input";
    relayInput.placeholder = "Your own relay: wss://your-relay.example.com";
    relayInput.value = friends.identity.relayUrl || "";
    relayInput.dataset.fj = "settingsRelayEdit";
    const saveRelay = el("button", "fj-btn secondary", "Save");
    saveRelay.dataset.action = "settingsSaveRelay";
    relayRow.append(relayInput, saveRelay);
    wrap.append(relayRow);

    return wrap;
  }

  function buildSettingsCards() {
    const cards = [buildLayoutCard(), buildNotificationCard()];
    const relay = buildRelayCard();
    if (relay) cards.push(relay);
    return cards;
  }

  function settingsRenderKey() {
    return [
      alerts.os ? "os" : "off",
      alerts.sound ? "sound" : "mute",
      notificationPermission(),
      friends.identity ? friends.identity.relayUrl : "none",
      friends.list.map((friend) => friend.userId).join(","),
      Object.keys(DEFAULT_LAYOUT)
        .map((key) => (layout[key] ? "1" : "0"))
        .join(""),
    ].join("|");
  }

  function renderSettingsSection(container) {
    if (!container) return;
    const key = settingsRenderKey();
    if (container.dataset.renderKey === key) return;
    container.dataset.renderKey = key;
    container.replaceChildren(...buildSettingsCards());
  }

  function refreshSettingsPanel() {
    if (!ui.root) return;
    const container = $('[data-fj="settings"]', ui.root);
    if (!container) return;
    container.dataset.renderKey = "";
    renderSettingsSection(container);
  }

  function buildFriendsCard() {
    const wrap = el("div", "fj-card");

    const head = el("div", "fj-card-head");
    head.append(el("div", "fj-card-title", "Friends"));

    const onlineCount = friends.list.filter((friend) =>
      friends.online.has(friend.userId)
    ).length;
    const badge = el(
      "span",
      "fj-badge",
      friends.connected
        ? `${onlineCount}/${friends.list.length} online`
        : "Offline"
    );
    if (!friends.connected) badge.classList.add("off");
    head.append(badge);
    wrap.append(head);

    const status = el("div", "fj-status fj-sync-status");
    const statusDot = el("span", "fj-dot");
    let statusText;
    if (!friends.identity.relayUrl) {
      statusDot.classList.add("off");
      statusText = "Set a relay in Settings so friends can reach you.";
    } else if (!friends.connected) {
      statusDot.classList.add("off");
      statusText = friends.error || "Connecting to the friend relay…";
    } else {
      const latency = friends.latencyMs ? `${friends.latencyMs}ms` : "measuring";
      statusText = `Connected · ${onlineCount} of ${friends.list.length} friends online · ${latency}`;
    }
    status.append(statusDot, el("span", null, statusText));
    wrap.append(status);

    const jam = friends.incomingJam;
    if (jam) {
      const box = el("div", "fj-status fj-jam");
      box.append(el("span", "fj-dot"));
      const info = el("div", "fj-item-info");
      info.append(
        el(
          "div",
          "fj-item-name",
          `${jam.fromName || "A friend"} · ${
            jam.mode === "sync" ? "playback sync" : "listening session"
          }`
        )
      );
      info.append(el("div", "fj-item-meta", timeAgo(jam.at || Date.now())));
      box.append(info);

      const join = el("button", "fj-btn", "Join jam");
      join.dataset.action = "friendsJoin";
      const dismiss = el("button", "fj-btn secondary", "Dismiss");
      dismiss.dataset.action = "friendsDismiss";
      box.append(join, dismiss);
      wrap.append(box);
    }

    const codeRow = el("div", "fj-row");
    const codeInput = document.createElement("input");
    codeInput.className = "fj-input fj-mono";
    codeInput.readOnly = true;
    codeInput.value = encodeFriendCode(friends.identity);
    codeInput.dataset.fj = "friendCode";
    codeInput.addEventListener("focus", () => codeInput.select());
    const copyCode = el("button", "fj-btn", "Copy my code");
    copyCode.dataset.action = "friendsCopyCode";
    codeRow.append(codeInput, copyCode);
    wrap.append(codeRow);

    const actions = el("div", "fj-actions");
    actions.append(
      actionButton("friendsCopyMessage", "Copy invite message", "secondary")
    );
    if (!friends.connected && friends.identity.relayUrl) {
      actions.append(
        actionButton("friendsReconnect", "Reconnect", "secondary")
      );
    }
    wrap.append(actions);

    wrap.append(el("div", "fj-divider"));
    wrap.append(el("div", "fj-subtitle", "Add a friend"));

    const addRow = el("div", "fj-row");
    const addInput = document.createElement("input");
    addInput.className = "fj-input fj-mono";
    addInput.placeholder = "Paste their FJF1 friend code";
    addInput.dataset.fj = "friendCodeInput";
    const addButton = el("button", "fj-btn", "Add friend");
    addButton.dataset.action = "friendsAdd";
    addRow.append(addInput, addButton);
    wrap.append(addRow);

    const list = el("div", "fj-list");
    if (friends.list.length === 0) {
      list.append(
        el(
          "div",
          "fj-empty",
          "No friends yet. Send them your code, then paste theirs here."
        )
      );
    } else {
      for (const friend of friends.list) {
        list.append(buildFriendRow(friend));
      }
    }
    wrap.append(list);

    wrap.append(
      el(
        "div",
        "fj-hint",
        "Your code contains a send key, not your private receive key. Friends can send you jams, but cannot read your mailbox or impersonate you."
      )
    );

    return wrap;
  }

  function renderFriendsSection(container) {
    if (!container) return;

    const key = [
      friends.identity ? "id" : "none",
      friends.identity ? friends.identity.relayUrl : "",
      friends.connected ? "on" : "off",
      friends.error || "",
      friends.list.map((friend) => `${friend.userId}:${friend.name}`).join(","),
      Array.from(friends.online).sort().join(","),
      friends.incomingJam
        ? `${friends.incomingJam.from}|${friends.incomingJam.at}|${friends.incomingJam.mode}`
        : "",
      state.playlistUri && state.inviteUrl ? "request-jam" : "",
      sync.role === "host" && sync.sessionId
        ? `host:${sync.sessionId}:${sync.members
            .map((member) => `${member.id}:${member.uid || ""}`)
            .join(",")}`
        : "",
    ].join("|");

    if (container.dataset.renderKey === key) return;
    container.dataset.renderKey = key;
    container.replaceChildren(
      friends.identity ? buildFriendsCard() : buildFriendsSetupCard()
    );
  }

  function refreshFriendsPanel() {
    updateButton();

    const root = ui.root;
    if (!root || !root.isConnected) return;

    const container = $('[data-fj="friends"]', root);
    if (!container) return;

    container.dataset.renderKey = "";
    renderFriendsSection(container);
  }

  function renderSyncSection(container) {
    if (!container) return;

    const key = sync.role ? `active|${sync.role}|${sync.sessionId}` : "setup";
    if (container.dataset.renderKey !== key) {
      container.dataset.renderKey = key;
      container.replaceChildren(
        sync.role ? buildActiveSyncCard() : buildSyncSetupCard()
      );
    }

    updateSyncControls();
  }

  function updateSyncControls() {
    const root = ui.root;
    if (!root || !root.isConnected || !sync.role) return;

    const status = $('[data-fj="syncStatus"]', root);

    if (status) {
      status.replaceChildren();
      const dot = el("span", "fj-dot");
      let text;

      if (!sync.connected) {
        dot.classList.add("off");
        text =
          sync.error ||
          (sync.role ? "Connecting to the relay…" : "Not connected.");
      } else {
        const count = sync.members.length || 1;
        const latency = sync.latencyMs ? `${sync.latencyMs}ms` : "measuring";
        if (sync.role === "host") {
          text = `Hosting · ${count} connected · ${latency}`;
        } else if (!sync.hostId) {
          text = `Waiting for the host · ${count} connected · ${latency}`;
        } else {
          text = `Following ${
            sync.hostName || "the host"
          } · ${count} connected · ${latency}`;
        }
      }

      status.append(dot, el("span", null, text));
    }

  }

  function refreshSyncPanel() {
    updateButton();

    const root = ui.root;
    if (!root || !root.isConnected) return;

    const container = $('[data-fj="sync"]', root);
    if (!container) return;

    container.dataset.renderKey = "";
    renderSyncSection(container);
  }

  // Re-render every part of the open modal that can change when sync or friend
  // state changes. Render keys keep this cheap: only sections whose content
  // actually changed are rebuilt.
  function refreshPanelSections() {
    updateButton();
    updatePanel();
  }

  function buildRequestRow(item) {
    const row = el("div", "fj-item");
    const info = el("div", "fj-item-info");
    info.append(el("div", "fj-item-name", item.name));

    const meta = [];
    if (item.artists) meta.push(item.artists);
    if (item.addedBy) meta.push(`added by ${item.addedBy}`);
    if (item.queuedAt) meta.push(timeAgo(item.queuedAt));

    info.append(el("div", "fj-item-meta", meta.join(" · ")));
    row.append(info);
    return row;
  }

  function updateButton() {
    if (!ui.button) return;

    const active = Boolean(state.playlistUri || sync.role || friends.incomingJam);
    ui.button.active = active;

    if (friends.incomingJam) {
      ui.button.label = `FreeJam — join ${
        friends.incomingJam.fromName || "a friend"
      }'s jam`;
    } else if (state.playlistUri) {
      ui.button.label = `FreeJam — ${
        state.paused ? "paused" : "listening"
      }${state.requests.length ? ` (${state.requests.length})` : ""}`;
    } else if (sync.role) {
      ui.button.label = `FreeJam — ${
        sync.connected ? "synced" : "connecting"
      }`;
    } else {
      ui.button.label = "FreeJam — start a session";
    }
  }

  function applyLayout() {
    const root = ui.root;
    if (!root) return;
    for (const node of root.querySelectorAll("[data-fj-section]")) {
      const key = node.dataset.fjSection;
      node.hidden = layout[key] === false;
    }
  }

  function updatePanel(forceSessionRender = false) {
    const root = ui.root;
    if (!root || !root.isConnected) {
      if (root && !root.isConnected) ui.root = null;
      return;
    }

    const status = $('[data-fj="status"]', root);
    const session = $('[data-fj="session"]', root);
    const syncContainer = $('[data-fj="sync"]', root);
    const friendsContainer = $('[data-fj="friends"]', root);
    const settingsContainer = $('[data-fj="settings"]', root);
    const count = $('[data-fj="count"]', root);
    const now = $('[data-fj="now"]', root);
    const list = $('[data-fj="requests"]', root);
    const hint = $('[data-fj="hint"]', root);

    if (status) {
      status.replaceChildren();
      const dot = el("span", "fj-dot");
      let text;

      if (!state.playlistUri && !sync.role) {
        dot.classList.add("off");
        text = layout.session
          ? "No active session. Start one below — no Premium needed."
          : "No active session. Turn on Session card in Settings to start one.";
      } else if (state.lastError) {
        dot.classList.add("off");
        text = state.lastError;
      } else if (!state.playlistUri) {
        if (!sync.connected) dot.classList.add("off");
        text = sync.connected
          ? `Playback sync active · ${sync.members.length || 1} connected.`
          : "Playback sync is connecting…";
      } else if (state.paused) {
        dot.classList.add("off");
        text = `Queueing paused${
          state.pendingCount ? ` · ${state.pendingCount} waiting` : ""
        }.`;
      } else {
        text = `Listening for requests${
          state.pendingCount ? ` · ${state.pendingCount} waiting` : ""
        }.`;
      }

      status.append(dot, el("span", null, text));
    }

    if (session) {
      const key = state.playlistUri
        ? `session|${state.playlistUri}|${state.inviteUrl || ""}|${
            state.paused
          }|${state.name || ""}`
        : "none";

      if (forceSessionRender) session.dataset.renderKey = "";
      if (session.dataset.renderKey !== key) {
        session.dataset.renderKey = key;
        session.replaceChildren(
          state.playlistUri ? buildSessionCard() : buildStartForm()
        );
      }
    }

    if (syncContainer) renderSyncSection(syncContainer);
    if (friendsContainer) renderFriendsSection(friendsContainer);
    if (settingsContainer) renderSettingsSection(settingsContainer);

    if (now) {
      now.replaceChildren();
      const playing = getNowPlaying();
      if (playing) {
        now.append(
          el("span", "fj-muted", "Now playing: "),
          el("span", "fj-now-name", playing)
        );
      }
    }

    if (count) {
      count.textContent = state.requests.length
        ? `${state.requests.length} queued`
        : "";
    }

    if (list) {
      const requestCard = list.closest(".fj-card");
      if (requestCard) requestCard.style.display = state.requests.length ? "" : "none";
      list.replaceChildren();
      if (state.requests.length === 0) {
        list.append(
          el(
            "div",
            "fj-empty",
            state.playlistUri
              ? "Nothing yet. Share the invite link and requests will appear here."
              : "Start a request session to see requests here."
          )
        );
      } else {
        for (const item of state.requests) {
          list.append(buildRequestRow(item));
        }
      }
    }

    if (hint) {
      if (!state.playlistUri && sync.role) {
        hint.textContent =
          "Sync mode is active. Use Spotify's normal player controls to control playback. Start a request session only if you also want guests to add songs to a playlist.";
      } else if (state.playlistUri) {
        hint.textContent =
          "Guests open the invite link in the Spotify desktop or mobile app, then add songs to the request playlist. This device queues them automatically. Invite links expire after 7 days.";
      } else {
        hint.textContent =
          "Request sessions use a collaborative playlist as a shared inbox for song requests; FreeJam creates one automatically, or you can choose an existing playlist. Playback sync is a separate relay mode and does not need a playlist. Use Spotify's normal player controls.";
      }
    }

    applyLayout();
  }

  function openPanel() {
    const root = document.createElement("div");
    root.className = "fj-root";
    root.innerHTML = `
      <div class="fj-status" data-fj="status"></div>
      <section class="fj-block" data-fj-section="session">
        <div data-fj="session"></div>
      </section>
      <details class="fj-section" data-fj-section="sync">
        <summary><span class="fj-section-label">Playback sync</span><span class="fj-section-sub">Relay setup</span></summary>
        <div class="fj-section-body" data-fj="sync"></div>
      </details>
      <details class="fj-section" data-fj-section="friends">
        <summary><span class="fj-section-label">Friends</span><span class="fj-section-sub">Codes and invites</span></summary>
        <div class="fj-section-body" data-fj="friends"></div>
      </details>
      <section class="fj-block" data-fj-section="requests">
        <div class="fj-card">
          <div class="fj-card-head">
            <span class="fj-card-title">Recent requests</span>
            <span class="fj-muted" data-fj="count"></span>
          </div>
          <div class="fj-now" data-fj="now"></div>
          <div class="fj-list" data-fj="requests"></div>
        </div>
      </section>
      <details class="fj-section">
        <summary><span class="fj-section-label">Settings</span><span class="fj-section-sub">Alerts and panel</span></summary>
        <div class="fj-section-body" data-fj="settings"></div>
      </details>
      <div class="fj-hint" data-fj="hint" data-fj-section="hint"></div>
    `;
    root.addEventListener("click", onPanelClick);
    // Accordion: opening one section closes the others, so the panel stays small.
    root.addEventListener(
      "toggle",
      (event) => {
        const opened = event.target;
        if (!(opened instanceof HTMLDetailsElement) || !opened.open) return;
        for (const other of root.querySelectorAll("details.fj-section[open]")) {
          if (other !== opened) other.open = false;
        }
      },
      true
    );

    ui.root = root;
    Spicetify.PopupModal.display({
      title: "FreeJam",
      content: root,
      isLarge: false,
    });
    // The popup must be attached before updatePanel() runs: it deliberately
    // skips work for detached roots so a closed modal does not keep rendering.
    updatePanel();
  }

  async function onPanelClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const button = target.closest("[data-action]");
    if (!button || !ui.root || !ui.root.contains(button)) return;
    if (busy) return;

    const action = button.dataset.action;

    try {
      switch (action) {
        case "start": {
          const input = $('[data-fj="name"]', ui.root);
          const name =
            (input && input.value.trim()) || defaultSessionName();
          await createSession(name, null, false);
          break;
        }
        case "adopt": {
          const input = $('[data-fj="adopt"]', ui.root);
          const uri = parsePlaylistInput(input ? input.value : "");
          if (!uri) {
            Spicetify.showNotification(
              "Paste a valid Spotify playlist link or URI.",
              true
            );
            return;
          }
          await createSession("FreeJam session", uri, true);
          break;
        }
        case "copy": {
          if (!state.inviteUrl) {
            Spicetify.showNotification(
              "No invite link yet. Create a new one or paste one.",
              true
            );
            return;
          }
          const ok = await copyText(state.inviteUrl);
          Spicetify.showNotification(
            ok
              ? "Invite link copied. Guests open it in the Spotify app."
              : "Could not copy the invite link.",
            !ok
          );
          break;
        }
        case "open":
          openPlaylist();
          break;
        case "regenerate":
          await regenerateInvite();
          break;
        case "retry":
          if (state.playlistUri) await runPoll();
          break;
        case "pause":
          state.paused = true;
          saveState();
          updateButton();
          updatePanel(true);
          break;
        case "resume":
          state.paused = false;
          saveState();
          updateButton();
          updatePanel(true);
          schedulePoll(200);
          break;
        case "saveInvite":
          savePastedInvite();
          break;
        case "announceJam": {
          if (!friends.identity) {
            Spicetify.showNotification(
              "Create your friend code first, then add a friend.",
              true
            );
            return;
          }
          if (!friends.list.length) {
            Spicetify.showNotification(
              "Add at least one friend before sending a jam invite.",
              true
            );
            return;
          }
          const jam = buildLocalJam();
          if (!jam) {
            Spicetify.showNotification(
              "Start a sync session or a request session first.",
              true
            );
            return;
          }
          announceJam();
          Spicetify.showNotification(
            friends.connected
              ? "Jam invite sent to your friends."
              : "Jam invite queued. It will send when the friend relay reconnects."
          );
          break;
        }
        case "settingsToggleOs": {
          const on = button.getAttribute("aria-checked") !== "true";
          if (on) {
            const granted = await ensureNotificationPermission(true);
            if (!granted) {
              alerts.os = false;
              saveAlerts();
              refreshSettingsPanel();
              Spicetify.showNotification(
                notificationPermission() === "denied"
                  ? "Allow notifications for Spotify in your system settings, then turn this on again."
                  : "Spotify did not allow desktop notifications. Alerts will stay inside Spotify.",
                true,
                9000
              );
              return;
            }
            alerts.os = true;
          } else {
            alerts.os = false;
          }
          saveAlerts();
          refreshSettingsPanel();
          break;
        }
        case "settingsToggleSound": {
          const on = button.getAttribute("aria-checked") !== "true";
          alerts.sound = on;
          saveAlerts();
          if (on) playDing();
          refreshSettingsPanel();
          break;
        }
        case "settingsToggleSection": {
          const key = button.dataset.section;
          if (!key || !(key in DEFAULT_LAYOUT)) return;
          layout[key] = button.getAttribute("aria-checked") !== "true";
          saveLayout();
          applyLayout();
          refreshSettingsPanel();
          break;
        }
        case "settingsResetSections": {
          Object.assign(layout, DEFAULT_LAYOUT);
          saveLayout();
          applyLayout();
          refreshSettingsPanel();
          break;
        }
        case "settingsCompactSections": {
          Object.assign(layout, {
            session: true,
            sync: false,
            friends: true,
            requests: false,
            hint: false,
          });
          saveLayout();
          applyLayout();
          refreshSettingsPanel();
          break;
        }
        case "settingsCopyNotifier": {
          if (!friends.identity) return;
          const code = encodeNotifierCode(friends.identity);
          const ok = await copyText(code);
          Spicetify.showNotification(
            ok
              ? "Setup code copied. Paste it into the background notifier installer. Re-copy it after changing your friends or the ding setting."
              : "Could not copy the setup code.",
            !ok,
            8000
          );
          break;
        }
        case "friendsInviteOne": {
          const friend = friends.list.find(
            (item) => item.userId === button.dataset.friendId
          );
          const jam = buildLocalJam();
          if (!friend || !jam) return;
          if (!friends.connected) {
            Spicetify.showNotification("Connect to your friend relay before sending an individual invite.", true);
            return;
          }
          sendFriends({ t: "dm", to: friend.userId, sendKey: friend.sendKey, jam });
          Spicetify.showNotification(`Jam invite sent to ${friend.name}.`);
          break;
        }
        case "friendsKick": {
          const friend = friends.list.find(
            (item) => item.userId === button.dataset.friendId
          );
          if (!friend) return;
          if (sync.role !== "host" || !sync.connected) {
            Spicetify.showNotification(
              "Start hosting a sync session before removing a friend from it.",
              true
            );
            refreshPanelSections();
            return;
          }

          const member = syncMemberForFriend(friend);
          if (!member) {
            Spicetify.showNotification(
              `${friend.name} is no longer in this sync session.`,
              true
            );
            refreshPanelSections();
            return;
          }

          if (!sendSync({ t: "kick", target: member.id })) {
            Spicetify.showNotification(
              "Could not reach the relay to remove that friend.",
              true
            );
            return;
          }

          // Update the open modal immediately; the relay also broadcasts fresh
          // presence once the guest socket closes.
          sync.members = sync.members.filter(
            (item) => item && item.id !== member.id
          );
          refreshPanelSections();
          Spicetify.showNotification(
            `${friend.name} was removed from the sync session.`
          );
          break;
        }
        case "friendsCreate": {
          const nameInput = $('[data-fj="friendName"]', ui.root);
          const relayInput = $('[data-fj="friendRelay"]', ui.root);
          const relayUrl = normalizeRelayUrl(relayInput ? relayInput.value : "");
          if (!relayUrl) {
            Spicetify.showNotification(
              "Enter the relay URL friends can reach, for example wss://your-relay.example.com.",
              true
            );
            return;
          }

          const name =
            (nameInput && nameInput.value.trim()) ||
            sync.name ||
            "Me";

          if (friends.identity) {
            friends.identity.name = name;
            friends.identity.relayUrl = relayUrl;
          } else {
            friends.identity = {
              userId: randomId(12),
              recvKey: randomId(24),
              sendKey: randomId(24),
              name,
              relayUrl,
              createdAt: Date.now(),
            };
          }

          state.lastRelayUrl = relayUrl;
          saveFriends();
          saveState();
          friends.reconnectDelay = 1000;
          connectFriends();
          refreshFriendsPanel();
          refreshSettingsPanel();
          Spicetify.showNotification(
            "Friend code ready. Copy it and send it to the people you trust."
          );
          break;
        }
        case "friendsCopyCode": {
          if (!friends.identity) return;
          const code = encodeFriendCode(friends.identity);
          const ok = await copyText(code);
          Spicetify.showNotification(
            ok ? "Friend code copied." : "Could not copy the friend code.",
            !ok
          );
          break;
        }
        case "friendsCopyMessage": {
          if (!friends.identity) return;
          const message = friendInviteMessage();
          const ok = await copyText(message);
          Spicetify.showNotification(
            ok
              ? "Invite message copied. Paste it in Spotify, Discord, or anywhere else."
              : "Could not copy the invite message.",
            !ok
          );
          break;
        }
        case "friendsAdd": {
          const input = $('[data-fj="friendCodeInput"]', ui.root);
          const code = decodeFriendCode(input ? input.value : "");
          if (!code) {
            Spicetify.showNotification(
              "Paste a valid FJF1 friend code.",
              true
            );
            return;
          }
          if (friends.identity && code.userId === friends.identity.userId) {
            Spicetify.showNotification("That is your own friend code.", true);
            return;
          }

          const existing = friends.list.find(
            (friend) => friend.userId === code.userId
          );
          if (existing) {
            existing.sendKey = code.sendKey;
            existing.name = code.name;
          } else {
            if (friends.list.length >= MAX_FRIENDS) {
              Spicetify.showNotification("The friend list is full.", true);
              return;
            }
            friends.list.push({
              userId: code.userId,
              sendKey: code.sendKey,
              name: code.name,
              relayUrl: code.relayUrl,
              addedAt: Date.now(),
            });
          }

          saveFriends();
          watchFriends();
          refreshFriendsPanel();
          refreshSettingsPanel();

          if (
            friends.identity &&
            friends.identity.relayUrl &&
            code.relayUrl &&
            code.relayUrl !== friends.identity.relayUrl
          ) {
            Spicetify.showNotification(
              `${code.name} added. Note: they use a different relay, so invites may not deliver until you both use the same relay.`,
              true,
              9000
            );
          } else {
            Spicetify.showNotification(`${code.name} added.`);
          }
          break;
        }
        case "friendsRemove": {
          const id = button.dataset.friendId;
          if (!id) return;
          friends.list = friends.list.filter(
            (friend) => friend.userId !== id
          );
          saveFriends();
          watchFriends();
          refreshFriendsPanel();
          refreshSettingsPanel();
          break;
        }
        case "friendsJoin":
          joinIncomingJam();
          break;
        case "friendsDismiss":
          clearIncomingJam();
          break;
        case "friendsReconnect":
          friends.error = null;
          friends.reconnectDelay = 1000;
          connectFriends();
          refreshFriendsPanel();
          break;
        case "settingsSaveRelay": {
          const input = $('[data-fj="settingsRelayEdit"]', ui.root);
          const relayUrl = normalizeRelayUrl(input ? input.value : "");
          if (!relayUrl) {
            Spicetify.showNotification("Enter a valid relay URL.", true);
            return;
          }
          if (!friends.identity) return;

          friends.identity.relayUrl = relayUrl;
          state.lastRelayUrl = relayUrl;
          saveFriends();
          saveState();
          friends.error = null;
          friends.reconnectDelay = 1000;
          connectFriends();
          refreshSettingsPanel();
          refreshFriendsPanel();
          Spicetify.showNotification(
            "Friend relay updated. Copy your friend code again so friends can update it."
          );
          break;
        }
        case "end": {
          if (Date.now() > endArmedUntil) {
            endArmedUntil = Date.now() + 4000;
            button.textContent = "Click again to end";
            setTimeout(() => updatePanel(true), 4100);
            return;
          }
          endArmedUntil = 0;
          endSession();
          break;
        }
        case "syncHost": {
          const relayInput = $('[data-fj="relayUrl"]', ui.root);
          const nameInput = $('[data-fj="syncHostName"]', ui.root);
          const relayUrl = normalizeRelayUrl(
            relayInput ? relayInput.value : ""
          );
          if (!relayUrl) {
            Spicetify.showNotification(
              "Enter the relay WebSocket URL, for example ws://192.168.x.x:8787 on the same Wi-Fi, or the wss:// address of a tunnel you run yourself.",
              true
            );
            return;
          }

          sync.role = "host";
          sync.relayUrl = relayUrl;
          sync.sessionId = randomId(16);
          sync.key = randomId(16);
          sync.name = (nameInput && nameInput.value.trim()) || "Host";
          sync.error = null;
          sync.reconnectDelay = 1000;
          state.lastRelayUrl = relayUrl;
          saveState();
          connectSync();
          announceJam();
          refreshPanelSections();
          break;
        }
        case "syncJoin": {
          const codeInput = $('[data-fj="joinCode"]', ui.root);
          const nameInput = $('[data-fj="syncJoinName"]', ui.root);
          const config = decodeJoinCode(codeInput ? codeInput.value : "");
          if (!config) {
            Spicetify.showNotification(
              "Paste a valid FJ1 join code from the host.",
              true
            );
            return;
          }

          sync.role = "guest";
          sync.relayUrl = normalizeRelayUrl(config.relayUrl);
          sync.sessionId = config.sessionId;
          sync.key = config.key;
          sync.name = (nameInput && nameInput.value.trim()) || "Guest";
          sync.error = null;
          sync.reconnectDelay = 1000;
          state.lastRelayUrl = normalizeRelayUrl(config.relayUrl);
          saveState();
          connectSync();
          refreshPanelSections();
          break;
        }
        case "syncCopyCode": {
          const code = encodeJoinCode({
            relayUrl: sync.relayUrl,
            sessionId: sync.sessionId,
            key: sync.key,
          });
          const ok = await copyText(code);
          Spicetify.showNotification(
            ok ? "Join code copied." : "Could not copy the join code.",
            !ok
          );
          break;
        }
        case "syncResync": {
          if (sync.role !== "guest" || !sync.connected) {
            Spicetify.showNotification("Not connected to a sync session.", true);
            return;
          }
          sendSync({ t: "cmd", action: "sync" });
          Spicetify.showNotification("Requested a fresh sync state.");
          break;
        }
        case "syncLeave": {
          if (Date.now() > syncLeaveArmedUntil) {
            syncLeaveArmedUntil = Date.now() + 4000;
            button.textContent = "Click again to leave";
            setTimeout(() => {
              syncLeaveArmedUntil = 0;
              refreshPanelSections();
            }, 4100);
            return;
          }
          syncLeaveArmedUntil = 0;
          leaveSync();
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.error("[FreeJam]", err);
      Spicetify.showNotification(
        `FreeJam: ${(err && err.message) || "Something went wrong."}`,
        true,
        6000
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Entry points
  // ---------------------------------------------------------------------------

  function createPlaybarButton() {
    try {
      ui.button = new Spicetify.Playbar.Button(
        "FreeJam",
        "collaborative",
        () => openPanel(),
        false,
        false
      );
    } catch (err) {
      console.error("[FreeJam] Could not create the playbar button", err);
    }
  }

  function registerContextMenu() {
    if (!Spicetify.ContextMenu || !Spicetify.ContextMenu.Item) return;

    try {
      new Spicetify.ContextMenu.Item(
        "Start FreeJam session with this playlist",
        (uris) => {
          const uri = uris && uris[0];
          if (!uri) return;

          if (state.playlistUri) {
            Spicetify.showNotification(
              "FreeJam already has an active request session. End it first.",
              true
            );
            return;
          }

          createSession("FreeJam session", uri, true)
            .then(() => openPanel())
            .catch((err) => {
              console.error("[FreeJam]", err);
              Spicetify.showNotification(
                `FreeJam: ${
                  (err && err.message) || "Could not start the session."
                }`,
                true,
                6000
              );
            });
        },
        (uris) =>
          Boolean(
            uris &&
              uris.length === 1 &&
              /^spotify:playlist:[A-Za-z0-9]+$/.test(uris[0])
          ),
        "collaborative"
      ).register();
    } catch (err) {
      console.warn("[FreeJam] Could not register the context menu item", err);
    }
  }

  (async function init() {
    const ready = await waitFor(
      () =>
        window.Spicetify &&
        Spicetify.Platform &&
        Spicetify.Platform.PlaylistAPI &&
        Spicetify.Platform.RootlistAPI &&
        Spicetify.Player &&
        Spicetify.LocalStorage &&
        Spicetify.Playbar &&
        Spicetify.PopupModal &&
        typeof Spicetify.addToQueue === "function"
    );

    if (!ready) {
      console.error(
        "[FreeJam] Spotify APIs were not available; the extension did not start."
      );
      return;
    }

    loadState();
    loadFriends();
    loadAlerts();
    loadLayout();
    injectStyles();
    createPlaybarButton();
    registerContextMenu();

    // Browsers only allow audio after a user gesture. Prime the audio context
    // on the first click so the friend-alert ding can play later.
    document.addEventListener("pointerdown", primeAudio, {
      once: true,
      capture: true,
    });

    try {
      Spicetify.Player.addEventListener("songchange", () => {
        onLocalSongChange();
        updatePanel();
      });
      Spicetify.Player.addEventListener("onplaypause", () => {
        onLocalPlayPause();
        updatePanel();
      });
    } catch (err) {
      console.warn("[FreeJam] Could not listen for player changes", err);
    }

    updateButton();

    if (state.playlistUri) {
      schedulePoll(1500);
    }

    if (sync.role) {
      setTimeout(() => {
        if (sync.role && !sync.connected) connectSync();
      }, 1200);
    }

    if (friends.identity && friends.identity.relayUrl) {
      setTimeout(() => {
        if (friends.identity && !friends.connected) connectFriends();
      }, 1800);
    }
  })();
})();
