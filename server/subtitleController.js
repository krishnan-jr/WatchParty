const fs = require("fs");
const path = require("path");

const SUBTITLE_DIR = path.resolve("./subtitles");
const SUPPORTED_EXTENSIONS = new Set([".vtt", ".srt"]);

let activeSubtitleName = null;

function ensureSubtitleDir() {
  if (!fs.existsSync(SUBTITLE_DIR)) {
    fs.mkdirSync(SUBTITLE_DIR, { recursive: true });
  }
}

function listSubtitleFiles() {
  ensureSubtitleDir();

  return fs
    .readdirSync(SUBTITLE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function reconcileActiveSubtitle(files) {
  if (activeSubtitleName && !files.includes(activeSubtitleName)) {
    activeSubtitleName = null;
  }
}

function getActiveSubtitlePath() {
  if (!activeSubtitleName) {
    return null;
  }

  return path.join(SUBTITLE_DIR, activeSubtitleName);
}

function convertSrtToVtt(content) {
  return `WEBVTT\n\n${content.replace(/\r/g, "").replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2")}`;
}

function getSubtitles(req, res) {
  const files = listSubtitleFiles();
  reconcileActiveSubtitle(files);

  res.json({
    files,
    active: activeSubtitleName
  });
}

function selectSubtitle(req, res, onSubtitleChanged) {
  const requestedName = req.body && req.body.name;

  if (requestedName === null || requestedName === "") {
    activeSubtitleName = null;
    onSubtitleChanged(activeSubtitleName);
    res.json({ ok: true, active: activeSubtitleName });
    return;
  }

  if (typeof requestedName !== "string") {
    res.status(400).json({ error: "Subtitle name is required." });
    return;
  }

  const safeName = path.basename(requestedName);
  const files = listSubtitleFiles();

  if (!files.includes(safeName)) {
    res.status(404).json({ error: "Subtitle file was not found in the subtitles folder." });
    return;
  }

  activeSubtitleName = safeName;
  onSubtitleChanged(activeSubtitleName);
  res.json({ ok: true, active: activeSubtitleName });
}

function streamSubtitle(req, res) {
  reconcileActiveSubtitle(listSubtitleFiles());

  const subtitlePath = getActiveSubtitlePath();
  if (!subtitlePath || !fs.existsSync(subtitlePath)) {
    res.status(404).send("No subtitle selected. Add VTT or SRT files to the subtitles folder.");
    return;
  }

  const content = fs.readFileSync(subtitlePath, "utf8");
  const extension = path.extname(subtitlePath).toLowerCase();
  const vttContent = extension === ".srt" ? convertSrtToVtt(content) : content;

  res.type("text/vtt").send(vttContent);
}

module.exports = {
  getSubtitles,
  selectSubtitle,
  streamSubtitle
};
