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

  async function loadShareLink() {
    const response = await fetch("/tunnel");

    if (!response.ok) {
      return;
    }

    const result = await response.json();
    if (!result.url) {
      return;
    }

    shareLink.href = result.url;
    shareLink.classList.add("is-visible");
  }

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

  localVideoFile.addEventListener("change", () => {
    const file = localVideoFile.files && localVideoFile.files[0];
    if (!file) {
      return;
    }

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

  loadShareLink().catch(() => {});
})();
