const fs = require("fs");
const path = require("path");

const CHUNK_SIZE = 1024 * 1024;
const VIDEO_DIR = path.resolve("./video");

let activeVideoName = null;

function listVideoFiles() {
  if (!fs.existsSync(VIDEO_DIR)) {
    fs.mkdirSync(VIDEO_DIR, { recursive: true });
  }

  return fs
    .readdirSync(VIDEO_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".mp4")
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function reconcileActiveVideo(files) {
  if (activeVideoName && !files.includes(activeVideoName)) {
    activeVideoName = null;
  }

  if (!activeVideoName && files.length > 0) {
    activeVideoName = files[0];
  }
}

function getActiveVideoPath() {
  if (!activeVideoName) {
    return null;
  }

  return path.join(VIDEO_DIR, activeVideoName);
}

function getVideos(req, res) {
  const files = listVideoFiles();
  reconcileActiveVideo(files);

  res.json({
    files,
    active: activeVideoName
  });
}

function selectVideo(req, res, onVideoChanged) {
  const requestedName = req.body && req.body.name;

  if (!requestedName || typeof requestedName !== "string") {
    res.status(400).json({ error: "Video name is required." });
    return;
  }

  const safeName = path.basename(requestedName);
  const files = listVideoFiles();

  if (!files.includes(safeName)) {
    res.status(404).json({ error: "Video file was not found in the video folder." });
    return;
  }

  activeVideoName = safeName;
  onVideoChanged(activeVideoName);
  res.json({ ok: true, active: activeVideoName });
}

function streamVideo(req, res) {
  reconcileActiveVideo(listVideoFiles());
  const videoPath = getActiveVideoPath();

  if (!videoPath || !fs.existsSync(videoPath)) {
    res.status(404).send("No video selected. Add MP4 files to the video folder.");
    return;
  }

  const stat = fs.statSync(videoPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (!range) {
    res.status(416).send("Range header required");
    return;
  }

  const match = range.match(/bytes=(\d*)-(\d*)/);
  if (!match) {
    res.status(416).send("Invalid Range header");
    return;
  }

  const start = match[1] ? Number.parseInt(match[1], 10) : 0;
  const requestedEnd = match[2] ? Number.parseInt(match[2], 10) : start + CHUNK_SIZE - 1;
  const end = Math.min(requestedEnd, fileSize - 1);

  if (Number.isNaN(start) || Number.isNaN(end) || start >= fileSize || start > end) {
    res.writeHead(416, {
      "Content-Range": `bytes */${fileSize}`
    });
    res.end();
    return;
  }

  const contentLength = end - start + 1;
  const stream = fs.createReadStream(videoPath, { start, end });

  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${fileSize}`,
    "Accept-Ranges": "bytes",
    "Content-Length": contentLength,
    "Content-Type": "video/mp4"
  });

  stream.pipe(res);
}

module.exports = {
  getVideos,
  selectVideo,
  streamVideo
};
