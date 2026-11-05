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
      refreshSyncPanel();
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
      refreshSyncPanel();
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
      }

      refreshSyncPanel();

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
      refreshSyncPanel();
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

    if (message.t === "error") {
      sync.error = String(message.message || "Relay error.");
      refreshSyncPanel();
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

  function leaveSync() {
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

    refreshSyncPanel();
    Spicetify.showNotification("Left the playback sync session.");
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
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 0 24px 24px;
        color: var(--spice-text, #fff);
        font-size: 14px;
        line-height: 1.45;
      }
      .fj-status {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.06);
      }
      .fj-dot {
        width: 8px;
        height: 8px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: #1db954;
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
        padding: 14px;
        border: 1px solid rgba(255, 255, 255, 0.09);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.03);
      }
      .fj-card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .fj-card-title {
        font-weight: 700;
        font-size: 15px;
      }
      .fj-subtitle {
        font-weight: 600;
        font-size: 13px;
      }
      .fj-badge {
        padding: 2px 9px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        background: rgba(29, 185, 84, 0.18);
        color: #1ed760;
      }
      .fj-badge.off {
        background: rgba(255, 255, 255, 0.1);
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
        background: rgba(255, 255, 255, 0.08);
        margin: 2px 0;
      }
      .fj-input {
        flex: 1 1 auto;
        min-width: 0;
        padding: 9px 11px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        outline: none;
        color: inherit;
        background: rgba(255, 255, 255, 0.07);
        font: inherit;
      }
      .fj-input:focus {
        border-color: rgba(255, 255, 255, 0.4);
      }
      .fj-name {
        flex: 0 1 140px;
      }
      .fj-mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
      }
      .fj-btn {
        flex: 0 0 auto;
        padding: 9px 16px;
        border: 0;
        border-radius: 999px;
        cursor: pointer;
        font: inherit;
        font-weight: 700;
        background: var(--spice-button, #1db954);
        color: var(--spice-button-text, #000);
        transition: transform 0.08s ease, filter 0.08s ease;
      }
      .fj-btn:hover {
        filter: brightness(1.08);
      }
      .fj-btn:active {
        transform: scale(0.98);
      }
      .fj-btn.secondary {
        background: transparent;
        color: var(--spice-text, #fff);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.28);
      }
      .fj-btn.danger {
        background: transparent;
        color: #f15e6c;
        box-shadow: inset 0 0 0 1px rgba(241, 94, 108, 0.5);
      }
      .fj-hint,
      .fj-muted {
        color: var(--spice-subtext, #b3b3b3);
        font-size: 12px;
      }
      .fj-warn {
        color: #f6c358;
        font-size: 12px;
      }
      .fj-now {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        font-size: 12px;
      }
      .fj-now-name {
        color: var(--spice-text, #fff);
      }
      .fj-list {
        display: flex;
        flex-direction: column;
      }
      .fj-item {
        display: flex;
        gap: 10px;
        align-items: center;
        padding: 8px 0;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
      }
      .fj-item:first-child {
        border-top: 0;
        padding-top: 0;
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
      .fj-empty {
        padding: 8px 0;
        color: var(--spice-subtext, #b3b3b3);
        font-size: 12px;
      }
      .fj-sync-status {
        background: rgba(255, 255, 255, 0.04);
      }
      .fj-sync-buttons {
        flex-wrap: wrap;
      }
      .fj-seek-row {
        gap: 10px;
      }
      .fj-seek {
        flex: 1 1 auto;
        min-width: 0;
        accent-color: var(--spice-button, #1db954);
      }
      .fj-time {
        flex: 0 0 auto;
        color: var(--spice-subtext, #b3b3b3);
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
        "Using an existing playlist snapshots its current songs, so only new additions get queued."
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
        "Keeps everyone's playhead together and forwards skips, seeks and play/pause to the host. Every participant needs FreeJam. Run freejam-relay.js on the host or deploy it somewhere reachable."
      )
    );

    wrap.append(el("div", "fj-subtitle", "Host a sync session"));
    const hostRow = el("div", "fj-row");
    const relayInput = document.createElement("input");
    relayInput.className = "fj-input";
    relayInput.placeholder = "wss://your-relay.onrender.com";
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

    const controls = el("div", "fj-sync-controls");
    controls.dataset.fj = "syncControls";

    const buttons = el("div", "fj-row fj-sync-buttons");
    buttons.append(
      actionButton("syncPrev", "Previous", "secondary"),
      actionButton("syncToggle", "Play", "secondary"),
      actionButton("syncNext", "Next", "secondary")
    );
    controls.append(buttons);

    const seekRow = el("div", "fj-row fj-seek-row");
    const seek = document.createElement("input");
    seek.type = "range";
    seek.min = "0";
    seek.max = "1000";
    seek.step = "1";
    seek.value = "0";
    seek.className = "fj-seek";
    seek.dataset.fj = "syncSeek";
    const timeLabel = el("span", "fj-mono fj-time", "0:00 / 0:00");
    timeLabel.dataset.fj = "syncTime";
    seekRow.append(seek, timeLabel);
    controls.append(seekRow);
    wrap.append(controls);

    const actions = el("div", "fj-actions");
    if (sync.role === "guest") {
      actions.append(actionButton("syncResync", "Resync", "secondary"));
    }
    actions.append(actionButton("syncLeave", "Leave sync", "danger"));
    wrap.append(actions);

    return wrap;
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
    const toggle = root.querySelector('[data-action="syncToggle"]');
    const seek = $('[data-fj="syncSeek"]', root);
    const time = $('[data-fj="syncTime"]', root);

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

    if (toggle) {
      toggle.textContent = isLocalPlaying() ? "Pause" : "Play";
    }

    if (seek) {
      const local =
        Spicetify.Player.origin && Spicetify.Player.origin._state;
      const duration = (local && Number(local.duration)) || 0;
      const position = getLocalPosition();

      if (!sync.seeking && duration > 0) {
        seek.value = String(
          Math.max(0, Math.min(1000, Math.round((position / duration) * 1000)))
        );
      }

      if (time) {
        time.textContent = `${formatMs(position)} / ${formatMs(duration)}`;
      }
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

    const active = Boolean(state.playlistUri || sync.role);
    ui.button.active = active;

    if (state.playlistUri) {
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

  function updatePanel(forceSessionRender = false) {
    const root = ui.root;
    if (!root || !root.isConnected) {
      if (root && !root.isConnected) ui.root = null;
      return;
    }

    const status = $('[data-fj="status"]', root);
    const session = $('[data-fj="session"]', root);
    const syncContainer = $('[data-fj="sync"]', root);
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
        text = "No active session. Start one below — no Premium needed.";
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
          "Sync mode is active. Use the controls above, or start a request playlist to let guests add songs without installing FreeJam.";
      } else if (state.playlistUri) {
        hint.textContent =
          "Guests open the invite link in the Spotify desktop or mobile app, then add songs to the request playlist. This device queues them automatically. Invite links expire after 7 days.";
      } else {
        hint.textContent =
          "FreeJam creates a normal collaborative playlist and watches it for new songs. It never calls Spotify's Premium-only Jam APIs.";
      }
    }
  }

  function openPanel() {
    const root = document.createElement("div");
    root.className = "fj-root";
    root.innerHTML = `
      <div class="fj-status" data-fj="status"></div>
      <div data-fj="session"></div>
      <div data-fj="sync"></div>
      <div class="fj-card">
        <div class="fj-card-head">
          <span class="fj-card-title">Recent requests</span>
          <span class="fj-muted" data-fj="count"></span>
        </div>
        <div class="fj-now" data-fj="now"></div>
        <div class="fj-list" data-fj="requests"></div>
      </div>
      <div class="fj-hint" data-fj="hint"></div>
    `;
    root.addEventListener("click", onPanelClick);
    root.addEventListener("input", onPanelInput);
    root.addEventListener("change", onPanelChange);

    ui.root = root;
    Spicetify.PopupModal.display({
      title: "FreeJam",
      content: root,
      isLarge: true,
    });
    // The popup must be attached before updatePanel() runs: it deliberately
    // skips work for detached roots so a closed modal does not keep rendering.
    updatePanel();
  }

  function onPanelInput(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.matches('[data-fj="syncSeek"]')) {
      sync.seeking = true;
      const local = Spicetify.Player.origin && Spicetify.Player.origin._state;
      const duration = (local && Number(local.duration)) || 0;
      const ratio = Number(target.value) / 1000;
      const time = $('[data-fj="syncTime"]', ui.root);
      if (time) {
        time.textContent = `${formatMs(ratio * duration)} / ${formatMs(
          duration
        )}`;
      }
    }
  }

  function onPanelChange(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.matches('[data-fj="syncSeek"]')) {
      sync.seeking = false;
      const local = Spicetify.Player.origin && Spicetify.Player.origin._state;
      const duration = (local && Number(local.duration)) || 0;
      const value = Math.round((Number(target.value) / 1000) * duration);
      applySeek(value);
    }
  }

  function applyToggle() {
    const playing = isLocalPlaying();

    if (sync.role === "host") {
      if (playing) Spicetify.Player.pause();
      else Spicetify.Player.play();
      setTimeout(() => broadcastState(true), 100);
    } else if (sync.role === "guest") {
      cancelPendingApply();
      const sent = sendCommand(playing ? "pause" : "play");
      if (playing) Spicetify.Player.pause();
      else Spicetify.Player.play();
      if (sent) sync.applyingUntil = Date.now() + 1200;
    }
  }

  function applySkip(direction) {
    const isNext = direction === "next";

    if (sync.role === "host") {
      if (isNext) Spicetify.Player.next();
      else Spicetify.Player.back();
      setTimeout(() => broadcastState(true), 200);
    } else if (sync.role === "guest") {
      // Skip locally, then let songchange tell the host the exact URI we
      // landed on. Sending a blind "next" would break previous/back.
      cancelPendingApply();
      sync.manualSkipAt = Date.now();
      sync.applyingUntil = 0;
      sync.expectedUntil = 0;
      if (isNext) Spicetify.Player.next();
      else Spicetify.Player.back();
    }
  }

  function applySeek(value) {
    const position = Math.max(0, Math.round(Number(value) || 0));

    if (sync.role === "host") {
      Spicetify.Player.seek(position);
      setTimeout(() => broadcastState(true), 150);
    } else if (sync.role === "guest") {
      cancelPendingApply();
      const sent = sendCommand("seek", position);
      try {
        Spicetify.Player.seek(position);
      } catch (err) {
        console.warn("[FreeJam] Could not seek locally", err);
      }
      if (sent) sync.applyingUntil = Date.now() + 1200;
    }
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
              "Enter the relay WebSocket URL, for example wss://your-relay.onrender.com (or ws://192.168.x.x:8787 on the same Wi-Fi).",
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
          refreshSyncPanel();
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
          refreshSyncPanel();
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
        case "syncPrev":
          applySkip("prev");
          break;
        case "syncNext":
          applySkip("next");
          break;
        case "syncToggle":
          applyToggle();
          break;
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
              refreshSyncPanel();
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
    injectStyles();
    createPlaybarButton();
    registerContextMenu();

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
  })();
})();
