const SYNC_INTERVAL_MS = 2500;

const state = {
  currentTime: 0,
  isPlaying: false,
  lastUpdateTimestamp: Date.now()
};

function now() {
  return Date.now();
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
    socket.emit("sync", getProjectedState());

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
