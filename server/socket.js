const SYNC_INTERVAL_MS = 1000;
globalThis.WATCH_PARTY_LOGGING = process.env.DISABLE_LOGS !== true && process.env.DISABLE_LOGS !== "true";

// Authoritative-but-cooperative room state. The playback clock only advances
// while `playing` AND nobody is buffering — the moment any client stalls we
// freeze it (re-anchor) so the rest "wait for the slowest", then resume from
// the frozen point once everyone recovers.
const room = {
  position: 0, // playback seconds captured at `anchor`
  playing: false, // user-intended play state
  anchor: Date.now(), // server clock (ms) when `position` was captured
  mediaName: null
};

const clients = new Map();
const buffering = new Set();

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

// Is the room's clock actually advancing right now?
function isLive() {
  return room.playing && buffering.size === 0;
}

// Current playback position under the live/frozen rule.
function position() {
  if (!isLive()) {
    return room.position;
  }
  return room.position + (now() - room.anchor) / 1000;
}

// Capture the current position and reset the anchor. MUST be called before any
// change to `playing` or the `buffering` set so the captured position reflects
// the rate that applied up to this instant.
function reanchor() {
  room.position = Math.max(0, position());
  room.anchor = now();
}

function syncPayload() {
  return {
    position: roundSeconds(position()),
    playing: room.playing,
    waiting: buffering.size > 0,
    serverTime: now(),
    mediaName: room.mediaName
  };
}

function broadcastSync(io) {
  const payload = syncPayload();
  logSocket("broadcast sync", { payload });
  io.emit("sync", payload);
}

function applyAction(type, payload) {
  if (!payload || typeof payload.time !== "number") {
    logSocket(`reject ${type}`, { reason: "payload must include numeric time", payload: formatPayload(payload) });
    return false;
  }

  room.position = Math.max(0, payload.time);
  room.anchor = now();
  if (type === "play") {
    room.playing = true;
  } else if (type === "pause") {
    room.playing = false;
  }
  // "seek" keeps the current play/pause state, just repositions.

  logSocket(`apply ${type}`, { payload: formatPayload(payload), state: syncPayload() });
  return true;
}

function setBuffering(io, socketId, stalled) {
  const heldBefore = buffering.size > 0;
  reanchor(); // freeze position under the current rate before changing the set
  if (stalled) {
    buffering.add(socketId);
  } else {
    buffering.delete(socketId);
  }
  const heldAfter = buffering.size > 0;

  logSocket("buffering change", { socketId, stalled, buffering: buffering.size, state: syncPayload() });

  if (heldBefore !== heldAfter) {
    broadcastSync(io); // room hold state flipped — tell everyone to wait / resume
  }
}

function resetPlayback(io, videoName) {
  room.position = 0;
  room.playing = false;
  room.anchor = now();
  buffering.clear();
  logSocket("reset playback", { videoName, state: syncPayload() });
  io.emit("videoChanged", { name: videoName, timestamp: now() });
  broadcastSync(io);
}

function broadcastSubtitle(io, subtitleName) {
  logSocket("broadcast subtitle changed", { subtitleName });
  io.emit("subtitleChanged", { name: subtitleName, timestamp: now() });
}

function setMedia(payload) {
  if (!payload || typeof payload.name !== "string") {
    logSocket("reject media", { reason: "payload must include string name", payload: formatPayload(payload) });
    return false;
  }

  // Same content → a viewer (re)joined; keep the room's position so we don't
  // yank everyone back to the start. Only genuinely new media resets playback.
  if (payload.name === room.mediaName) {
    logSocket("media rejoin", { payload: formatPayload(payload), state: syncPayload() });
    return true;
  }

  room.mediaName = payload.name;
  room.position = 0;
  room.playing = false;
  room.anchor = now();
  buffering.clear();
  logSocket("apply media", { payload: formatPayload(payload), state: syncPayload() });
  return true;
}

function configureSocket(io) {
  io.on("connection", (socket) => {
    const client = {
      id: socket.id,
      name: getDeviceName(socket.handshake.headers["user-agent"])
    };

    clients.set(socket.id, client);
    logSocket("client connected", { client, totalClients: clients.size, state: syncPayload() });

    socket.emit("sync", syncPayload());
    socket.emit("clients", getClientList());
    broadcastClients(io);

    socket.on("clockPing", (payload) => {
      socket.emit("clockPong", { t0: payload && payload.t0, serverTs: now() });
    });

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
      if (applyAction("seek", payload)) {
        broadcastSync(io);
      }
    });

    socket.on("buffering", (payload) => {
      setBuffering(io, socket.id, !!(payload && payload.state));
    });

    socket.on("media", (payload) => {
      if (setMedia(payload)) {
        io.emit("mediaChanged", { name: room.mediaName, timestamp: room.anchor });
        broadcastSync(io);
      }
    });

    socket.on("disconnect", () => {
      clients.delete(socket.id);
      if (buffering.has(socket.id)) {
        // A stalled client left — unfreeze the room if it was the blocker.
        setBuffering(io, socket.id, false);
      }
      logSocket("client disconnected", { socketId: socket.id, totalClients: clients.size });
      broadcastClients(io);
    });
  });

  setInterval(() => {
    broadcastSync(io);
  }, SYNC_INTERVAL_MS);
}

module.exports = {
  broadcastSubtitle,
  configureSocket,
  resetPlayback
};
