(function () {
  const DRIFT_THRESHOLD_SECONDS = 0.3;
  const SEEK_DEBOUNCE_MS = 300;

  const player = document.getElementById("player");
  const currentVideoName = document.getElementById("currentVideoName");
  const videoSelect = document.getElementById("videoSelect");
  const shareLink = document.getElementById("shareLink");
  const connectionStatus = document.getElementById("connectionStatus");
  const syncStatus = document.getElementById("syncStatus");
  const clientsPanel = document.getElementById("clientsPanel");
  const clientsToggle = document.getElementById("clientsToggle");
  const clientCount = document.getElementById("clientCount");
  const clientList = document.getElementById("clientList");
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

  function setCurrentVideo(name) {
    currentVideoName.textContent = name || "No video selected";
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

  function updateVideoSource(timestamp) {
    applyingRemoteSync = true;
    player.pause();
    player.src = `/video?v=${timestamp || Date.now()}`;
    player.load();
    lastSync = { time: 0, isPlaying: false, timestamp: timestamp || Date.now() };
    window.setTimeout(() => {
      applyingRemoteSync = false;
    }, 100);
  }

  async function loadVideoList() {
    const response = await fetch("/videos");

    if (!response.ok) {
      throw new Error("Could not load videos");
    }

    const result = await response.json();
    videoSelect.replaceChildren();

    if (!result.files.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No videos found";
      videoSelect.appendChild(option);
      videoSelect.disabled = true;
      setCurrentVideo(null);
      return;
    }

    videoSelect.disabled = false;
    result.files.forEach((file) => {
      const option = document.createElement("option");
      option.value = file;
      option.textContent = file;
      videoSelect.appendChild(option);
    });

    videoSelect.value = result.active || result.files[0];
    setCurrentVideo(videoSelect.value);
    updateVideoSource(Date.now());
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

  async function selectVideo(name) {
    if (!name) {
      return;
    }

    setSyncStatus("Loading video...");

    const response = await fetch("/videos/active", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "Could not select video");
    }

    const result = await response.json();
    videoSelect.value = result.active;
    setCurrentVideo(result.active);
    setSyncStatus(`Loaded ${result.active}`);
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

  socket.on("clients", (clients) => {
    renderClients(Array.isArray(clients) ? clients : []);
  });

  clientsToggle.addEventListener("click", () => {
    const isOpen = clientsPanel.classList.toggle("is-open");
    clientsToggle.setAttribute("aria-expanded", String(isOpen));
  });

  socket.on("videoChanged", (payload) => {
    const name = payload && payload.name;
    const timestamp = payload && payload.timestamp;

    if (name) {
      videoSelect.value = name;
      setCurrentVideo(name);
    }

    updateVideoSource(timestamp);
    setSyncStatus("Video loaded");
  });

  videoSelect.addEventListener("change", () => {
    selectVideo(videoSelect.value).catch((error) => {
      setSyncStatus(error.message);
    });
  });

  loadVideoList().catch((error) => {
    setSyncStatus(error.message);
  });

  loadShareLink().catch(() => {});

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
