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
app.get("/tunnel", async (req, res) => {
  try {
    const response = await fetch("http://127.0.0.1:4040/api/tunnels");
    const data = await response.json();
    const tunnel = data.tunnels.find((item) => item.proto === "https");

    if (!tunnel) {
      res.status(404).json({ url: null });
      return;
    }

    res.json({ url: tunnel.public_url });
  } catch (error) {
    res.status(404).json({ url: null });
  }
});

configureSocket(io);

server.listen(PORT, () => {
  console.log(`Watch Party server running at http://localhost:${PORT}`);
});
