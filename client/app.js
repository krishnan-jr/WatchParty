(function () {
  window.WATCH_PARTY_LOGGING = true;

  const DRIFT_THRESHOLD_SECONDS = 0.3;
  const SEEK_DEBOUNCE_MS = 300;

  const player = document.getElementById("player");
  const currentVideoName = document.getElementById("currentVideoName");
  const roomVideoName = document.getElementById("roomVideoName");
  const localVideoFile = document.getElementById("localVideoFile");
  const localSubtitleFile = document.getElementById("localSubtitleFile");
  const subtitleTrack = document.getElementById("subtitleTrack");
  const magnetToggle = document.getElementById("magnetToggle");
  const magnetDrawer = document.getElementById("magnetDrawer");
  const magnetInput = document.getElementById("magnetInput");
  const magnetButton = document.getElementById("magnetButton");
  const filePicker = document.getElementById("filePicker");
  const filePickerBackdrop = document.getElementById("filePickerBackdrop");
  const filePickerList = document.getElementById("filePickerList");
  const torrentPanel = document.getElementById("torrentPanel");
  const torrentToggle = document.getElementById("torrentToggle");
  const torrentHealthDot = document.getElementById("torrentHealthDot");
  const torrentHealthLabel = document.getElementById("torrentHealthLabel");
  const torrentInfoName = document.getElementById("torrentInfoName");
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

  function getServerTime(sync) {
    if (!sync.isPlaying) {
      return sync.time;
    }

    return sync.time + (Date.now() - sync.timestamp) / 1000;
  }

  function canApplyPlaybackSync() {
    return hasLocalVideo && player.readyState >= HTMLMediaElement.HAVE_METADATA;
  }

  function applySync(sync) {
    logWatchParty("receive sync", {
      sync: formatPayload(sync),
      player: getPlayerSnapshot()
    });

    if (!sync || typeof sync.time !== "number" || typeof sync.isPlaying !== "boolean") {
      logWatchParty("reject sync", {
        reason: "sync must include numeric time and boolean isPlaying",
        sync: formatPayload(sync)
      });
      return;
    }

    lastSync = sync;

    if (sync.mediaName) {
      setRoomVideo(sync.mediaName);
    }

    if (!canApplyPlaybackSync()) {
      logWatchParty("defer sync", {
        reason: "local video metadata is not ready",
        sync: formatPayload(sync),
        player: getPlayerSnapshot()
      });
      setSyncStatus(sync.mediaName ? "Choose your local copy" : "Choose local video");
      return;
    }

    const serverTime = Math.max(0, getServerTime(sync));
    const drift = Math.abs(player.currentTime - serverTime);
    const shouldSeek = drift > DRIFT_THRESHOLD_SECONDS && Number.isFinite(serverTime);

    logWatchParty("drift check", {
      localTime: roundSeconds(player.currentTime),
      serverTime: roundSeconds(serverTime),
      drift: roundSeconds(drift),
      threshold: DRIFT_THRESHOLD_SECONDS,
      shouldSeek,
      sync: formatPayload(sync)
    });

    applyingRemoteSync = true;

    if (shouldSeek) {
      logWatchParty("apply remote seek", {
        from: roundSeconds(player.currentTime),
        to: roundSeconds(Math.min(serverTime, player.duration || serverTime)),
        duration: roundSeconds(player.duration)
      });
      player.currentTime = Math.min(serverTime, player.duration || serverTime);
    }

    const playPromise = sync.isPlaying && player.paused ? player.play() : null;
    if (!sync.isPlaying) {
      logWatchParty("apply remote pause", {
        player: getPlayerSnapshot()
      });
      player.pause();
    } else if (playPromise) {
      logWatchParty("apply remote play", {
        player: getPlayerSnapshot()
      });
    }

    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch((error) => {
        logWatchParty("remote play blocked", {
          message: error && error.message,
          player: getPlayerSnapshot()
        });
        setSyncStatus("Tap play to allow synced playback");
      });
    }

    window.setTimeout(() => {
      applyingRemoteSync = false;
      logWatchParty("remote sync guard released", {
        player: getPlayerSnapshot()
      });
    }, 100);

    setSyncStatus(`Synced, drift ${drift.toFixed(2)}s`);
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

  function isVideoFile(file) {
    return VIDEO_EXTENSIONS.has(file.name.split(".").pop().toLowerCase());
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
    torrentPanel.classList.add("is-open");
    torrentToggle.setAttribute("aria-expanded", "true");
    updateTorrentPanel(torrent);
    torrentUpdateInterval = setInterval(() => updateTorrentPanel(torrent), 1000);
  }

  function stopTorrentPanel() {
    clearInterval(torrentUpdateInterval);
    torrentUpdateInterval = null;
    videoBitrate = null;
    torrentPanel.setAttribute("hidden", "");
    torrentPanel.classList.remove("is-open");
    torrentToggle.setAttribute("aria-expanded", "false");
  }

  function streamFile(file) {
    setSyncStatus("Streaming torrent...");
    applyingRemoteSync = true;
    hasLocalVideo = true;
    setCurrentVideo(file.name);

    file.renderTo(player, { autoplay: false }, (err) => {
      if (err) {
        setSyncStatus("Stream error: " + err.message);
        hasLocalVideo = false;
      }
    });

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

      const size = document.createElement("span");
      size.className = "file-picker-size";
      size.textContent = formatBytes(file.length);

      li.append(name, size);
      li.addEventListener("click", () => {
        filePicker.setAttribute("hidden", "");
        streamFile(file);
      });
      filePickerList.appendChild(li);
    });

    filePicker.removeAttribute("hidden");
  }

  function loadMagnet(magnetUri) {
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

    torrentClient.add(magnetUri.trim(), (torrent) => {
      magnetButton.disabled = false;
      magnetButton.textContent = "Stream";

      const videoFiles = torrent.files.filter(isVideoFile);

      if (videoFiles.length === 0) {
        setSyncStatus("No streamable video files in torrent");
        return;
      }

      startTorrentPanel(torrent);

      if (videoFiles.length === 1) {
        streamFile(videoFiles[0]);
        return;
      }

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

  filePickerBackdrop.addEventListener("click", () => {
    filePicker.setAttribute("hidden", "");
  });

  magnetToggle.addEventListener("click", () => {
    const nowHidden = magnetDrawer.toggleAttribute("hidden");
    if (!nowHidden) {
      magnetInput.focus();
    }
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
    logWatchParty("player waiting", {
      player: getPlayerSnapshot()
    });
    setSyncStatus("Buffering local file");
  });

  player.addEventListener("canplay", () => {
    logWatchParty("player canplay", {
      hasLastSync: Boolean(lastSync),
      player: getPlayerSnapshot()
    });
    if (lastSync) {
      applySync(lastSync);
    }
  });

  if (window.location.hash) {
    const hashValue = decodeURIComponent(window.location.hash.slice(1));
    if (hashValue.startsWith("magnet:")) {
      loadMagnet(hashValue);
    }
  }

  loadShareLink().catch(() => {});
})();
