const SYNC_INTERVAL_MS = 2500;
globalThis.WATCH_PARTY_LOGGING = true;

const state = {
  currentTime: 0,
  isPlaying: false,
  lastUpdateTimestamp: Date.now(),
  mediaName: null
};

const clients = new Map();

function now() {
  return Date.now();
}

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

function formatState(snapshot = getProjectedState()) {
  return {
    time: roundSeconds(snapshot.time),
    isPlaying: snapshot.isPlaying,
    timestamp: snapshot.timestamp,
    mediaName: snapshot.mediaName
  };
}

function logSocket(message, details = {}) {
  if (!globalThis.WATCH_PARTY_LOGGING) {
    return;
  }

  console.log(`[socket ${new Date().toISOString()}] ${message}`, details);
}

function getDeviceName(userAgent) {
  const agent = userAgent || "";
  const isMobile = /Mobile|Android|iPhone|iPad/i.test(agent);
  const device = isMobile ? "Mobile" : "Desktop";

  if (/Edg\//.test(agent)) {
    return `Edge ${device}`;
  }

  if (/Chrome\//.test(agent)) {
    return `Chrome ${device}`;
  }

  if (/Firefox\//.test(agent)) {
    return `Firefox ${device}`;
  }

  if (/Safari\//.test(agent)) {
    return `Safari ${device}`;
  }

  return device;
}

function getClientList() {
  return Array.from(clients.values());
}

function broadcastClients(io) {
  logSocket("broadcast clients", {
    count: clients.size,
    clients: getClientList()
  });
  io.emit("clients", getClientList());
}

function getProjectedState() {
  if (!state.isPlaying) {
    return {
      time: state.currentTime,
      isPlaying: state.isPlaying,
      timestamp: state.lastUpdateTimestamp,
      mediaName: state.mediaName
    };
  }

  const elapsedSeconds = (now() - state.lastUpdateTimestamp) / 1000;
  return {
    time: state.currentTime + elapsedSeconds,
    isPlaying: state.isPlaying,
    timestamp: state.lastUpdateTimestamp,
    mediaName: state.mediaName
  };
}

function applyAction(action, payload) {
  const incoming = formatPayload(payload);

  if (!payload || typeof payload.time !== "number" || typeof payload.timestamp !== "number") {
    logSocket(`reject ${action}`, {
      reason: "payload must include numeric time and timestamp",
      payload: incoming,
      state: formatState()
    });
    return false;
  }

  if (payload.timestamp < state.lastUpdateTimestamp) {
    logSocket(`reject ${action}`, {
      reason: "stale timestamp",
      payload: incoming,
      state: formatState()
    });
    return false;
  }

  state.currentTime = Math.max(0, payload.time);
  state.isPlaying = action === "play";
  state.lastUpdateTimestamp = payload.timestamp;
  logSocket(`apply ${action}`, {
    payload: incoming,
    state: formatState({
      time: state.currentTime,
      isPlaying: state.isPlaying,
      timestamp: state.lastUpdateTimestamp,
      mediaName: state.mediaName
    })
  });
  return true;
}

function broadcastSync(io) {
  const projected = getProjectedState();
  logSocket("broadcast sync", {
    state: formatState(projected)
  });
  io.emit("sync", projected);
}

function resetPlayback(io, videoName) {
  state.currentTime = 0;
  state.isPlaying = false;
  state.lastUpdateTimestamp = now();
  logSocket("reset playback", {
    videoName,
    state: formatState({
      time: state.currentTime,
      isPlaying: state.isPlaying,
      timestamp: state.lastUpdateTimestamp,
      mediaName: state.mediaName
    })
  });
  io.emit("videoChanged", {
    name: videoName,
    timestamp: state.lastUpdateTimestamp
  });
  broadcastSync(io);
}

function broadcastSubtitle(io, subtitleName) {
  logSocket("broadcast subtitle changed", {
    subtitleName
  });
  io.emit("subtitleChanged", {
    name: subtitleName,
    timestamp: now()
  });
}

function setMedia(payload) {
  const incoming = formatPayload(payload);

  if (!payload || typeof payload.name !== "string") {
    logSocket("reject media", {
      reason: "payload must include string name",
      payload: incoming,
      state: formatState()
    });
    return false;
  }

  state.mediaName = payload.name;
  state.currentTime = 0;
  state.isPlaying = false;
  state.lastUpdateTimestamp = now();
  logSocket("apply media", {
    payload: incoming,
    state: formatState({
      time: state.currentTime,
      isPlaying: state.isPlaying,
      timestamp: state.lastUpdateTimestamp,
      mediaName: state.mediaName
    })
  });
  return true;
}

function configureSocket(io) {
  io.on("connection", (socket) => {
    const client = {
      id: socket.id,
      name: getDeviceName(socket.handshake.headers["user-agent"])
    };

    clients.set(socket.id, client);
    logSocket("client connected", {
      client,
      totalClients: clients.size,
      state: formatState()
    });

    socket.emit("sync", getProjectedState());
    socket.emit("clients", getClientList());
    broadcastClients(io);

    socket.on("play", (payload) => {
      logSocket("event play", {
        socketId: socket.id,
        payload: formatPayload(payload)
      });
      if (applyAction("play", payload)) {
        broadcastSync(io);
      }
    });

    socket.on("pause", (payload) => {
      logSocket("event pause", {
        socketId: socket.id,
        payload: formatPayload(payload)
      });
      if (applyAction("pause", payload)) {
        broadcastSync(io);
      }
    });

    socket.on("seek", (payload) => {
      const action = state.isPlaying ? "play" : "pause";
      logSocket("event seek", {
        socketId: socket.id,
        mappedAction: action,
        payload: formatPayload(payload)
      });
      if (applyAction(action, payload)) {
        broadcastSync(io);
      }
    });

    socket.on("media", (payload) => {
      logSocket("event media", {
        socketId: socket.id,
        payload: formatPayload(payload)
      });
      if (setMedia(payload)) {
        io.emit("mediaChanged", {
          name: state.mediaName,
          timestamp: state.lastUpdateTimestamp
        });
        broadcastSync(io);
      }
    });

    socket.on("disconnect", () => {
      clients.delete(socket.id);
      logSocket("client disconnected", {
        socketId: socket.id,
        totalClients: clients.size
      });
      broadcastClients(io);
    });
  });

  setInterval(() => {
    const projected = getProjectedState();
    state.currentTime = projected.time;
    state.lastUpdateTimestamp = now();
    logSocket("sync interval tick", {
      state: formatState({
        time: state.currentTime,
        isPlaying: state.isPlaying,
        timestamp: state.lastUpdateTimestamp,
        mediaName: state.mediaName
      })
    });
    broadcastSync(io);
  }, SYNC_INTERVAL_MS);
}

module.exports = {
  broadcastSubtitle,
  configureSocket,
  resetPlayback
};
