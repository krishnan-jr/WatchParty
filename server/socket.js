const SYNC_INTERVAL_MS = 2500;

const state = {
  currentTime: 0,
  isPlaying: false,
  lastUpdateTimestamp: Date.now()
};

const clients = new Map();

function now() {
  return Date.now();
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
  io.emit("clients", getClientList());
}

function getProjectedState() {
  if (!state.isPlaying) {
    return {
      time: state.currentTime,
      isPlaying: state.isPlaying,
      timestamp: state.lastUpdateTimestamp
    };
  }

  const elapsedSeconds = (now() - state.lastUpdateTimestamp) / 1000;
  return {
    time: state.currentTime + elapsedSeconds,
    isPlaying: state.isPlaying,
    timestamp: state.lastUpdateTimestamp
  };
}

function applyAction(action, payload) {
  if (!payload || typeof payload.time !== "number" || typeof payload.timestamp !== "number") {
    return false;
  }

  if (payload.timestamp < state.lastUpdateTimestamp) {
    return false;
  }

  state.currentTime = Math.max(0, payload.time);
  state.isPlaying = action === "play";
  state.lastUpdateTimestamp = payload.timestamp;
  return true;
}

function broadcastSync(io) {
  io.emit("sync", getProjectedState());
}

function resetPlayback(io, videoName) {
  state.currentTime = 0;
  state.isPlaying = false;
  state.lastUpdateTimestamp = now();
  io.emit("videoChanged", {
    name: videoName,
    timestamp: state.lastUpdateTimestamp
  });
  broadcastSync(io);
}

function configureSocket(io) {
  io.on("connection", (socket) => {
    clients.set(socket.id, {
      id: socket.id,
      name: getDeviceName(socket.handshake.headers["user-agent"])
    });

    socket.emit("sync", getProjectedState());
    socket.emit("clients", getClientList());
    broadcastClients(io);

    socket.on("play", (payload) => {
      if (applyAction("play", payload)) {
        broadcastSync(io);
      }
    });

    socket.on("pause", (payload) => {
      if (applyAction("pause", payload)) {
        broadcastSync(io);
      }
    });

    socket.on("seek", (payload) => {
      if (applyAction(state.isPlaying ? "play" : "pause", payload)) {
        broadcastSync(io);
      }
    });

    socket.on("disconnect", () => {
      clients.delete(socket.id);
      broadcastClients(io);
    });
  });

  setInterval(() => {
    const projected = getProjectedState();
    state.currentTime = projected.time;
    state.lastUpdateTimestamp = now();
    broadcastSync(io);
  }, SYNC_INTERVAL_MS);
}

module.exports = {
  configureSocket,
  resetPlayback
};
