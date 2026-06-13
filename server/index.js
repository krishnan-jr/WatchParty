const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const { getSubtitles, selectSubtitle, streamSubtitle } = require("./subtitleController");
const { getVideos, selectVideo, streamVideo } = require("./videoController");
const { broadcastSubtitle, configureSocket, resetPlayback } = require("./socket");

const PORT = process.env.PORT || 3000;
const CLIENT_DIR = path.join(__dirname, "..", "client");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: "100kb" }));
app.use(express.static(CLIENT_DIR));
app.get("/videos", getVideos);
app.put("/videos/active", (req, res) => selectVideo(req, res, (name) => resetPlayback(io, name)));
app.get("/video", streamVideo);
app.get("/subtitles", getSubtitles);
app.put("/subtitles/active", (req, res) =>
  selectSubtitle(req, res, (name) => broadcastSubtitle(io, name))
);
app.get("/subtitle", streamSubtitle);
app.get("/tunnel", (req, res) => {
  const url = process.env.RENDER_EXTERNAL_URL || null;
  res.status(url ? 200 : 404).json({ url });
});

configureSocket(io);

server.listen(PORT, () => {
  console.log(`Watch Party server running at http://localhost:${PORT}`);
});
