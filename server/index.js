const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const { streamVideo } = require("./videoController");
const { configureSocket } = require("./socket");

const PORT = process.env.PORT || 3000;
const CLIENT_DIR = path.join(__dirname, "..", "client");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(CLIENT_DIR));
app.get("/video", streamVideo);

configureSocket(io);

server.listen(PORT, () => {
  console.log(`Watch Party server running at http://localhost:${PORT}`);
});
