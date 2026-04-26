(function () {
  const DRIFT_THRESHOLD_SECONDS = 0.3;
  const SEEK_DEBOUNCE_MS = 300;

  const player = document.getElementById("player");
  const connectionStatus = document.getElementById("connectionStatus");
  const syncStatus = document.getElementById("syncStatus");
  const socket = io();

  let applyingRemoteSync = false;
  let lastSync = null;
  let seekTimer = null;

  function setConnectionStatus(message) {
    connectionStatus.textContent = message;
    connectionStatus.dataset.state = message.toLowerCase();
  }

  function setSyncStatus(message) {
    syncStatus.textContent = message;
  }

  function emitAction(eventName) {
    if (applyingRemoteSync) {
      return;
    }

    socket.emit(eventName, {
      time: player.currentTime,
      timestamp: Date.now()
    });
  }

  function getServerTime(sync) {
    if (!sync.isPlaying) {
      return sync.time;
    }

    return sync.time + (Date.now() - sync.timestamp) / 1000;
  }

  function applySync(sync) {
    if (!sync || typeof sync.time !== "number" || typeof sync.isPlaying !== "boolean") {
      return;
    }

    lastSync = sync;
    const serverTime = Math.max(0, getServerTime(sync));
    const drift = Math.abs(player.currentTime - serverTime);

    applyingRemoteSync = true;

    if (drift > DRIFT_THRESHOLD_SECONDS && Number.isFinite(serverTime)) {
      player.currentTime = serverTime;
    }

    const playPromise = sync.isPlaying && player.paused ? player.play() : null;
    if (!sync.isPlaying) {
      player.pause();
    }

    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {
        setSyncStatus("Click play to allow synced playback");
      });
    }

    window.setTimeout(() => {
      applyingRemoteSync = false;
    }, 100);

    setSyncStatus(`Synced, drift ${drift.toFixed(2)}s`);
  }

  socket.on("connect", () => {
    setConnectionStatus("Connected");
    if (lastSync) {
      applySync(lastSync);
    }
  });

  socket.on("disconnect", () => {
    setConnectionStatus("Disconnected");
  });

  socket.io.on("reconnect", () => {
    setConnectionStatus("Reconnected");
  });

  socket.on("sync", applySync);

  player.addEventListener("play", () => {
    emitAction("play");
  });

  player.addEventListener("pause", () => {
    emitAction("pause");
  });

  player.addEventListener("seeked", () => {
    if (applyingRemoteSync) {
      return;
    }

    window.clearTimeout(seekTimer);
    seekTimer = window.setTimeout(() => {
      emitAction("seek");
    }, SEEK_DEBOUNCE_MS);
  });

  player.addEventListener("waiting", () => {
    if (lastSync) {
      window.setTimeout(() => applySync(lastSync), 250);
    }
  });
})();
