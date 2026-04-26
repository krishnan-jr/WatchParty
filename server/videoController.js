const fs = require("fs");
const path = require("path");

const VIDEO_PATH = "./video/sample.mp4";
const CHUNK_SIZE = 1024 * 1024;

function streamVideo(req, res) {
  const videoPath = path.resolve(VIDEO_PATH);

  if (!fs.existsSync(videoPath)) {
    res.status(404).send("Video file not found. Add an MP4 at video/sample.mp4.");
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
  streamVideo
};
