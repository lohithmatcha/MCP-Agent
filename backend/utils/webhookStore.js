// backend/utils/webhookStore.js
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const EVENTS_FILE = path.join(DATA_DIR, "webhook-events.jsonl");
const ANALYSES_FILE = path.join(DATA_DIR, "webhook-analyses.jsonl");
const DEFAULT_MAX_EVENT_LINES = 2000;
const DEFAULT_MAX_ANALYSIS_LINES = 500;

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, "");
  if (!fs.existsSync(ANALYSES_FILE)) fs.writeFileSync(ANALYSES_FILE, "");
}

function appendLine(file, obj) {
  ensure();
  fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
  trimToRetention(file);
}

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function trimToRetention(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n").filter(Boolean);

    const isEvents = path.basename(file) === "webhook-events.jsonl";
    const maxLines = isEvents
      ? parsePositiveInt(process.env.WEBHOOK_EVENTS_MAX_LINES, DEFAULT_MAX_EVENT_LINES)
      : parsePositiveInt(process.env.WEBHOOK_ANALYSES_MAX_LINES, DEFAULT_MAX_ANALYSIS_LINES);

    if (lines.length <= maxLines) return;
    const trimmed = lines.slice(lines.length - maxLines).join("\n") + "\n";
    fs.writeFileSync(file, trimmed, "utf8");
  } catch {
    // keep append flow resilient
  }
}

function loadLastN(file, n) {
  ensure();
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const slice = lines.slice(Math.max(0, lines.length - n));
  const out = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // ignore malformed lines
    }
  }
  return out;
}

module.exports = {
  EVENTS_FILE,
  ANALYSES_FILE,
  appendLine,
  loadLastN,
};
