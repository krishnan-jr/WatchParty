(function () {
  window.WATCH_PARTY_LOGGING = true;

  const IN_SYNC_SECONDS = 0.15; // within this, treat as perfectly in sync
  const SOFT_SYNC_SECONDS = 1.0; // up to this gap, converge via playbackRate
  const MAX_RATE_DELTA = 0.1; // cap the gentle nudge at ±10%
  const SEEK_DEBOUNCE_MS = 300;
  const CLOCK_PING_INTERVAL_MS = 10000;

  const player = document.getElementById("player");
  const currentVideoName = document.getElementById("currentVideoName");
  const roomVideoName = document.getElementById("roomVideoName");
  const localVideoFile = document.getElementById("localVideoFile");
  const localSubtitleFile = document.getElementById("localSubtitleFile");
  const subtitleTrack = document.getElementById("subtitleTrack");
  const magnetToggle = document.getElementById("magnetToggle");
  const magnetDrawer = document.getElementById("magnetDrawer");
  const magnetInput = document.getElementById("magnetInput");
  const magnetClear = document.getElementById("magnetClear");
  const magnetButton = document.getElementById("magnetButton");
  const filePicker = document.getElementById("filePicker");
  const filePickerBackdrop = document.getElementById("filePickerBackdrop");
  const filePickerList = document.getElementById("filePickerList");
  const torrentPanel = document.getElementById("torrentPanel");
  const torrentToggle = document.getElementById("torrentToggle");
  const torrentClear = document.getElementById("torrentClear");
  const torrentHealthDot = document.getElementById("torrentHealthDot");
  const torrentHealthLabel = document.getElementById("torrentHealthLabel");
  const torrentInfoName = document.getElementById("torrentInfoName");
  const torrentNote = document.getElementById("torrentNote");
  const torrentNoteToggle = document.getElementById("torrentNoteToggle");
  const torrentNoteType = document.getElementById("torrentNoteType");
  const torrentNoteApproach = document.getElementById("torrentNoteApproach");
  const torrentProgressFill = document.getElementById("torrentProgressFill");
  const torrentProgressLabel = document.getElementById("torrentProgressLabel");
  const tsStat = {
    size: document.getElementById("ts-size"),
    remaining: document.getElementById("ts-remaining"),
    downloaded: document.getElementById("ts-downloaded"),
    uploaded: document.getElementById("ts-uploaded"),
    ratio: document.getElementById("ts-ratio"),
    peers: document.getElementById("ts-peers"),
    down: document.getElementById("ts-down"),
    up: document.getElementById("ts-up"),
    eta: document.getElementById("ts-eta"),
    streaming: document.getElementById("ts-streaming"),
    status: document.getElementById("ts-status")
  };
  const shareLink = document.getElementById("shareLink");
  const connectionStatus = document.getElementById("connectionStatus");
  const syncStatus = document.getElementById("syncStatus");
  const clientsPanel = document.getElementById("clientsPanel");
  const clientsToggle = document.getElementById("clientsToggle");
  const clientCount = document.getElementById("clientCount");
  const clientList = document.getElementById("clientList");
  const socket = io();

  let applyingRemoteSync = false;
  let hasLocalVideo = false;
  let lastSync = null;
  let localVideoUrl = null;
  let localSubtitleUrl = null;
  let seekTimer = null;
  let torrentClient = null;
  let torrentUpdateInterval = null;
  let videoBitrate = null;
  let clockOffset = 0; // serverClock − clientClock, ms
  let bestClockRtt = Infinity;
  let roomPlaying = false;
  let selfBuffering = false;
  let syncGuardTimer = null;

  function roundSeconds(value) {
    return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(3)) : value;
  }

  function formatPayload(payload) {
    if (!payload || typeof payload !== "object") {
      return payload;
    }

    return Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [
        key,
        key.toLowerCase().includes("time") ? roundSeconds(value) : value
      ])
    );
  }

  function getPlayerSnapshot() {
    return {
      currentTime: roundSeconds(player.currentTime),
      duration: roundSeconds(player.duration),
      paused: player.paused,
      readyState: player.readyState,
      hasLocalVideo,
      applyingRemoteSync
    };
  }

  function logWatchParty(message, details = {}) {
    if (!window.WATCH_PARTY_LOGGING) {
      return;
    }

    console.log(`[watch-party ${new Date().toISOString()}] ${message}`, details);
  }

  function setConnectionStatus(message) {
    connectionStatus.textContent = message;
    connectionStatus.dataset.state = message.toLowerCase();
  }

  function setSyncStatus(message) {
    syncStatus.textContent = message;
  }

  function setCurrentVideo(name) {
    currentVideoName.textContent = name || "Choose local video";
  }

  function setRoomVideo(name) {
    roomVideoName.textContent = name ? `Room: ${name}` : "No room video announced";
  }

  function renderClients(clients) {
    clientList.replaceChildren();
    clientCount.textContent = String(clients.length);

    clients.forEach((client) => {
      const item = document.createElement("li");
      item.className = "client-item";

      const indicator = document.createElement("span");
      indicator.className = "client-indicator";

      const name = document.createElement("span");
      name.className = "client-name";
      name.textContent = client.name;

      item.append(indicator, name);
      clientList.appendChild(item);
    });
  }

  function emitAction(eventName) {
    if (applyingRemoteSync || !hasLocalVideo) {
      logWatchParty(`skip emit ${eventName}`, {
        reason: applyingRemoteSync ? "applying remote sync" : "no local video",
        player: getPlayerSnapshot()
      });
      return;
    }

    const payload = {
      time: player.currentTime,
      timestamp: Date.now()
    };

    logWatchParty(`emit ${eventName}`, {
      payload: formatPayload(payload),
      player: getPlayerSnapshot()
    });
    socket.emit(eventName, payload);
  }

  // ── Sync engine ───────────────────────────────────────────────────────
  // The server broadcasts the room's position + play state and freezes that
  // clock whenever ANY client is buffering ("wait for the slowest"). We never
  // hard-snap during normal playback — we glide into sync by nudging
  // playbackRate — and only seek on a large gap or an explicit user seek. A
  // clock-offset estimate keeps cross-device extrapolation accurate.

  function serverNow() {
    return Date.now() + clockOffset;
  }

  function pingClock() {
    socket.emit("clockPing", { t0: Date.now() });
  }

  function withSyncGuard(action) {
    applyingRemoteSync = true;
    action();
    window.clearTimeout(syncGuardTimer);
    syncGuardTimer = window.setTimeout(() => {
      applyingRemoteSync = false;
    }, 250);
  }

  function guardedPlay() {
    if (!player.paused) {
      return;
    }
    withSyncGuard(() => {
      const promise = player.play();
      if (promise && typeof promise.catch === "function") {
        promise.catch(() => setSyncStatus("Tap play to join the sync"));
      }
    });
  }

  function guardedPause() {
    if (player.paused) {
      return;
    }
    withSyncGuard(() => player.pause());
  }

  function guardedSeek(target) {
    const clamped = Math.min(Math.max(0, target), player.duration || target);
    withSyncGuard(() => {
      player.currentTime = clamped;
    });
  }

  function setRate(rate) {
    const next = Number(rate.toFixed(3));
    if (player.playbackRate !== next) {
      player.playbackRate = next;
    }
  }

  function isBuffered(time) {
    const ranges = player.buffered;
    for (let i = 0; i < ranges.length; i += 1) {
      if (time >= ranges.start(i) - 0.25 && time <= ranges.end(i) + 0.25) {
        return true;
      }
    }
    return false;
  }

  function signalBuffering(state) {
    if (selfBuffering === state) {
      return;
    }
    selfBuffering = state;
    logWatchParty("signal buffering", { state });
    socket.emit("buffering", { state });
  }

  function targetPosition(sync) {
    if (!sync.playing || sync.waiting) {
      return sync.position;
    }
    return sync.position + (serverNow() - sync.serverTime) / 1000;
  }

  function canApplyPlaybackSync() {
    return hasLocalVideo && player.readyState >= HTMLMediaElement.HAVE_METADATA;
  }

  function applySync(sync) {
    logWatchParty("receive sync", { sync: formatPayload(sync), player: getPlayerSnapshot() });

    if (!sync || typeof sync.position !== "number" || typeof sync.playing !== "boolean") {
      logWatchParty("reject sync", { reason: "sync must include numeric position and boolean playing", sync });
      return;
    }

    lastSync = sync;
    roomPlaying = sync.playing;

    if (sync.mediaName) {
      setRoomVideo(sync.mediaName);
    }

    if (!canApplyPlaybackSync()) {
      setSyncStatus(sync.mediaName ? "Choose your local copy" : "Choose local video");
      return;
    }

    // Room is held while someone buffers — wait for the slowest viewer.
    if (sync.waiting) {
      setRate(1);
      if (selfBuffering) {
        setSyncStatus("Buffering…");
      } else {
        guardedPause();
        setSyncStatus("Waiting for the other viewer…");
      }
      return;
    }

    // Match the room's play/pause intent.
    if (sync.playing) {
      guardedPlay();
    } else {
      guardedPause();
    }

    const target = Math.max(0, targetPosition(sync));
    const drift = player.currentTime - target; // + ahead, − behind
    const adrift = Math.abs(drift);

    logWatchParty("drift check", {
      localTime: roundSeconds(player.currentTime),
      target: roundSeconds(target),
      drift: roundSeconds(drift),
      playing: sync.playing,
      offsetMs: Math.round(clockOffset)
    });

    // While paused, align quietly — a seek while paused isn't a visible jump.
    if (!sync.playing) {
      setRate(1);
      if (adrift > IN_SYNC_SECONDS && isBuffered(target)) {
        guardedSeek(target);
      }
      setSyncStatus("Paused, in sync");
      return;
    }

    if (adrift <= IN_SYNC_SECONDS) {
      setRate(1);
      setSyncStatus("In sync");
      return;
    }

    if (drift > 0) {
      // Ahead of the room — slow down to let it catch up (always safe).
      if (adrift <= SOFT_SYNC_SECONDS) {
        setRate(1 - Math.min(MAX_RATE_DELTA, drift * 0.3));
        setSyncStatus(`Soft-syncing +${drift.toFixed(2)}s`);
      } else {
        guardedSeek(target);
        setRate(1);
        setSyncStatus("Re-synced");
      }
      return;
    }

    // Behind the room.
    if (isBuffered(target)) {
      if (adrift <= SOFT_SYNC_SECONDS) {
        setRate(1 + Math.min(MAX_RATE_DELTA, adrift * 0.3));
        setSyncStatus(`Soft-syncing −${adrift.toFixed(2)}s`);
      } else {
        guardedSeek(target);
        setRate(1);
        setSyncStatus("Re-synced");
      }
    } else {
      // We lack the data ahead — let the natural stall raise `waiting`, which
      // signals buffering and holds the room for us. Don't snap into the void.
      setRate(1);
      setSyncStatus("Buffering to catch up…");
    }
  }

  function convertSrtToVtt(content) {
    return `WEBVTT\n\n${content.replace(/\r/g, "").replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2")}`;
  }

  function updateSubtitleFromText(content, type) {
    if (localSubtitleUrl) {
      URL.revokeObjectURL(localSubtitleUrl);
    }

    const body = type === "srt" ? convertSrtToVtt(content) : content;
    const blob = new Blob([body], { type: "text/vtt" });
    localSubtitleUrl = URL.createObjectURL(blob);
    subtitleTrack.src = localSubtitleUrl;
    subtitleTrack.track.mode = "showing";
    setSyncStatus("Local subtitles loaded");
  }

  const VIDEO_EXTENSIONS = new Set(["mp4", "mkv", "avi", "mov", "webm", "m4v", "ts", "wmv", "flv", "ogv"]);
  const MSE_EXTENSIONS = new Set(["mp4", "webm", "ogg"]);

  const WSS_TRACKERS = [
    "wss://tracker.btorrent.xyz",
    "wss://tracker.openwebtorrent.com",
    "wss://tracker.fastcast.nz"
  ];

  function injectWssTrackers(magnetUri) {
    return WSS_TRACKERS.reduce((uri, tracker) => {
      const encoded = encodeURIComponent(tracker);
      return uri.includes(encoded) ? uri : uri + "&tr=" + encoded;
    }, magnetUri);
  }

  function isVideoFile(file) {
    return VIDEO_EXTENSIONS.has(file.name.split(".").pop().toLowerCase());
  }

  function isStreamable(file) {
    return MSE_EXTENSIONS.has(file.name.split(".").pop().toLowerCase());
  }

  // Container → how a browser can handle it. "yes": native + MSE-streamable,
  // "maybe": streamable only if the inner codec is browser-friendly,
  // "no": browsers can't decode the container/codecs without transcoding.
  const PLAYBACK_PROFILES = {
    mp4: { container: "MP4 (ISO base media)", stream: "yes" },
    m4v: { container: "MP4 (ISO base media)", stream: "yes" },
    webm: { container: "WebM", stream: "yes" },
    ogv: { container: "Ogg", stream: "yes" },
    ogg: { container: "Ogg", stream: "yes" },
    mov: { container: "QuickTime (MOV)", stream: "maybe" },
    mkv: { container: "Matroska (MKV)", stream: "no" },
    avi: { container: "AVI", stream: "no" },
    wmv: { container: "Windows Media (WMV)", stream: "no" },
    flv: { container: "Flash Video (FLV)", stream: "no" },
    ts: { container: "MPEG-TS", stream: "no" }
  };

  function describeFile(file) {
    const ext = file.name.split(".").pop().toLowerCase();
    const profile = PLAYBACK_PROFILES[ext];
    return profile
      ? { ext, container: profile.container, stream: profile.stream }
      : { ext, container: `${ext.toUpperCase()} container`, stream: "no" };
  }

  function typeLabel(info) {
    return {
      yes: `${info.container} · typically browser-playable`,
      maybe: `${info.container} · streamability depends on its codec`,
      no: `${info.container} · browsers can't decode this natively`
    }[info.stream];
  }

  function setTorrentNote(type, approach, level) {
    torrentNoteType.textContent = type;
    torrentNoteApproach.textContent = approach;
    torrentNote.dataset.level = level;
  }

  // Fallback when renderTo can't progressively stream the file (e.g. a
  // non-fragmented MP4, which MediaSource can't decode incrementally). Download
  // the whole file, then hand the browser a Blob URL so its native demuxer plays
  // it. If even that can't decode (e.g. HEVC/H.265, AC3 audio), report honestly.
  function playViaBlob(file, type) {
    setSyncStatus("Can't stream — downloading full file…");
    setTorrentNote(
      type,
      "Can't stream this file incrementally (likely a non-fragmented MP4). Downloading it in full — it'll play once complete; watch the progress below.",
      "warn"
    );

    file.getBlobURL((err, url) => {
      if (err) {
        logWatchParty("getBlobURL failed", { message: err && err.message, name: file.name });
        setSyncStatus("Couldn't load this video");
        setTorrentNote(type, "Failed to download the file for playback.", "err");
        hasLocalVideo = false;
        applyingRemoteSync = false;
        return;
      }

      player.addEventListener(
        "error",
        () => {
          logWatchParty("blob playback failed", { name: file.name });
          setSyncStatus("Couldn't decode this video");
          setTorrentNote(
            type,
            "Your browser can't decode this file's codec (often HEVC/H.265 video or AC3 audio). Use an H.264/AAC release or transcode it first.",
            "err"
          );
          hasLocalVideo = false;
          applyingRemoteSync = false;
        },
        { once: true }
      );

      player.src = url;
      player.load();
      player.play().catch(() => {});
      setSyncStatus("Playing downloaded file");
      setTorrentNote(type, "Couldn't stream incrementally, so the full file was downloaded and is now playing.", "ok");
    });
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }

  function formatSpeed(bps) {
    if (bps < 1024) return `${Math.round(bps)} B/s`;
    if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
    return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
  }

  function formatETA(ms) {
    if (!ms || !Number.isFinite(ms) || ms <= 0) return "—";
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  function getTorrentHealth(torrent) {
    if (torrent.done) return { label: "Seeding", level: 5 };
    const { numPeers, downloadSpeed } = torrent;
    if (numPeers === 0) return { label: "Dead", level: 0 };
    if (numPeers <= 2 || downloadSpeed < 50 * 1024) return { label: "Poor", level: 1 };
    if (numPeers <= 5 || downloadSpeed < 500 * 1024) return { label: "Fair", level: 2 };
    if (numPeers <= 15 || downloadSpeed < 2 * 1024 * 1024) return { label: "Good", level: 3 };
    return { label: "Excellent", level: 4 };
  }

  function getStreamingViability(torrent) {
    if (!videoBitrate) return { label: "—", ok: null };
    if (torrent.done) return { label: "Fully buffered", ok: true };
    if (torrent.downloadSpeed >= videoBitrate * 1.2) return { label: "Buffering ahead", ok: true };
    if (torrent.downloadSpeed >= videoBitrate * 0.8) return { label: "Keeping up", ok: true };
    return { label: "May stutter", ok: false };
  }

  function updateTorrentPanel(torrent) {
    const health = getTorrentHealth(torrent);
    const viability = getStreamingViability(torrent);
    const progress = torrent.progress;

    torrentHealthDot.dataset.level = health.level;
    torrentHealthLabel.textContent = health.label;
    torrentInfoName.textContent = torrent.name || "—";
    torrentProgressFill.style.width = `${(progress * 100).toFixed(1)}%`;
    torrentProgressLabel.textContent = `${(progress * 100).toFixed(1)}%`;

    tsStat.size.textContent = formatBytes(torrent.length);
    tsStat.remaining.textContent = formatBytes(torrent.length * (1 - progress));
    tsStat.downloaded.textContent = formatBytes(torrent.downloaded);
    tsStat.uploaded.textContent = formatBytes(torrent.uploaded);
    tsStat.ratio.textContent = torrent.ratio.toFixed(2);
    tsStat.peers.textContent = torrent.numPeers;
    tsStat.down.textContent = formatSpeed(torrent.downloadSpeed);
    tsStat.up.textContent = formatSpeed(torrent.uploadSpeed);
    tsStat.eta.textContent = torrent.done ? "Done" : formatETA(torrent.timeRemaining);
    tsStat.streaming.textContent = viability.label;
    if (viability.ok !== null) {
      tsStat.streaming.dataset.ok = viability.ok;
    } else {
      delete tsStat.streaming.dataset.ok;
    }
    tsStat.status.textContent = torrent.done ? "Seeding" : torrent.paused ? "Paused" : "Downloading";
  }

  function startTorrentPanel(torrent) {
    torrentPanel.removeAttribute("hidden");
    updateTorrentPanel(torrent);
    torrentUpdateInterval = setInterval(() => updateTorrentPanel(torrent), 1000);
  }

  function stopTorrentPanel() {
    clearInterval(torrentUpdateInterval);
    torrentUpdateInterval = null;
    videoBitrate = null;
    setTorrentNote("Analyzing…", "—", "info");
    torrentPanel.setAttribute("hidden", "");
    torrentPanel.classList.remove("is-open");
    torrentToggle.setAttribute("aria-expanded", "false");
  }

  function streamFile(file) {
    const info = describeFile(file);
    const type = typeLabel(info);

    if (typeof file.renderTo !== "function") {
      setSyncStatus("Torrent streaming unavailable — unsupported WebTorrent version");
      setTorrentNote(type, "This WebTorrent build can't stream — reload the page to fetch a compatible version.", "err");
      return;
    }

    setSyncStatus("Buffering...");
    setTorrentNote(
      type,
      info.stream === "no"
        ? "Attempting an in-browser stream anyway — this usually needs an MP4/H.264 release or a transcode."
        : "Starting progressive stream — playing as the torrent downloads…",
      info.stream === "yes" ? "ok" : info.stream === "maybe" ? "warn" : "err"
    );

    applyingRemoteSync = true;
    hasLocalVideo = true;
    setCurrentVideo(file.name);

    player.pause();
    player.removeAttribute("src");
    player.load();

    try {
      file.renderTo(player, { autoplay: true }, (err) => {
        if (err) {
          logWatchParty("renderTo failed", { message: err && err.message, name: file.name });
          playViaBlob(file, type);
          return;
        }
        setSyncStatus("Stream ready");
        setTorrentNote(type, "Playing progressively via WebTorrent's native MediaSource renderer as the torrent downloads.", "ok");
      });
    } catch (e) {
      logWatchParty("renderTo threw", { message: e && e.message, name: file.name });
      playViaBlob(file, type);
    }

    player.addEventListener(
      "loadedmetadata",
      () => {
        if (player.duration && file.length) {
          videoBitrate = file.length / player.duration;
        }
        const payload = { name: file.name, duration: player.duration, timestamp: Date.now() };
        logWatchParty("emit media (torrent)", { payload: formatPayload(payload) });
        socket.emit("media", payload);
        if (lastSync) {
          applySync(lastSync);
        }
      },
      { once: true }
    );

    window.setTimeout(() => {
      applyingRemoteSync = false;
    }, 150);
  }

  function showFilePicker(videoFiles) {
    filePickerList.replaceChildren();

    videoFiles.forEach((file) => {
      const li = document.createElement("li");
      li.className = "file-picker-item";

      const name = document.createElement("span");
      name.className = "file-picker-name";
      name.textContent = file.name;

      const meta = document.createElement("span");
      meta.className = "file-picker-meta";

      const size = document.createElement("span");
      size.className = "file-picker-size";
      size.textContent = formatBytes(file.length);
      meta.appendChild(size);

      if (!isStreamable(file)) {
        const warn = document.createElement("span");
        warn.className = "file-picker-warn";
        warn.textContent = "full download";
        meta.appendChild(warn);
      }

      li.append(name, meta);
      li.addEventListener("click", () => {
        filePicker.setAttribute("hidden", "");
        streamFile(file);
      });
      filePickerList.appendChild(li);
    });

    filePicker.removeAttribute("hidden");
  }

  // --- Persistent torrent storage (IndexedDB) -----------------------------
  // Browser WebTorrent defaults to an in-memory chunk store, so a page refresh
  // drops every downloaded piece and the torrent restarts from zero. Backing it
  // with idb-chunk-store writes pieces to IndexedDB (on disk, not RAM), keyed by
  // infohash, so re-adding the same magnet verifies the cached pieces and
  // resumes instead of re-downloading. Loaded as an ESM bundle on first use.
  let chunkStoreModule = null;
  function loadChunkStore() {
    if (!chunkStoreModule) {
      // Use esm.sh, not jsdelivr's /+esm: jsdelivr's auto-bundle default-imports
      // idb (which has no default export), leaving it null so the store throws
      // "Cannot read property of null (reading 'openDB')" on construction.
      chunkStoreModule = import("https://esm.sh/idb-chunk-store@1.0.1").then((m) => {
        const Store = m.default;
        // Construct once to surface any CDN/interop failure here — inside the
        // prepareChunkStore try/catch — rather than later inside WebTorrent,
        // where it would kill the torrent instead of falling back to memory.
        new Store(16384, { name: "__wp_probe__" }).destroy(() => {});
        return Store;
      });
    }
    return chunkStoreModule;
  }

  function magnetInfoHash(magnetUri) {
    const match = magnetUri.match(/urn:btih:([^&]+)/i);
    return match ? match[1].toLowerCase() : null;
  }

  // Request durable storage (so the browser won't evict the cache under disk
  // pressure) and return a chunk-store factory keyed to this torrent's
  // infohash. Returns null to fall back to the default in-memory store when
  // IndexedDB is unavailable or the module fails to load.
  async function prepareChunkStore(infoHash) {
    if (!infoHash || !navigator.storage) return null;
    try {
      if (navigator.storage.persist) {
        const persisted = await navigator.storage.persist();
        logWatchParty("storage.persist", { persisted });
      }
      const IdbChunkStore = await loadChunkStore();
      touchCache(infoHash);
      return function (chunkLength, storeOpts) {
        return new IdbChunkStore(
          chunkLength,
          Object.assign({}, storeOpts, { name: infoHash })
        );
      };
    } catch (e) {
      logWatchParty("idb-chunk-store unavailable, using memory store", {
        message: e && e.message
      });
      return null;
    }
  }

  // Once metadata arrives we know the real file size; warn if the browser's
  // storage quota can't hold it, since the cache won't survive a refresh then.
  async function warnIfStorageShort(torrent) {
    if (!navigator.storage || !navigator.storage.estimate || !torrent.length) return;
    try {
      const { quota, usage } = await navigator.storage.estimate();
      const free = (quota || 0) - (usage || 0);
      logWatchParty("storage.estimate", { quota, usage, free, needed: torrent.length });
      if (free < torrent.length) {
        setTorrentNote(
          torrent.name || "Low storage",
          `This file is ${formatBytes(torrent.length)} but only ${formatBytes(free)} of ` +
            "browser storage is free. It may not fully cache, and progress could be lost on refresh.",
          "warn"
        );
      }
    } catch (e) {
      logWatchParty("storage.estimate failed", { message: e && e.message });
    }
  }

  // --- Cache cleanup ------------------------------------------------------
  // idb-chunk-store names its IndexedDB database after the infohash we pass, so
  // each torrent's cache is exactly one database. IndexedDB exposes no
  // creation/last-used time, so we track that in a small localStorage registry
  // and delete databases by infohash. Deletes run fire-and-forget — they're
  // housekeeping and must never block playback.
  const CACHE_REGISTRY_KEY = "wp:torrentCache";
  const CACHE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
  let activeInfoHash = null;

  function readCacheRegistry() {
    try {
      return JSON.parse(localStorage.getItem(CACHE_REGISTRY_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function writeCacheRegistry(reg) {
    try {
      localStorage.setItem(CACHE_REGISTRY_KEY, JSON.stringify(reg));
    } catch (e) {
      logWatchParty("cache registry write failed", { message: e && e.message });
    }
  }

  function touchCache(infoHash) {
    if (!infoHash) return;
    const reg = readCacheRegistry();
    reg[infoHash] = Date.now();
    writeCacheRegistry(reg);
  }

  function deleteIdbDatabase(name) {
    return new Promise((resolve) => {
      if (!window.indexedDB) return resolve();
      try {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = req.onerror = () => resolve();
        req.onblocked = () => {
          logWatchParty("idb delete blocked — completes once connections close", { name });
          resolve();
        };
      } catch (e) {
        logWatchParty("idb delete threw", { name, message: e && e.message });
        resolve();
      }
    });
  }

  // Delete one torrent's cached pieces and drop it from the registry.
  async function deleteCache(infoHash) {
    if (!infoHash) return;
    const reg = readCacheRegistry();
    delete reg[infoHash];
    writeCacheRegistry(reg);
    await deleteIdbDatabase(infoHash);
    logWatchParty("cache deleted", { infoHash });
  }

  // New file loaded: drop every cached torrent except the one we're about to
  // use. Pass null to drop all of them (e.g. switching to a local file).
  async function purgeCachesExcept(keepInfoHash) {
    for (const infoHash of Object.keys(readCacheRegistry())) {
      if (infoHash !== keepInfoHash) await deleteCache(infoHash);
    }
  }

  // Startup housekeeping: evict caches not used in the last 3 days, but never
  // keepInfoHash — that's the cache we're about to resume, and deleting it
  // mid-open would race with the torrent re-attaching to it.
  async function evictStaleCaches(keepInfoHash) {
    const reg = readCacheRegistry();
    const now = Date.now();
    for (const infoHash of Object.keys(reg)) {
      if (infoHash === keepInfoHash) continue;
      if (now - reg[infoHash] > CACHE_MAX_AGE_MS) await deleteCache(infoHash);
    }
  }

  async function loadMagnet(magnetUri) {
    if (!magnetUri.trim().startsWith("magnet:")) {
      setSyncStatus("Not a valid magnet link");
      return;
    }

    if (torrentClient) {
      torrentClient.destroy();
      torrentClient = null;
    }

    stopTorrentPanel();

    if (localVideoUrl) {
      URL.revokeObjectURL(localVideoUrl);
      localVideoUrl = null;
    }

    history.replaceState(null, "", "#" + encodeURIComponent(magnetUri.trim()));
    magnetInput.value = magnetUri.trim();
    magnetClear.hidden = false;
    updateShareHref();

    setSyncStatus("Finding peers...");
    magnetButton.disabled = true;
    magnetButton.textContent = "Loading...";

    torrentClient = new WebTorrent();

    torrentClient.on("error", (err) => {
      setSyncStatus("Torrent error: " + err.message);
      magnetButton.disabled = false;
      magnetButton.textContent = "Stream";
    });

    const infoHash = magnetInfoHash(magnetUri.trim());
    activeInfoHash = infoHash;
    if (infoHash) await purgeCachesExcept(infoHash); // new file: drop other torrents' caches
    const storeFactory = await prepareChunkStore(infoHash);
    const addOpts = storeFactory ? { store: storeFactory } : {};

    torrentClient.add(injectWssTrackers(magnetUri.trim()), addOpts, (torrent) => {
      // Disable seeding: choke all peers so we never upload pieces.
      torrent.on("wire", (wire) => {
        wire.choke();
        wire.on("interested", () => wire.choke());
      });

      magnetButton.disabled = false;
      magnetButton.textContent = "Stream";

      const videoFiles = torrent.files.filter(isVideoFile);

      if (videoFiles.length === 0) {
        setSyncStatus("No video files found in torrent");
        startTorrentPanel(torrent);
        setTorrentNote("No video files in this torrent", "Nothing to play — check that the magnet points at a video release.", "err");
        return;
      }

      startTorrentPanel(torrent);
      warnIfStorageShort(torrent);

      if (videoFiles.length === 1) {
        streamFile(videoFiles[0]);
        return;
      }

      const streamableFiles = videoFiles.filter(isStreamable);

      if (streamableFiles.length === 1) {
        streamFile(streamableFiles[0]);
        return;
      }

      setTorrentNote(`${videoFiles.length} video files in this torrent`, "Pick a file to start streaming it progressively.", "info");
      showFilePicker(videoFiles);
    });
  }

  let shareBaseUrl = null;
  let shareCopyTimer = null;

  function updateShareHref() {
    if (!shareBaseUrl) return;
    shareLink.dataset.url = shareBaseUrl + window.location.hash;
  }

  async function loadShareLink() {
    const response = await fetch("/tunnel");

    if (!response.ok) {
      return;
    }

    const result = await response.json();
    if (!result.url) {
      return;
    }

    shareBaseUrl = result.url;
    updateShareHref();
    shareLink.classList.add("is-visible");
  }

  shareLink.addEventListener("click", () => {
    const url = shareLink.dataset.url;
    if (!url) return;
    navigator.clipboard.writeText(url).then(() => {
      shareLink.textContent = "Copied!";
      clearTimeout(shareCopyTimer);
      shareCopyTimer = setTimeout(() => {
        shareLink.textContent = "Share";
      }, 2000);
    });
  });

  socket.on("connect", () => {
    logWatchParty("socket connected", {
      socketId: socket.id,
      player: getPlayerSnapshot()
    });
    setConnectionStatus("Connected");
    bestClockRtt = Infinity;
    for (let i = 0; i < 5; i += 1) {
      window.setTimeout(pingClock, i * 200);
    }
    if (lastSync) {
      applySync(lastSync);
    }
  });

  socket.on("disconnect", () => {
    logWatchParty("socket disconnected", {
      socketId: socket.id
    });
    setConnectionStatus("Disconnected");
  });

  socket.io.on("reconnect", () => {
    logWatchParty("socket reconnected", {
      socketId: socket.id
    });
    setConnectionStatus("Reconnected");
  });

  socket.on("sync", applySync);

  // NTP-lite clock offset: keep the sample with the lowest round-trip, since
  // that one was least distorted by network jitter.
  socket.on("clockPong", (message) => {
    if (!message || typeof message.t0 !== "number" || typeof message.serverTs !== "number") {
      return;
    }
    const t3 = Date.now();
    const rtt = t3 - message.t0;
    if (rtt < bestClockRtt) {
      bestClockRtt = rtt;
      clockOffset = message.serverTs - (message.t0 + t3) / 2;
      logWatchParty("clock offset updated", { offsetMs: Math.round(clockOffset), rttMs: rtt });
    }
  });

  socket.on("clients", (clients) => {
    logWatchParty("receive clients", {
      count: Array.isArray(clients) ? clients.length : 0,
      clients
    });
    renderClients(Array.isArray(clients) ? clients : []);
  });

  socket.on("mediaChanged", (payload) => {
    logWatchParty("receive mediaChanged", {
      payload: formatPayload(payload)
    });
    const name = payload && payload.name;
    setRoomVideo(name);
    setSyncStatus("Choose matching local copy");
  });

  clientsToggle.addEventListener("click", () => {
    const isOpen = clientsPanel.classList.toggle("is-open");
    clientsToggle.setAttribute("aria-expanded", String(isOpen));
  });

  torrentToggle.addEventListener("click", () => {
    const isOpen = torrentPanel.classList.toggle("is-open");
    torrentToggle.setAttribute("aria-expanded", String(isOpen));
  });

  torrentNoteToggle.addEventListener("click", () => {
    const isOpen = torrentNote.classList.toggle("is-open");
    torrentNoteToggle.setAttribute("aria-expanded", String(isOpen));
  });

  torrentClear.addEventListener("click", () => {
    if (torrentClient) {
      torrentClient.destroy();
      torrentClient = null;
    }
    if (activeInfoHash) {
      deleteCache(activeInfoHash).catch(() => {});
      activeInfoHash = null;
    }
    stopTorrentPanel();
    history.replaceState(null, "", window.location.pathname);
    updateShareHref();
    player.src = "";
    player.load();
    hasLocalVideo = false;
    setCurrentVideo(null);
    setRoomVideo(null);
    setSyncStatus("Waiting for sync");
    magnetInput.value = "";
  });

  filePickerBackdrop.addEventListener("click", () => {
    filePicker.setAttribute("hidden", "");
  });

  magnetToggle.addEventListener("click", () => {
    const nowHidden = magnetDrawer.toggleAttribute("hidden");
    if (!nowHidden) {
      magnetInput.focus();
    }
  });

  magnetInput.addEventListener("input", () => {
    magnetClear.hidden = !magnetInput.value;
  });

  magnetClear.addEventListener("click", () => {
    magnetInput.value = "";
    magnetClear.hidden = true;
    magnetInput.focus();
  });

  magnetButton.addEventListener("click", () => {
    loadMagnet(magnetInput.value);
  });

  magnetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      loadMagnet(magnetInput.value);
    }
  });

  localVideoFile.addEventListener("change", () => {
    const file = localVideoFile.files && localVideoFile.files[0];
    if (!file) {
      return;
    }

    if (torrentClient) {
      torrentClient.destroy();
      torrentClient = null;
    }
    activeInfoHash = null;
    purgeCachesExcept(null).catch(() => {}); // switching to a local file: drop all torrent caches

    stopTorrentPanel();
    history.replaceState(null, "", window.location.pathname);
    updateShareHref();

    if (localVideoUrl) {
      URL.revokeObjectURL(localVideoUrl);
    }

    applyingRemoteSync = true;
    hasLocalVideo = true;
    localVideoUrl = URL.createObjectURL(file);
    player.src = localVideoUrl;
    player.load();
    setCurrentVideo(file.name);
    setRoomVideo(file.name);
    setSyncStatus("Local video loaded");
    logWatchParty("local video selected", {
      name: file.name,
      size: file.size,
      type: file.type
    });

    player.addEventListener(
      "loadedmetadata",
      () => {
        const payload = {
          name: file.name,
          duration: player.duration,
          timestamp: Date.now()
        };

        logWatchParty("emit media", {
          payload: formatPayload(payload),
          player: getPlayerSnapshot()
        });
        socket.emit("media", payload);

        if (lastSync) {
          applySync(lastSync);
        }
      },
      { once: true }
    );

    window.setTimeout(() => {
      applyingRemoteSync = false;
      logWatchParty("local video guard released", {
        player: getPlayerSnapshot()
      });
    }, 150);
  });

  localSubtitleFile.addEventListener("change", () => {
    const file = localSubtitleFile.files && localSubtitleFile.files[0];
    if (!file) {
      return;
    }

    const extension = file.name.split(".").pop().toLowerCase();
    if (extension !== "vtt" && extension !== "srt") {
      logWatchParty("reject local subtitle", {
        name: file.name,
        extension
      });
      setSyncStatus("Choose VTT or SRT subtitles");
      return;
    }

    logWatchParty("local subtitle selected", {
      name: file.name,
      extension,
      size: file.size
    });
    file.text()
      .then((content) => updateSubtitleFromText(content, extension))
      .catch((error) => {
        logWatchParty("local subtitle failed", {
          name: file.name,
          message: error && error.message
        });
        setSyncStatus("Could not load subtitles");
      });
  });

  player.addEventListener("play", () => {
    emitAction("play");
  });

  player.addEventListener("pause", () => {
    emitAction("pause");
  });

  // Chromium disables the native fullscreen button on MediaSource-fed video
  // (WebTorrent's streaming path), so drive fullscreen ourselves on double-click.
  function toggleFullscreen() {
    const active = document.fullscreenElement || document.webkitFullscreenElement;
    if (active) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (player.requestFullscreen) {
      player.requestFullscreen().catch(() => {});
    } else if (player.webkitRequestFullscreen) {
      player.webkitRequestFullscreen();
    } else if (player.webkitEnterFullscreen) {
      player.webkitEnterFullscreen(); // iOS Safari
    }
  }

  player.addEventListener("dblclick", toggleFullscreen);

  player.addEventListener("seeked", () => {
    if (applyingRemoteSync) {
      logWatchParty("ignore local seeked", {
        reason: "applying remote sync",
        player: getPlayerSnapshot()
      });
      return;
    }

    window.clearTimeout(seekTimer);
    logWatchParty("local seeked debounce start", {
      delayMs: SEEK_DEBOUNCE_MS,
      player: getPlayerSnapshot()
    });
    seekTimer = window.setTimeout(() => {
      emitAction("seek");
    }, SEEK_DEBOUNCE_MS);
  });

  player.addEventListener("waiting", () => {
    logWatchParty("player waiting", { player: getPlayerSnapshot() });
    if (hasLocalVideo && (roomPlaying || !player.paused)) {
      signalBuffering(true); // hold the room until we recover
    }
    setSyncStatus("Buffering…");
  });

  player.addEventListener("playing", () => {
    logWatchParty("player playing", { player: getPlayerSnapshot() });
    signalBuffering(false);
  });

  player.addEventListener("canplay", () => {
    logWatchParty("player canplay", {
      hasLastSync: Boolean(lastSync),
      player: getPlayerSnapshot()
    });
    signalBuffering(false);
    if (lastSync) {
      applySync(lastSync);
    }
  });

  // Guard against an accidental refresh/close while a torrent is loaded. Even
  // with the persistent cache a reload interrupts playback and forces a
  // re-verify, so prompt first. Browsers show their own generic confirmation.
  window.addEventListener("beforeunload", (e) => {
    if (torrentClient && torrentClient.torrents.length > 0) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  let initialMagnet = null;
  if (window.location.hash) {
    const hashValue = decodeURIComponent(window.location.hash.slice(1));
    if (hashValue.startsWith("magnet:")) {
      initialMagnet = hashValue;
    }
  }

  // Evict caches unused for >3 days, but keep the one we're about to resume.
  evictStaleCaches(initialMagnet ? magnetInfoHash(initialMagnet) : null).catch(() => {});

  if (initialMagnet) {
    loadMagnet(initialMagnet);
  }

  loadShareLink().catch(() => {});
  window.setInterval(pingClock, CLOCK_PING_INTERVAL_MS);
})();
