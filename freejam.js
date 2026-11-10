/*
 * FreeJam — collaborative listening for free Spotify accounts.
 *
 * One mode: playback sync (FreeJam on every device).
 *
 * A tiny relay (freejam-relay.js) connects the participants. The host is
 * authoritative: their track, playhead, pause state and queue are broadcast
 * to everyone. Skips, seeks, play/pause from any participant are forwarded
 * to the host and then re-broadcast, so everyone stays together.
 *
 * Friends use Spotify's own social graph: Listening Activity, following and
 * followers, follow/unfollow, and profile links. Jam invites are shared as
 * join codes. An optional self-hosted relay mailbox can deliver an invite
 * automatically to people who already added you there.
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
  // Public documentation. The panel only ever opens this one URL.
  const README_URL =
    "https://github.com/Vineeth-0/freejam/blob/HEAD/README.md";
  const FRIEND_PING_INTERVAL_MS = 15000;
  const FRIEND_RECONNECT_MAX_MS = 15000;
  const FRIEND_JAM_NOTIFY_COOLDOWN_MS = 45 * 1000;
  const MAX_FRIENDS = 200;
  const SOCIAL_REFRESH_MS = 60 * 1000;
  const SOCIAL_MAX_LIST = 200;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  function defaultState() {
    return {
      version: 2,
      lastRelayUrl: "",
      syncConfig: null,
    };
  }

  let state = defaultState();
  let busy = false;
  let syncLeaveArmedUntil = 0;
  let audioContext = null;

  const alerts = {
    os: true,
    sound: true,
  };

  // Which parts of the panel are visible. Settings always stays visible so
  // people can bring back anything they hid.
  const DEFAULT_LAYOUT = {
    sync: true,
    friends: true,
    hint: true,
  };

  const layout = { ...DEFAULT_LAYOUT };

  const activeNotifications = new Set();

  const ui = {
    button: null,
    root: null,
    pane: "sync",
  };

  const sync = {
    role: null,
    relayUrl: "",
    sessionId: "",
    key: "",
    hostKey: "",
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

  // Native Spotify social state. This is the Friends feature; the relay above
  // only powers optional automatic invites and sync transport.
  const social = {
    me: null,
    mePromise: null,
    activity: [],
    following: [],
    followers: [],
    loading: {
      activity: false,
      following: false,
      followers: false,
    },
    loadedAt: {
      activity: 0,
      following: 0,
      followers: 0,
    },
    error: "",
    tab: "activity",
    followBusy: new Set(),
    view: "list",
    composeTarget: null,
    relayOpen: false,
    clipboardJam: null,
    clipboardDismissed: "",
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

      state = defaultState();
      state.lastRelayUrl =
        typeof parsed.lastRelayUrl === "string" ? parsed.lastRelayUrl : "";

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
        sync.hostKey =
          config.hostKey ||
          (config.role === "host" ? randomId(32) : "");
        sync.name = config.name || "";
        if (config.role === "host" && !config.hostKey) saveState();
      }
    } catch (err) {
      console.warn("[FreeJam] Could not load saved session", err);
    }
  }

  function saveState() {
    try {
      state.syncConfig = sync.role
        ? {
            role: sync.role,
            relayUrl: sync.relayUrl,
            sessionId: sync.sessionId,
            key: sync.key,
            hostKey: sync.role === "host" ? sync.hostKey : "",
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
    return showAlert(
      `${jam.fromName || "A friend"} started a playback sync`,
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
  // Spotify social graph
  // ---------------------------------------------------------------------------

  const SPCLIENT = "https://spclient.wg.spotify.com";
  const WEB_API = "https://api.spotify.com/v1";

  function usernameFromUri(uri) {
    if (typeof uri !== "string") return "";
    const match = uri.match(/^spotify:user:([^:]+)$/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function normalizeProfile(entry) {
    if (!entry || typeof entry !== "object") return null;

    const username =
      typeof entry.username === "string" && entry.username
        ? entry.username
        : usernameFromUri(entry.uri);
    if (!username) return null;

    return {
      username,
      name:
        typeof entry.name === "string" && entry.name.trim()
          ? entry.name.trim()
          : username,
      imageUrl:
        typeof entry.image_url === "string"
          ? entry.image_url
          : typeof entry.imageUrl === "string"
            ? entry.imageUrl
            : "",
      isFollowing:
        entry.is_following !== undefined
          ? Boolean(entry.is_following)
          : Boolean(entry.isFollowing),
      isFollowed: Boolean(entry.is_followed),
    };
  }

  function socialCanRequest() {
    return Boolean(
      Spicetify.CosmosAsync &&
        typeof Spicetify.CosmosAsync.get === "function"
    );
  }

  // The desktop client stores its local keys under the signed-in username.
  // Fallback only: some accounts get an auto-generated id here.
  function signedInUsername() {
    try {
      const namespace =
        Spicetify.Platform &&
        Spicetify.Platform.LocalStorageAPI &&
        Spicetify.Platform.LocalStorageAPI.namespace;
      if (
        typeof namespace === "string" &&
        /^[A-Za-z0-9._-]{1,64}$/.test(namespace)
      ) {
        return namespace;
      }
    } catch {
      /* ignore */
    }
    return "";
  }

  // Newer accounts have usernames that are random-looking ids, so showing one
  // as an @handle above the display name adds nothing.
  function looksGenerated(username) {
    return /^[0-9a-z]{19,}$/i.test(username);
  }

  // The client's own profile endpoint returns the display name even when the
  // Web API token cannot read it (/v1/me needs the user-read-private scope).
  async function fetchClientProfile(username) {
    if (!username || !socialCanRequest()) return null;
    try {
      const endpoint =
        `${SPCLIENT}/user-profile-view/v3/profile/` +
        encodeURIComponent(username);
      const data = await Spicetify.CosmosAsync.get(endpoint);
      if (!data || typeof data !== "object") return null;

      const name =
        (typeof data.name === "string" && data.name.trim()) ||
        (typeof data.display_name === "string" && data.display_name.trim()) ||
        "";
      const imageUrl =
        (typeof data.image_url === "string" && data.image_url) ||
        (Array.isArray(data.images) && data.images[0] && data.images[0].url) ||
        "";
      if (!name && !imageUrl) return null;

      return {
        username:
          (typeof data.username === "string" && data.username) || "",
        name,
        imageUrl,
      };
    } catch (err) {
      console.warn("[FreeJam] Could not read the Spotify profile", err);
      return null;
    }
  }

  async function getMe(force = false) {
    if (!force && social.me) return social.me;
    if (!force && social.mePromise) return social.mePromise;

    social.mePromise = (async () => {
      let id = signedInUsername();
      let webName = "";
      let webImage = "";

      if (socialCanRequest()) {
        try {
          const data = await Spicetify.CosmosAsync.get(`${WEB_API}/me`);
          if (data && typeof data.id === "string" && data.id) {
            id = data.id;
            webName =
              typeof data.display_name === "string"
                ? data.display_name.trim()
                : "";
            webImage =
              (Array.isArray(data.images) &&
                data.images[0] &&
                data.images[0].url) ||
              "";
          }
        } catch (err) {
          console.warn("[FreeJam] Could not read the Spotify profile", err);
        }
      }

      if (!id) return null;

      const profile = await fetchClientProfile(id);
      const username = (profile && profile.username) || id;
      const name = (profile && profile.name) || webName || username;

      return {
        username,
        name,
        imageUrl: (profile && profile.imageUrl) || webImage || "",
        handle:
          username !== name && !looksGenerated(username) ? username : "",
      };
    })();

    try {
      social.me = await social.mePromise;
    } finally {
      social.mePromise = null;
    }
    return social.me;
  }

  async function loadListeningActivity(force = false) {
    if (social.loading.activity) return;
    if (!force && Date.now() - social.loadedAt.activity < SOCIAL_REFRESH_MS) {
      return;
    }
    if (!socialCanRequest()) {
      social.error = "Spotify's social API is not available in this build.";
      refreshFriendsPanel();
      return;
    }

    social.loading.activity = true;
    try {
      const data = await Spicetify.CosmosAsync.get(
        `${SPCLIENT}/presence-view/v1/buddylist`
      );
      const entries = data && Array.isArray(data.friends) ? data.friends : [];
      const seen = new Set();

      social.activity = entries
        .map((entry) => {
          const user = entry && entry.user;
          const username = usernameFromUri(user && user.uri);
          if (!username || seen.has(username)) return null;
          seen.add(username);

          const track = entry.track;
          return {
            username,
            name: (user && user.name) || username,
            imageUrl: (user && user.imageUrl) || "",
            timestamp: Number(entry.timestamp) || 0,
            track:
              track && typeof track === "object"
                ? {
                    uri: track.uri || "",
                    name: track.name || "",
                    artist: (track.artist && track.artist.name) || "",
                    album: (track.album && track.album.name) || "",
                  }
                : null,
          };
        })
        .filter(Boolean)
        .slice(0, SOCIAL_MAX_LIST);

      social.loadedAt.activity = Date.now();
      social.error = "";
    } catch (err) {
      console.warn("[FreeJam] Could not load Listening Activity", err);
      social.error =
        "Could not load Listening Activity. Turn it on in Spotify's Social settings, then refresh.";
    } finally {
      social.loading.activity = false;
      refreshFriendsPanel();
    }
  }

  async function loadSocialList(kind, force = false) {
    if (kind !== "following" && kind !== "followers") return;
    if (social.loading[kind]) return;
    if (!force && Date.now() - social.loadedAt[kind] < SOCIAL_REFRESH_MS) {
      return;
    }
    if (!socialCanRequest()) {
      social.error = "Spotify's social API is not available in this build.";
      refreshFriendsPanel();
      return;
    }

    social.loading[kind] = true;
    try {
      const me = await getMe();
      if (!me || !me.username) {
        social.error = "Could not read your Spotify profile.";
        return;
      }

      const data = await Spicetify.CosmosAsync.get(
        `${SPCLIENT}/user-profile-view/v3/profile/${encodeURIComponent(
          me.username
        )}/${kind}`
      );
      const profiles = data && Array.isArray(data.profiles) ? data.profiles : [];
      const seen = new Set();

      social[kind] = profiles
        .map(normalizeProfile)
        .filter((profile) => {
          if (!profile || seen.has(profile.username)) return false;
          seen.add(profile.username);
          return true;
        })
        .slice(0, SOCIAL_MAX_LIST);

      social.loadedAt[kind] = Date.now();
      social.error = "";
    } catch (err) {
      console.warn(`[FreeJam] Could not load ${kind}`, err);
      social.error = `Could not load your ${kind} list.`;
    } finally {
      social.loading[kind] = false;
      refreshFriendsPanel();
    }
  }

  async function ensureSocialData(force = false) {
    const me = await getMe(force);
    if (!me) {
      social.error =
        "Could not read your Spotify profile. Open Spotify's profile page once, then refresh.";
      refreshFriendsPanel();
      return;
    }

    await loadListeningActivity(force);
    if (social.tab === "following") await loadSocialList("following", force);
    if (social.tab === "followers") await loadSocialList("followers", force);
    refreshFriendsPanel();
  }

  async function setFollowing(profile, follow) {
    const username = profile && profile.username;
    if (!username || social.followBusy.has(username)) return;

    social.followBusy.add(username);
    refreshFriendsPanel();

    try {
      const definitions = Spicetify.GraphQL && Spicetify.GraphQL.Definitions;
      const definition = definitions
        ? definitions[follow ? "followUsers" : "unfollowUsers"]
        : null;
      if (!definition) throw new Error("Follow API unavailable");

      await Spicetify.GraphQL.Request(definition, { usernames: [username] });

      for (const list of [social.following, social.followers]) {
        for (const item of list) {
          if (item.username === username) item.isFollowing = follow;
        }
      }
      if (!follow && social.tab === "following") {
        social.following = social.following.filter(
          (item) => item.username !== username
        );
      }

      Spicetify.showNotification(
        follow ? `Following ${profile.name}.` : `Unfollowed ${profile.name}.`
      );
    } catch (err) {
      console.warn("[FreeJam] Could not change follow state", err);
      Spicetify.showNotification(
        `Could not ${follow ? "follow" : "unfollow"} ${profile.name}.`,
        true
      );
    } finally {
      social.followBusy.delete(username);
      refreshFriendsPanel();
    }
  }

  function hidePanel() {
    try {
      if (
        Spicetify.PopupModal &&
        typeof Spicetify.PopupModal.hide === "function"
      ) {
        Spicetify.PopupModal.hide();
      }
    } catch {
      /* ignore */
    }
    ui.root = null;
  }

  function openProfile(username, subpage) {
    if (!username) return;
    const suffix =
      subpage === "followers" || subpage === "following" ? `/${subpage}` : "";
    try {
      Spicetify.Platform.History.push(
        `/user/${encodeURIComponent(username)}${suffix}`
      );
      hidePanel();
    } catch (err) {
      console.warn("[FreeJam] Could not open the Spotify profile", err);
      Spicetify.showNotification("Could not open that Spotify profile.", true);
    }
  }

  function openPeopleSearch(query) {
    const value = String(query || "").trim();
    if (!value) return;
    try {
      Spicetify.Platform.History.push(
        `/search/${encodeURIComponent(value)}/users`
      );
      hidePanel();
    } catch (err) {
      console.warn("[FreeJam] Could not open Spotify search", err);
      Spicetify.showNotification("Could not open Spotify search.", true);
    }
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
      if (sync.role === "host") {
        url.searchParams.set("hostKey", sync.hostKey);
      }
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
    sync.hostKey = "";
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

    if (state.lastRelayUrl) {
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
    if (sync.role !== "host" || !sync.sessionId) return null;

    return {
      mode: "sync",
      hostName: friendIdentityName(),
      joinCode: encodeJoinCode({
        relayUrl: sync.relayUrl,
        sessionId: sync.sessionId,
        key: sync.key,
      }),
      sessionId: sync.sessionId,
    };
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
    if (!jam || typeof jam !== "object" || jam.mode !== "sync") return;

    friends.incomingJam = jam;

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

  function joinSyncFromCode(joinCode, fromName) {
    if (sync.role === "host") {
      Spicetify.showNotification(
        "Leave your own sync session before joining a friend's.",
        true
      );
      return false;
    }

    const config = decodeJoinCode(joinCode);
    if (!config) {
      Spicetify.showNotification("This jam invite is invalid or expired.", true);
      return false;
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
    Spicetify.showNotification(
      fromName ? `Joining ${fromName}'s sync.` : "Joining the sync session."
    );
    return true;
  }

  function joinIncomingJam() {
    const jam = friends.incomingJam;
    if (!jam || jam.mode !== "sync") return;
    if (joinSyncFromCode(jam.joinCode, jam.fromName)) {
      clearIncomingJam();
    }
  }

  function detectClipboardInvite() {
    const clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.readText !== "function") return;
    if (sync.role) return;

    clipboard
      .readText()
      .then((text) => {
        const config = decodeJoinCode(text);
        if (!config || sync.role) return;
        if (social.clipboardDismissed === text) return;
        social.clipboardJam = { code: text, config, at: Date.now() };
        refreshPanelSections();
      })
      .catch(() => {});
  }

  function joinClipboardJam() {
    const jam = social.clipboardJam;
    if (!jam) return;
    if (joinSyncFromCode(jam.code, "")) {
      social.clipboardJam = null;
      refreshPanelSections();
    }
  }

  function buildJamInviteText(profile) {
    const jam = buildLocalJam();
    if (!jam) return "";
    const host = friendIdentityName();
    const lines = [];
    lines.push(
      profile && profile.name
        ? `${host} invited you to a FreeJam playback sync.`
        : `Join ${host}'s FreeJam playback sync.`
    );
    lines.push("");
    lines.push(jam.joinCode);
    lines.push("");
    lines.push(
      "Open FreeJam in Spotify, paste the code under Join a sync session, then press Join sync."
    );
    return lines.join("\n");
  }

  function friendInviteMessage() {
    if (!friends.identity) return "";
    const code = encodeFriendCode(friends.identity);
    const jam = buildLocalJam();
    const lines = [];

    if (jam) {
      lines.push(`${friendIdentityName()} is hosting a FreeJam playback sync.`);
      lines.push(`Join code: ${jam.joinCode}`);
    } else {
      lines.push(`${friendIdentityName()} invited you to FreeJam.`);
    }

    lines.push("");
    lines.push("Add me as a friend in FreeJam with this code:");
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
        --fj-fg: #ffffff;
        --fj-muted: #a7a7a7;
        --fj-accent: var(--spice-button, #1ed760);
        --fj-accent-active: var(--spice-button-active, var(--fj-accent));
        --fj-on-accent: var(--spice-button-text, #000000);
        --fj-error: #f15e6c;
        --fj-warn: #f6c358;
        --fj-panel: #0f0f0f;
        --fj-card: #1c1c1c;
        --fj-input: #242424;
        --fj-hover: #2a2a2a;
        --fj-line: #2f2f2f;
        --fj-line-strong: #414141;
        --fj-accent-soft: rgba(29, 185, 84, 0.16);
        --fj-accent-soft: color-mix(in srgb, var(--fj-accent) 18%, transparent);
        --fj-accent-line: rgba(29, 185, 84, 0.4);
        --fj-accent-line: color-mix(in srgb, var(--fj-accent) 45%, transparent);
        --fj-radius: 16px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 20px 24px 24px;
        border-radius: var(--fj-radius);
        background: var(--fj-panel);
        max-height: min(78vh, 860px);
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
        scrollbar-color: var(--fj-line-strong) transparent;
        color: var(--fj-fg);
        font-size: 14px;
        line-height: 1.45;
      }
      /* Keep Spicetify's popup frame black behind the panel. Selector is inert
         when the modal class is not present in this Spotify build. */
      .GenericModal:has(.fj-root) {
        background-color: #0f0f0f;
      }
      .fj-root *,
      .fj-root *::before,
      .fj-root *::after {
        box-sizing: border-box;
      }
      .fj-root [hidden] {
        display: none !important;
      }
      /* Without this the flex column squeezes its sections instead of scrolling. */
      .fj-root > * {
        flex-shrink: 0;
      }
      .fj-root::-webkit-scrollbar {
        width: 10px;
      }
      .fj-root::-webkit-scrollbar-thumb {
        border: 3px solid transparent;
        border-radius: 999px;
        background: var(--fj-line-strong);
        background-clip: content-box;
      }

      /* ---- Status bar ------------------------------------------------------ */
      .fj-hero {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 13px 16px;
        border: 1px solid var(--fj-line);
        border-radius: 12px;
        background: var(--fj-card);
        font-size: 13px;
        line-height: 1.4;
      }
      .fj-hero-text {
        min-width: 0;
      }

      /* ---- Tabs ------------------------------------------------------------ */
      .fj-tabs {
        display: flex;
        gap: 4px;
        padding: 4px;
        border: 1px solid var(--fj-line);
        border-radius: 999px;
        background: var(--fj-card);
      }
      .fj-tab {
        flex: 1 1 0;
        min-width: 0;
        padding: 9px 12px;
        border: 0;
        border-radius: 999px;
        background: transparent;
        color: var(--fj-muted);
        font: inherit;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: background 0.15s ease, color 0.15s ease;
      }
      .fj-tab:hover {
        color: var(--fj-fg);
        background: var(--fj-hover);
      }
      .fj-tab.active {
        color: var(--fj-on-accent);
        background: var(--fj-accent);
      }
      .fj-tab:focus-visible {
        outline: 2px solid var(--fj-accent);
        outline-offset: 2px;
      }

      /* ---- Panes ----------------------------------------------------------- */
      .fj-pane {
        display: none;
      }
      .fj-pane.is-active {
        display: block;
        animation: fj-fade 0.18s ease;
      }
      @keyframes fj-fade {
        from {
          opacity: 0;
          transform: translateY(2px);
        }
        to {
          opacity: 1;
          transform: none;
        }
      }
      .fj-section-body {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .fj-block {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      /* ---- Cards ----------------------------------------------------------- */
      .fj-card {
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 18px 20px;
        border: 1px solid var(--fj-line);
        border-radius: var(--fj-radius);
        background: var(--fj-card);
      }
      .fj-card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        min-height: 24px;
      }
      .fj-card-title {
        font-size: 18px;
        font-weight: 700;
        letter-spacing: -0.01em;
        line-height: 1.3;
      }
      .fj-subtitle {
        color: var(--fj-muted);
        font-size: 11.5px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .fj-badge {
        flex: 0 0 auto;
        padding: 4px 10px;
        border: 1px solid var(--fj-accent-line);
        border-radius: 999px;
        background: var(--fj-accent-soft);
        color: var(--fj-fg);
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        white-space: nowrap;
      }
      .fj-badge.off {
        border-color: var(--fj-line);
        background: transparent;
        color: var(--fj-muted);
      }
      .fj-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
      }
      .fj-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
      }
      .fj-divider {
        height: 1px;
        margin: 2px 0;
        background: var(--fj-line);
      }

      /* ---- Inputs and buttons ---------------------------------------------- */
      .fj-input {
        flex: 1 1 200px;
        min-width: 0;
        padding: 11px 14px;
        border: 1px solid var(--fj-line);
        border-radius: 10px;
        outline: none;
        color: var(--fj-fg);
        background: var(--fj-input);
        font: inherit;
        font-size: 13px;
        transition: border-color 0.15s ease, box-shadow 0.15s ease,
          background 0.15s ease;
      }
      .fj-input::placeholder {
        color: var(--fj-muted);
        opacity: 0.8;
      }
      .fj-input:hover {
        border-color: var(--fj-line-strong);
      }
      .fj-input:focus {
        border-color: var(--fj-accent);
        background: var(--fj-hover);
        box-shadow: 0 0 0 3px var(--fj-accent-soft);
      }
      .fj-name {
        flex: 0 1 150px;
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
        padding: 11px 20px;
        border: 0;
        border-radius: 999px;
        cursor: pointer;
        font: inherit;
        font-size: 13.5px;
        font-weight: 700;
        letter-spacing: 0.01em;
        background: var(--fj-accent);
        color: var(--fj-on-accent);
        transition: background 0.15s ease, box-shadow 0.15s ease,
          transform 0.1s ease, color 0.15s ease;
      }
      .fj-btn:hover {
        background: var(--fj-accent-active);
      }
      .fj-btn:active {
        transform: scale(0.97);
      }
      .fj-btn:focus-visible {
        outline: 2px solid var(--fj-accent);
        outline-offset: 2px;
      }
      .fj-btn:disabled {
        opacity: 0.55;
        cursor: default;
      }
      .fj-btn.secondary {
        background: var(--fj-input);
        color: var(--fj-fg);
        box-shadow: inset 0 0 0 1px var(--fj-line-strong);
      }
      .fj-btn.secondary:hover {
        background: var(--fj-hover);
      }
      .fj-btn.danger {
        background: transparent;
        color: var(--fj-error);
        box-shadow: inset 0 0 0 1px rgba(241, 94, 108, 0.45);
      }
      .fj-btn.danger:hover {
        background: rgba(241, 94, 108, 0.12);
      }
      .fj-btn.ghost {
        background: transparent;
        color: var(--fj-muted);
        box-shadow: none;
      }
      .fj-btn.ghost:hover {
        color: var(--fj-fg);
        background: var(--fj-hover);
      }
      .fj-btn.small {
        padding: 7px 14px;
        font-size: 12px;
      }
      @media (prefers-reduced-motion: reduce) {
        .fj-btn,
        .fj-pane.is-active {
          transition: none;
          animation: none;
        }
        .fj-btn:active {
          transform: none;
        }
      }

      /* ---- Text ------------------------------------------------------------ */
      .fj-hint,
      .fj-muted {
        color: var(--fj-muted);
        font-size: 12.5px;
        line-height: 1.6;
      }
      .fj-root > .fj-hint {
        padding: 0 2px;
        font-size: 12px;
      }
      .fj-warn {
        color: var(--fj-warn);
        font-size: 12.5px;
        line-height: 1.5;
      }
      .fj-empty,
      .fj-social-empty {
        padding: 10px 2px;
        color: var(--fj-muted);
        font-size: 12.5px;
        line-height: 1.55;
      }
      .fj-social-empty {
        padding: 16px 2px;
      }

      /* ---- Status ---------------------------------------------------------- */
      .fj-status {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 11px 13px;
        border-radius: 10px;
        background: var(--fj-input);
        font-size: 12.5px;
      }
      .fj-dot {
        width: 8px;
        height: 8px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: var(--fj-accent);
        box-shadow: 0 0 0 3px var(--fj-accent-soft);
      }
      .fj-dot.off {
        background: var(--fj-muted);
        box-shadow: none;
      }
      .fj-sync-status {
        color: var(--fj-muted);
        font-size: 12.5px;
      }
      .fj-status.fj-jam {
        flex-wrap: wrap;
        background: var(--fj-accent-soft);
      }
      .fj-now {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        font-size: 12px;
      }
      .fj-now-name {
        color: var(--fj-fg);
        font-weight: 600;
      }

      /* ---- Avatars and people ---------------------------------------------- */
      .fj-avatar {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        color: var(--fj-on-accent);
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.02em;
        background: var(--fj-accent);
        background: linear-gradient(
          140deg,
          color-mix(in srgb, var(--fj-accent) 82%, #ffffff),
          var(--fj-accent)
        );
      }
      .fj-avatar.off {
        color: var(--fj-muted);
        background: #333333;
        box-shadow: inset 0 0 0 1px var(--fj-line);
      }
      .fj-avatar-img {
        width: 100%;
        height: 100%;
        border-radius: 50%;
        object-fit: cover;
        display: block;
      }
      .fj-avatar .fj-dot {
        position: absolute;
        right: -1px;
        bottom: -1px;
        z-index: 1;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        box-shadow: 0 0 0 2px var(--fj-card);
      }
      .fj-avatar .fj-dot.off {
        background: var(--fj-muted);
      }
      .fj-list,
      .fj-social-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .fj-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 9px 10px;
        margin: 0 -10px;
        border-radius: 10px;
        transition: background 0.12s ease;
      }
      .fj-item:hover {
        background: var(--fj-hover);
      }
      .fj-item-info {
        flex: 1 1 auto;
        min-width: 0;
      }
      .fj-item-name {
        font-size: 13px;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .fj-item-meta {
        color: var(--fj-muted);
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .fj-item-actions {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        gap: 8px;
        margin-left: auto;
      }
      .fj-item-track {
        display: flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
      }
      .fj-item-track .fj-live {
        color: var(--fj-accent);
        font-size: 8px;
      }
      .fj-me {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 14px;
        border: 1px solid var(--fj-line);
        border-radius: 12px;
        background: var(--fj-input);
      }
      .fj-me-info {
        flex: 1 1 auto;
        min-width: 0;
      }
      .fj-me-name {
        font-weight: 700;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .fj-me-handle {
        color: var(--fj-muted);
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* ---- Settings -------------------------------------------------------- */
      .fj-setting {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 12px 0;
      }
      .fj-setting + .fj-setting {
        border-top: 1px solid var(--fj-line);
      }
      .fj-setting-text {
        min-width: 0;
      }
      .fj-setting-title {
        font-size: 13px;
        font-weight: 600;
      }
      .fj-setting-desc {
        margin-top: 3px;
        color: var(--fj-muted);
        font-size: 11.5px;
        line-height: 1.5;
      }
      .fj-switch {
        position: relative;
        flex: 0 0 auto;
        width: 40px;
        height: 22px;
        padding: 0;
        border: 0;
        border-radius: 999px;
        background: var(--fj-line-strong);
        cursor: pointer;
        transition: background 0.15s ease;
      }
      .fj-switch::after {
        content: "";
        position: absolute;
        top: 3px;
        left: 3px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #ffffff;
        transition: transform 0.15s ease;
      }
      .fj-switch[aria-checked="true"] {
        background: var(--fj-accent);
      }
      .fj-switch[aria-checked="true"]::after {
        background: var(--fj-on-accent);
        transform: translateX(18px);
      }
      .fj-switch:disabled {
        opacity: 0.45;
        cursor: default;
      }
      .fj-switch:focus-visible {
        outline: 2px solid var(--fj-accent);
        outline-offset: 2px;
      }

      /* ---- Invites and codes ----------------------------------------------- */
      .fj-clipboard {
        border: 1px solid var(--fj-accent-line);
      }
      .fj-invite-hero {
        position: relative;
        overflow: hidden;
        padding: 18px;
        border: 1px solid var(--fj-accent-line);
        border-radius: var(--fj-radius);
        background:
          radial-gradient(
            130% 160% at 0% 0%,
            var(--fj-accent-soft),
            transparent 66%
          ),
          var(--fj-input);
      }
      .fj-invite-avatars {
        display: flex;
        align-items: center;
        margin-bottom: 12px;
      }
      .fj-invite-avatars .fj-avatar {
        width: 46px;
        height: 46px;
        font-size: 14px;
        box-shadow: 0 0 0 2px var(--fj-card);
      }
      .fj-invite-avatars .fj-avatar + .fj-avatar {
        margin-left: -12px;
      }
      .fj-invite-kicker {
        color: var(--fj-accent);
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .fj-invite-title {
        margin-top: 4px;
        font-size: 18px;
        font-weight: 800;
        line-height: 1.3;
      }
      .fj-invite-sub {
        margin-top: 5px;
        color: var(--fj-muted);
        font-size: 12.5px;
      }
      .fj-code-card {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 9px 9px 9px 13px;
        border: 1px dashed var(--fj-line-strong);
        border-radius: 12px;
        background: var(--fj-input);
      }
      .fj-code-card .fj-input {
        padding: 0;
        border: 0;
        background: transparent;
        font-size: 11.5px;
      }
      .fj-code-card .fj-input:focus {
        box-shadow: none;
      }

      /* ---- Documentation links --------------------------------------------- */
      .fj-docs {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 4px 12px;
        font-size: 12px;
      }
      .fj-docs-label {
        color: var(--fj-muted);
      }
      .fj-link {
        color: var(--fj-accent);
        font-weight: 600;
        text-decoration: none;
        border-bottom: 1px solid transparent;
      }
      .fj-link::after {
        content: " ↗";
        font-size: 10px;
        opacity: 0.75;
      }
      .fj-link:hover {
        border-bottom-color: currentColor;
      }
      .fj-link:focus-visible {
        outline: 2px solid var(--fj-accent);
        outline-offset: 2px;
      }

      /* ---- Relay details --------------------------------------------------- */
      .fj-relay-details {
        margin-top: 2px;
        padding-top: 14px;
        border-top: 1px solid var(--fj-line);
      }
      .fj-relay-details > summary {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 2px 0;
        color: var(--fj-fg);
        font-size: 13px;
        font-weight: 700;
        list-style: none;
        cursor: pointer;
        user-select: none;
      }
      .fj-relay-details > summary::-webkit-details-marker {
        display: none;
      }
      .fj-relay-details > summary::before {
        content: "";
        flex: 0 0 auto;
        width: 6px;
        height: 6px;
        border-right: 2px solid var(--fj-muted);
        border-bottom: 2px solid var(--fj-muted);
        transform: rotate(-45deg);
        transition: transform 0.15s ease;
      }
      .fj-relay-details[open] > summary::before {
        transform: rotate(45deg);
      }
      .fj-relay-details > summary .fj-badge {
        margin-left: auto;
      }
      .fj-relay-body {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 14px 0 2px;
      }
    `;
    document.head.appendChild(style);
  }

  function actionButton(action, label, variant) {
    const button = el("button", `fj-btn ${variant || ""}`.trim(), label);
    button.dataset.action = action;
    return button;
  }

  function docLink(label, anchor) {
    const link = el("a", "fj-link", label);
    link.href = `${README_URL}${anchor}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.dataset.action = "openDocs";
    link.dataset.url = link.href;
    return link;
  }

  // One row of deep links into the README's relay chapters.
  function docLinks(items) {
    const row = el("div", "fj-docs");
    row.append(el("span", "fj-docs-label", "Relay guide"));
    for (const [label, anchor] of items) row.append(docLink(label, anchor));
    return row;
  }

  // The only external link the panel opens is the project README, and only
  // from a constant URL. A peer-supplied URL never reaches here.
  function openExternal(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      !parsed.pathname.startsWith("/Vineeth-0/freejam/")
    ) {
      return;
    }
    try {
      window.open(parsed.toString(), "_blank", "noopener,noreferrer");
    } catch (err) {
      console.warn("[FreeJam] Could not open the README", err);
    }
  }

  function buildSyncSetupCard() {
    const wrap = el("div", "fj-card");

    const head = el("div", "fj-card-head");
    head.append(el("div", "fj-card-title", "Start a FreeJam session"));
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
    relayInput.placeholder = "Your relay address: ws://<your-LAN-IP>:8787";
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

    wrap.append(
      docLinks([
        ["Where relays come from", "#3-where-the-relay-comes-from"],
        ["Hosting options", "#6-pick-a-hosting-model"],
        ["Self-host step by step", "#7-self-host-step-by-step"],
      ])
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
      actions.append(
        actionButton("socialShareInvite", "Invite friends", "secondary")
      );
      if (friends.identity && friends.list.length) {
        actions.append(
          actionButton("announceJam", "Send to relay friends", "secondary")
        );
      }
    }
    if (sync.role === "guest") {
      actions.append(actionButton("syncResync", "Resync", "secondary"));
    }
    actions.append(actionButton("syncLeave", "Leave sync", "danger"));
    wrap.append(actions);

    wrap.append(
      docLinks([
        ["How to get a relay", "#3-where-the-relay-comes-from"],
        ["Hosting options", "#6-pick-a-hosting-model"],
      ])
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

  function buildAvatar(name, imageUrl, options = {}) {
    const avatar = el("span", "fj-avatar");
    if (options.offline) avatar.classList.add("off");

    if (imageUrl) {
      const image = document.createElement("img");
      image.className = "fj-avatar-img";
      image.src = imageUrl;
      image.alt = "";
      image.loading = "lazy";
      image.addEventListener("error", () => {
        image.remove();
        avatar.textContent = friendInitials(name);
      });
      avatar.append(image);
    } else {
      avatar.textContent = friendInitials(name);
    }

    if (options.online) avatar.append(el("span", "fj-dot"));
    return avatar;
  }

  function socialTabButton(tab, label) {
    const button = el(
      "button",
      `fj-tab${social.tab === tab ? " active" : ""}`,
      label
    );
    button.type = "button";
    button.dataset.action = "socialTab";
    button.dataset.tab = tab;
    button.setAttribute("aria-pressed", social.tab === tab ? "true" : "false");
    return button;
  }

  function buildSocialProfileRow(profile, options = {}) {
    const row = el("div", "fj-item");

    row.append(
      buildAvatar(profile.name, profile.imageUrl, {
        online: options.online,
        offline: options.online === false,
      })
    );

    const info = el("div", "fj-item-info");
    info.append(el("div", "fj-item-name", profile.name));
    info.append(
      el("div", "fj-item-meta", options.meta || `@${profile.username}`)
    );
    row.append(info);

    const actions = el("div", "fj-item-actions");

    if (options.follow !== null && options.follow !== undefined) {
      const busy = social.followBusy.has(profile.username);
      const following = Boolean(options.follow);
      const followButton = el(
        "button",
        `fj-btn small${following ? " secondary" : ""}`,
        busy ? "…" : following ? "Following" : "Follow"
      );
      followButton.dataset.action = following
        ? "socialUnfollow"
        : "socialFollow";
      followButton.dataset.username = profile.username;
      followButton.disabled = busy;
      actions.append(followButton);
    }

    if (options.invite && buildLocalJam()) {
      const invite = el("button", "fj-btn small secondary", "Invite");
      invite.dataset.action = "socialInvite";
      invite.dataset.username = profile.username;
      invite.dataset.name = profile.name;
      invite.dataset.image = profile.imageUrl || "";
      actions.append(invite);
    }

    const open = el("button", "fj-btn small ghost", "Profile");
    open.dataset.action = "socialOpenProfile";
    open.dataset.username = profile.username;
    actions.append(open);

    row.append(actions);
    return row;
  }

  function buildActivityRow(entry) {
    const row = el("div", "fj-item");
    row.append(buildAvatar(entry.name, entry.imageUrl, { online: true }));

    const info = el("div", "fj-item-info");
    info.append(el("div", "fj-item-name", entry.name));

    const meta = el("div", "fj-item-meta");
    if (entry.track && entry.track.name) {
      const track = el("span", "fj-item-track");
      track.append(el("span", "fj-live", "●"));
      track.append(
        el(
          "span",
          null,
          `${entry.track.name}${
            entry.track.artist ? ` · ${entry.track.artist}` : ""
          }`
        )
      );
      meta.append(track);
    } else {
      meta.textContent = "Listening on Spotify";
    }
    if (entry.timestamp) {
      meta.append(document.createTextNode(` · ${timeAgo(entry.timestamp)}`));
    }
    info.append(meta);
    row.append(info);

    const actions = el("div", "fj-item-actions");
    if (buildLocalJam()) {
      const invite = el("button", "fj-btn small secondary", "Invite");
      invite.dataset.action = "socialInvite";
      invite.dataset.username = entry.username;
      invite.dataset.name = entry.name;
      invite.dataset.image = entry.imageUrl || "";
      actions.append(invite);
    }
    const open = el("button", "fj-btn small ghost", "Profile");
    open.dataset.action = "socialOpenProfile";
    open.dataset.username = entry.username;
    actions.append(open);
    row.append(actions);
    return row;
  }

  function socialEmptyText(tab) {
    if (tab === "following") {
      return "You are not following anyone yet. Open Find to search for Spotify profiles.";
    }
    if (tab === "followers") {
      return "No followers yet.";
    }
    return "Nobody is sharing Listening Activity right now. Follow people on Spotify to see them here.";
  }

  function buildFindBody() {
    const wrap = el("div", "fj-block");
    wrap.append(
      el(
        "div",
        "fj-hint",
        "Spotify search opens the Profiles tab, where you can follow people. People you follow appear here with their Listening Activity."
      )
    );

    const row = el("div", "fj-row");
    const input = document.createElement("input");
    input.className = "fj-input";
    input.placeholder = "Name or username";
    input.dataset.fj = "socialSearch";
    const button = el("button", "fj-btn", "Search profiles");
    button.dataset.action = "socialSearch";
    row.append(input, button);
    wrap.append(row);
    return wrap;
  }

  function buildRelayDetails() {
    const details = document.createElement("details");
    details.className = "fj-relay-details";
    details.open = social.relayOpen;
    details.addEventListener("toggle", () => {
      social.relayOpen = details.open;
    });

    const summary = document.createElement("summary");
    summary.append(el("span", null, "Relay invites (optional)"));
    summary.append(
      el(
        "span",
        `fj-badge${friends.connected ? "" : " off"}`,
        friends.connected ? "On" : friends.identity ? "Offline" : "Off"
      )
    );
    details.append(summary);

    const body = el("div", "fj-relay-body");
    body.append(
      el(
        "div",
        "fj-hint",
        "Spotify has no API for sending a jam invite. If you and a friend both use the same self-hosted relay, FreeJam can push the invite automatically. Everyone else: use Share invite and send the code yourself."
      )
    );
    body.append(
      docLinks([["How to get a relay", "#3-where-the-relay-comes-from"]])
    );

    if (!friends.identity) {
      const nameRow = el("div", "fj-row");
      const nameInput = document.createElement("input");
      nameInput.className = "fj-input fj-name";
      nameInput.placeholder = "Your name";
      nameInput.value = sync.name || "";
      nameInput.dataset.fj = "friendName";
      nameRow.append(nameInput);
      body.append(nameRow);

      const relayRow = el("div", "fj-row");
      const relayInput = document.createElement("input");
      relayInput.className = "fj-input";
      relayInput.placeholder = "Your own relay: wss://your-relay.example.com";
      relayInput.value = state.lastRelayUrl || sync.relayUrl || "";
      relayInput.dataset.fj = "friendRelay";
      const create = el("button", "fj-btn", "Enable relay invites");
      create.dataset.action = "friendsCreate";
      relayRow.append(relayInput, create);
      body.append(relayRow);

      details.append(body);
      return details;
    }

    const status = el("div", "fj-status fj-sync-status");
    const dot = el("span", "fj-dot");
    if (!friends.connected) dot.classList.add("off");
    status.append(
      dot,
      el(
        "span",
        null,
        friends.connected
          ? `Connected · ${friends.list.length} friend${
              friends.list.length === 1 ? "" : "s"
            }`
          : friends.error || "Connecting to the friend relay…"
      )
    );
    body.append(status);

    if (!friends.identity.relayUrl) {
      body.append(
        el(
          "div",
          "fj-warn",
          "Add the relay URL in Settings so friends can reach you."
        )
      );
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
    body.append(codeRow);

    const actions = el("div", "fj-actions");
    actions.append(
      actionButton("friendsCopyMessage", "Copy friend invite", "secondary")
    );
    if (!friends.connected && friends.identity.relayUrl) {
      actions.append(
        actionButton("friendsReconnect", "Reconnect", "secondary")
      );
    }
    if (friends.list.length && buildLocalJam()) {
      actions.append(
        actionButton("announceJam", "Send jam to all", "secondary")
      );
    }
    body.append(actions);

    body.append(el("div", "fj-divider"));
    body.append(el("div", "fj-subtitle", "Add a relay friend"));

    const addRow = el("div", "fj-row");
    const addInput = document.createElement("input");
    addInput.className = "fj-input fj-mono";
    addInput.placeholder = "Paste their FJF1 friend code";
    addInput.dataset.fj = "friendCodeInput";
    const addButton = el("button", "fj-btn", "Add friend");
    addButton.dataset.action = "friendsAdd";
    addRow.append(addInput, addButton);
    body.append(addRow);

    const list = el("div", "fj-list");
    if (friends.list.length === 0) {
      list.append(
        el(
          "div",
          "fj-empty",
          "No relay friends yet. Send them your code, then paste theirs here."
        )
      );
    } else {
      for (const friend of friends.list) {
        list.append(buildFriendRow(friend));
      }
    }
    body.append(list);

    body.append(
      el(
        "div",
        "fj-hint",
        "Your code contains a send key, not your private receive key. Friends can send you invites, but cannot read your mailbox or impersonate you."
      )
    );

    details.append(body);
    return details;
  }

  function buildInviteComposer() {
    const wrap = el("div", "fj-card");
    const target = social.composeTarget;

    const head = el("div", "fj-card-head");
    const back = el("button", "fj-btn ghost small", "← Back");
    back.dataset.action = "socialComposeBack";
    head.append(back);
    wrap.append(head);

    const jam = buildLocalJam();
    const hero = el("div", "fj-invite-hero");

    const avatars = el("div", "fj-invite-avatars");
    avatars.append(
      buildAvatar(
        (social.me && social.me.name) || friendIdentityName(),
        (social.me && social.me.imageUrl) || ""
      )
    );
    if (target) {
      avatars.append(buildAvatar(target.name, target.imageUrl));
    }
    hero.append(avatars);

    hero.append(el("div", "fj-invite-kicker", "FreeJam invite"));
    hero.append(
      el(
        "div",
        "fj-invite-title",
        jam
          ? `Join ${friendIdentityName()}'s playback sync`
          : "Start a sync to invite friends"
      )
    );
    hero.append(
      el(
        "div",
        "fj-invite-sub",
        target
          ? `Send this to ${target.name}. They need FreeJam installed.`
          : "Send this to anyone you want in the session."
      )
    );
    wrap.append(hero);

    if (!jam) {
      wrap.append(
        el(
          "div",
          "fj-hint",
          "Host a playback sync first. The invite carries its join code."
        )
      );
      return wrap;
    }

    const codeCard = el("div", "fj-code-card");
    const codeInput = document.createElement("input");
    codeInput.className = "fj-input fj-mono";
    codeInput.readOnly = true;
    codeInput.value = jam.joinCode;
    codeInput.dataset.fj = "inviteCode";
    codeInput.addEventListener("focus", () => codeInput.select());
    const copyCode = el("button", "fj-btn small", "Copy code");
    copyCode.dataset.action = "socialCopyInviteCode";
    codeCard.append(codeInput, copyCode);
    wrap.append(codeCard);

    const actions = el("div", "fj-actions");
    const copyInvite = el("button", "fj-btn", "Copy invite");
    copyInvite.dataset.action = "socialCopyInvite";
    actions.append(copyInvite);

    if (target) {
      const profile = el("button", "fj-btn secondary", "Open profile");
      profile.dataset.action = "socialOpenProfile";
      profile.dataset.username = target.username;
      actions.append(profile);
    }

    if (friends.connected && friends.list.length) {
      const send = el("button", "fj-btn secondary", "Send to relay friends");
      send.dataset.action = "socialSendRelay";
      actions.append(send);
    }
    wrap.append(actions);

    wrap.append(
      el(
        "div",
        "fj-hint",
        "Copy invite puts the message and join code on your clipboard for any chat. Spotify's desktop app does not expose a messaging API, so FreeJam cannot send a Spotify DM for you."
      )
    );

    return wrap;
  }

  function buildFriendsCard() {
    const wrap = el("div", "fj-card");

    const head = el("div", "fj-card-head");
    head.append(el("div", "fj-card-title", "Friends"));
    const listening = social.activity.length;
    const badge = el(
      "span",
      "fj-badge",
      social.loading.activity && !social.loadedAt.activity
        ? "Loading"
        : `${listening} listening`
    );
    if (!listening) badge.classList.add("off");
    head.append(badge);
    wrap.append(head);

    const incoming = friends.incomingJam;
    if (incoming) {
      const box = el("div", "fj-status fj-jam");
      box.append(
        buildAvatar(incoming.fromName || "A friend", "", { online: true })
      );

      const info = el("div", "fj-item-info");
      info.append(
        el(
          "div",
          "fj-item-name",
          `${incoming.fromName || "A friend"} started a playback sync`
        )
      );
      info.append(
        el("div", "fj-item-meta", timeAgo(incoming.at || Date.now()))
      );
      box.append(info);

      const join = el("button", "fj-btn", "Join jam");
      join.dataset.action = "friendsJoin";
      const dismiss = el("button", "fj-btn secondary", "Dismiss");
      dismiss.dataset.action = "friendsDismiss";
      box.append(join, dismiss);
      wrap.append(box);
    }

    if (social.me) {
      const me = el("div", "fj-me");
      me.append(buildAvatar(social.me.name, social.me.imageUrl));

      const info = el("div", "fj-me-info");
      info.append(el("div", "fj-me-name", social.me.name));
      if (social.me.handle) {
        info.append(el("div", "fj-me-handle", `@${social.me.handle}`));
      }
      me.append(info);

      const mine = el("button", "fj-btn small secondary", "My profile");
      mine.dataset.action = "socialOpenProfile";
      mine.dataset.username = social.me.username;
      me.append(mine);

      const followers = el("button", "fj-btn small ghost", "Followers");
      followers.dataset.action = "socialOpenFollowers";
      followers.dataset.username = social.me.username;
      me.append(followers);

      wrap.append(me);
    }

    const tabs = el("div", "fj-tabs");
    tabs.append(socialTabButton("activity", "Activity"));
    tabs.append(socialTabButton("following", "Following"));
    tabs.append(socialTabButton("followers", "Followers"));
    tabs.append(socialTabButton("find", "Find"));
    wrap.append(tabs);

    if (social.error) wrap.append(el("div", "fj-warn", social.error));

    const list = el("div", "fj-social-list");
    if (social.tab === "find") {
      list.append(buildFindBody());
    } else {
      const entries =
        social.tab === "activity" ? social.activity : social[social.tab];
      const loading = social.loading[social.tab];

      if (loading && entries.length === 0) {
        list.append(el("div", "fj-social-empty", "Loading…"));
      } else if (entries.length === 0) {
        list.append(el("div", "fj-social-empty", socialEmptyText(social.tab)));
      } else {
        for (const entry of entries) {
          list.append(
            social.tab === "activity"
              ? buildActivityRow(entry)
              : buildSocialProfileRow(entry, {
                  follow:
                    social.tab === "following" ? true : entry.isFollowing,
                  invite: true,
                })
          );
        }
      }
    }
    wrap.append(list);

    const actions = el("div", "fj-actions");
    const refresh = el("button", "fj-btn ghost small", "Refresh");
    refresh.dataset.action = "socialRefresh";
    actions.append(refresh);

    if (buildLocalJam()) {
      const share = el("button", "fj-btn secondary small", "Share invite");
      share.dataset.action = "socialShareInvite";
      actions.append(share);
    }
    wrap.append(actions);

    wrap.append(buildRelayDetails());

    return wrap;
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
        "Show a Windows or macOS notification when a relay friend starts a jam.",
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
          "Create your friend code under Friends → Relay invites (optional) to set up background alerts and the relay."
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
        "Hide the parts of the panel you do not use. Compact keeps the sync and friends cards and hides the rest. Settings always stays visible."
      )
    );

    const sections = [
      ["sync", "Playback sync", "Relay setup for synced playback."],
      ["friends", "Friends", "Spotify activity, follows and invites."],
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

    wrap.append(
      docLinks([
        ["Point FreeJam at the relay", "#8-point-freejam-at-the-relay"],
      ])
    );

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

  function renderFriendsSection(container) {
    if (!container) return;

    const key = [
      social.view,
      social.view === "compose" && social.composeTarget
        ? social.composeTarget.username
        : "",
      social.me
        ? `${social.me.username}:${social.me.name}:${social.me.handle || ""}`
        : "no-me",
      social.tab,
      social.loading[social.tab] ? "loading" : "",
      social.error,
      social.loadedAt[social.tab],
      social.activity
        .map(
          (entry) =>
            `${entry.username}:${entry.timestamp}:${
              entry.track ? entry.track.uri : ""
            }`
        )
        .join(","),
      social.following
        .map((entry) => `${entry.username}:${entry.isFollowing}`)
        .join(","),
      social.followers
        .map((entry) => `${entry.username}:${entry.isFollowing}`)
        .join(","),
      Array.from(social.followBusy).sort().join(","),
      friends.identity ? "relay" : "norelay",
      friends.identity ? friends.identity.relayUrl : "",
      friends.connected ? "on" : "off",
      friends.error || "",
      friends.list.map((friend) => `${friend.userId}:${friend.name}`).join(","),
      Array.from(friends.online).sort().join(","),
      friends.incomingJam
        ? `${friends.incomingJam.from}|${friends.incomingJam.at}|${friends.incomingJam.mode}`
        : "",
      sync.role === "host" && sync.sessionId
        ? `host:${sync.sessionId}:${sync.members
            .map((member) => `${member.id}:${member.uid || ""}`)
            .join(",")}`
        : "",
    ].join("|");

    if (container.dataset.renderKey === key) return;
    container.dataset.renderKey = key;
    container.replaceChildren(
      social.view === "compose" ? buildInviteComposer() : buildFriendsCard()
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

  function updateButton() {
    if (!ui.button) return;

    ui.button.active = Boolean(sync.role || friends.incomingJam);

    if (friends.incomingJam) {
      ui.button.label = `FreeJam — join ${
        friends.incomingJam.fromName || "a friend"
      }'s jam`;
    } else if (sync.role) {
      ui.button.label = `FreeJam — ${
        sync.connected ? "synced" : "connecting"
      }`;
    } else {
      ui.button.label = "FreeJam — open";
    }
  }

  const PANES = ["sync", "friends", "settings"];

  function paneAvailable(pane) {
    return pane === "settings" || layout[pane] !== false;
  }

  // Show the selected pane and mark its tab. A pane hidden in Settings falls
  // back to the first one that is still visible.
  function applyPane() {
    const root = ui.root;
    if (!root) return;

    if (!paneAvailable(ui.pane)) {
      ui.pane = PANES.find(paneAvailable) || "settings";
    }

    for (const pane of root.querySelectorAll("[data-pane]")) {
      pane.classList.toggle("is-active", pane.dataset.pane === ui.pane);
    }
    for (const tab of root.querySelectorAll("[data-pane-tab]")) {
      const active = tab.dataset.tab === ui.pane;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    }
  }

  function setPane(pane) {
    if (!PANES.includes(pane)) return;
    ui.pane = pane;
    applyPane();
  }

  function applyLayout() {
    const root = ui.root;
    if (!root) return;
    for (const node of root.querySelectorAll("[data-fj-section]")) {
      const key = node.dataset.fjSection;
      node.hidden = layout[key] === false;
    }
    for (const tab of root.querySelectorAll("[data-pane-tab]")) {
      tab.hidden = !paneAvailable(tab.dataset.tab);
    }
    applyPane();
  }

  function renderClipboardCard(container) {
    if (!container) return;
    const jam = social.clipboardJam;

    if (!jam) {
      if (container.childElementCount) container.replaceChildren();
      return;
    }

    const box = el("div", "fj-status fj-jam fj-clipboard");
    box.append(el("span", "fj-dot"));

    const info = el("div", "fj-item-info");
    info.append(el("div", "fj-item-name", "Jam code found on your clipboard"));
    info.append(
      el("div", "fj-item-meta", "Join the playback sync it points to.")
    );
    box.append(info);

    const join = el("button", "fj-btn", "Join jam");
    join.dataset.action = "clipboardJoin";
    const dismiss = el("button", "fj-btn secondary", "Dismiss");
    dismiss.dataset.action = "clipboardDismiss";
    box.append(join, dismiss);

    container.replaceChildren(box);
  }

  // The status bar above the tabs. Rebuilt only when the text changes.
  function renderHero(container) {
    if (!container) return;

    const active = Boolean(sync.role);
    const connected = active && sync.connected;
    const host = active && sync.role === "host";
    const count = Math.max(sync.members.length, 1);

    let text;
    let idle = false;

    if (!active) {
      idle = true;
      text = "No playback sync. Start one below — no Premium needed.";
    } else if (!connected) {
      idle = true;
      text = sync.error || "Connecting to the relay…";
    } else if (host) {
      text = `Playback sync active · ${count} connected.`;
    } else if (sync.hostId) {
      text = `Following ${sync.hostName || "the host"} · ${count} connected.`;
    } else {
      idle = true;
      text = "Connected. Waiting for the host to start playback sync.";
    }

    if (container.dataset.heroKey === text) return;
    container.dataset.heroKey = text;

    const dot = el("span", "fj-dot");
    if (idle) dot.classList.add("off");
    container.replaceChildren(dot, el("span", "fj-hero-text", text));
  }

  function updatePanel() {
    const root = ui.root;
    if (!root || !root.isConnected) {
      if (root && !root.isConnected) ui.root = null;
      return;
    }

    const status = $('[data-fj="status"]', root);
    const clipboardContainer = $('[data-fj="clipboard"]', root);
    const syncContainer = $('[data-fj="sync"]', root);
    const friendsContainer = $('[data-fj="friends"]', root);
    const settingsContainer = $('[data-fj="settings"]', root);
    const hint = $('[data-fj="hint"]', root);

    if (status) renderHero(status);

    if (syncContainer) renderSyncSection(syncContainer);
    if (friendsContainer) renderFriendsSection(friendsContainer);
    if (settingsContainer) renderSettingsSection(settingsContainer);
    if (clipboardContainer) renderClipboardCard(clipboardContainer);

    if (hint) {
      hint.textContent =
        "Use Spotify's normal player controls to control playback. Everyone in the sync follows the host. Follow people on Spotify to see their Listening Activity, and share a jam invite from Friends.";
    }

    applyLayout();
  }

  function openPanel() {
    const root = document.createElement("div");
    root.className = "fj-root";
    root.innerHTML = `
      <div class="fj-hero" data-fj="status"></div>
      <div data-fj="clipboard"></div>
      <div class="fj-tabs fj-panel-tabs" role="tablist" aria-label="FreeJam">
        <button class="fj-tab" type="button" role="tab" data-action="panelTab" data-pane-tab data-tab="sync">Sync</button>
        <button class="fj-tab" type="button" role="tab" data-action="panelTab" data-pane-tab data-tab="friends">Friends</button>
        <button class="fj-tab" type="button" role="tab" data-action="panelTab" data-pane-tab data-tab="settings">Settings</button>
      </div>
      <section class="fj-pane" data-pane="sync" data-fj-section="sync">
        <div class="fj-section-body" data-fj="sync"></div>
      </section>
      <section class="fj-pane" data-pane="friends" data-fj-section="friends">
        <div class="fj-section-body" data-fj="friends"></div>
      </section>
      <section class="fj-pane" data-pane="settings" data-fj-section="settings">
        <div class="fj-section-body" data-fj="settings"></div>
      </section>
      <div class="fj-hint" data-fj="hint" data-fj-section="hint"></div>
    `;
    root.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const button = target.closest("[data-action]");
      if (!button || !root.contains(button)) return;

      // Cancel link navigation right away, then run the action on the next
      // task. Most actions rebuild part of the panel, and replacing the node
      // that is still the target of an in-flight click makes Spotify's React
      // tree lose the event and tear the modal down, so the click looks like a
      // crash. Deferring also keeps the click from reaching the modal's own
      // document-level handlers.
      if (button.tagName === "A") event.preventDefault();
      event.stopPropagation();
      setTimeout(() => {
        onPanelClick(button).catch((err) => {
          console.error("[FreeJam]", err);
        });
      }, 0);
    });

    ui.pane = "sync";
    ui.root = root;
    Spicetify.PopupModal.display({
      title: "FreeJam",
      content: root,
      isLarge: true,
    });
    // The popup must be attached before updatePanel() runs: it deliberately
    // skips work for detached roots so a closed modal does not keep rendering.
    updatePanel();

    detectClipboardInvite();
    ensureSocialData(false);
  }

  async function onPanelClick(button) {
    if (!ui.root || busy) return;

    const action = button.dataset.action;

    try {
      switch (action) {
        case "openDocs": {
          openExternal(button.dataset.url);
          break;
        }
        case "panelTab": {
          setPane(button.dataset.tab);
          break;
        }
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
              "Start a playback sync first.",
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
        case "socialTab": {
          const tab = button.dataset.tab;
          if (!["activity", "following", "followers", "find"].includes(tab)) {
            return;
          }
          social.tab = tab;
          social.error = "";
          refreshFriendsPanel();
          if (tab === "activity") loadListeningActivity(false);
          else if (tab === "following") loadSocialList("following", false);
          else if (tab === "followers") loadSocialList("followers", false);
          break;
        }
        case "socialRefresh": {
          social.error = "";
          refreshFriendsPanel();
          ensureSocialData(true);
          break;
        }
        case "socialFollow":
        case "socialUnfollow": {
          const username = button.dataset.username;
          const profile =
            social.activity.find((entry) => entry.username === username) ||
            social.following.find((entry) => entry.username === username) ||
            social.followers.find((entry) => entry.username === username) ||
            (social.me && social.me.username === username
              ? social.me
              : null);
          if (!profile) return;
          await setFollowing(profile, action === "socialFollow");
          break;
        }
        case "socialOpenProfile": {
          openProfile(button.dataset.username);
          break;
        }
        case "socialOpenFollowers": {
          openProfile(button.dataset.username, "followers");
          break;
        }
        case "socialSearch": {
          const input = $('[data-fj="socialSearch"]', ui.root);
          openPeopleSearch(input ? input.value : "");
          break;
        }
        case "socialInvite": {
          if (!buildLocalJam()) {
            Spicetify.showNotification(
              "Start a playback sync before inviting a friend.",
              true
            );
            return;
          }
          social.composeTarget = {
            username: button.dataset.username || "",
            name: button.dataset.name || "a friend",
            imageUrl: button.dataset.image || "",
          };
          social.view = "compose";
          refreshFriendsPanel();
          break;
        }
        case "socialShareInvite": {
          if (!buildLocalJam()) {
            Spicetify.showNotification(
              "Start a playback sync before sharing an invite.",
              true
            );
            return;
          }
          social.composeTarget = null;
          social.view = "compose";
          setPane("friends");
          refreshFriendsPanel();
          break;
        }
        case "socialComposeBack": {
          social.view = "list";
          social.composeTarget = null;
          refreshFriendsPanel();
          break;
        }
        case "socialCopyInvite": {
          const message = buildJamInviteText(social.composeTarget);
          if (!message) return;
          const copied = await copyText(message);
          Spicetify.showNotification(
            copied
              ? "Invite copied. Paste it in any chat."
              : "Could not copy the invite.",
            !copied
          );
          break;
        }
        case "socialCopyInviteCode": {
          const jam = buildLocalJam();
          if (!jam) return;
          const copied = await copyText(jam.joinCode);
          Spicetify.showNotification(
            copied ? "Join code copied." : "Could not copy the join code.",
            !copied
          );
          break;
        }
        case "socialSendRelay": {
          if (!friends.identity) {
            Spicetify.showNotification("Enable relay invites first.", true);
            return;
          }
          if (!friends.list.length) {
            Spicetify.showNotification("Add a relay friend first.", true);
            return;
          }
          announceJam();
          Spicetify.showNotification(
            friends.connected
              ? "Jam invite sent to your relay friends."
              : "Invite queued. It will send when the relay reconnects."
          );
          break;
        }
        case "clipboardJoin":
          joinClipboardJam();
          break;
        case "clipboardDismiss":
          if (social.clipboardJam) {
            social.clipboardDismissed = social.clipboardJam.code;
          }
          social.clipboardJam = null;
          refreshPanelSections();
          break;
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
            sync: true,
            friends: true,
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
        case "syncHost": {
          const relayInput = $('[data-fj="relayUrl"]', ui.root);
          const nameInput = $('[data-fj="syncHostName"]', ui.root);
          const relayUrl = normalizeRelayUrl(
            relayInput ? relayInput.value : ""
          );
          if (!relayUrl) {
            Spicetify.showNotification(
              "Enter the relay WebSocket URL, using the LAN address printed by your relay on the same Wi-Fi, or the wss:// address of a tunnel you run yourself.",
              true
            );
            return;
          }

          sync.role = "host";
          sync.relayUrl = relayUrl;
          sync.sessionId = randomId(16);
          sync.key = randomId(16);
          sync.hostKey = randomId(32);
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

  (async function init() {
    const ready = await waitFor(
      () =>
        window.Spicetify &&
        Spicetify.Platform &&
        Spicetify.Player &&
        Spicetify.LocalStorage &&
        Spicetify.Playbar &&
        Spicetify.PopupModal
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
