const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const { getVideos, selectVideo, streamVideo } = require("./videoController");
const { configureSocket, resetPlayback } = require("./socket");

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

configureSocket(io);

server.listen(PORT, () => {
  console.log(`Watch Party server running at http://localhost:${PORT}`);
});
