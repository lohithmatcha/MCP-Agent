// backend/controllers/githubWebhookController.js
const crypto = require("crypto");
const axios = require("axios");
const { upsertScanCache } = require("./analyzerController");
const {
  EVENTS_FILE,
  ANALYSES_FILE,
  appendLine,
  loadLastN,
} = require("../utils/webhookStore");

// -------------------------------
// In-memory + persisted stores
// -------------------------------
const MAX_EVENTS = 50;
const MAX_ANALYSES_LOAD = 200;
const MAX_HISTORY_PER_REPO = 20;
const DELIVERY_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_DELIVERY_CACHE = 2000;
const SCAN_TRIGGER_EVENTS = new Set(["push", "pull_request", "workflow_run"]);

const events = loadLastN(EVENTS_FILE, MAX_EVENTS); // ✅ load persisted events
const latestByRepo = new Map();

// keep small analysis history per repo (for trends later)
const historyByRepo = new Map();
const inflightByRepo = new Map();
const pendingByRepo = new Set();
const processedDeliveries = new Map();

// hydrate latestByRepo + history from persisted analyses
const pastAnalyses = loadLastN(ANALYSES_FILE, MAX_ANALYSES_LOAD);
for (const a of pastAnalyses) {
  if (a?.repoUrl) {
    latestByRepo.set(a.repoUrl, a);
    // Rebuild shared AI cache so /api/ai-explain works after backend restarts.
    upsertScanCache(a.repoUrl, a.riskAnalysis || [], a.overallRisk || "Low");
    const arr = historyByRepo.get(a.repoUrl) || [];
    arr.push(a);
    historyByRepo.set(a.repoUrl, arr.slice(-MAX_HISTORY_PER_REPO));
  }
}

function pushEvent(e) {
  events.unshift(e);
  if (events.length > MAX_EVENTS) events.pop();
  appendLine(EVENTS_FILE, e); // ✅ persist
}

function isMonitorAuthorized(req) {
  const expected = process.env.WEBHOOK_MONITOR_API_KEY;
  if (!expected) return true; // keep local dev simple

  const providedHeader = req.headers["x-api-key"];
  const providedQuery = req.query?.apiKey;
  const provided = (providedHeader || providedQuery || "").toString();
  return provided === expected;
}

function rememberDelivery(deliveryId) {
  if (!deliveryId) return;
  const now = Date.now();
  processedDeliveries.set(deliveryId, now);

  // TTL cleanup
  for (const [id, ts] of processedDeliveries.entries()) {
    if (now - ts > DELIVERY_DEDUP_WINDOW_MS) processedDeliveries.delete(id);
  }

  // Size cap cleanup (remove oldest)
  while (processedDeliveries.size > MAX_DELIVERY_CACHE) {
    const oldestKey = processedDeliveries.keys().next().value;
    if (!oldestKey) break;
    processedDeliveries.delete(oldestKey);
  }
}

function hasSeenDelivery(deliveryId) {
  if (!deliveryId) return false;
  const ts = processedDeliveries.get(deliveryId);
  if (!ts) return false;
  if (Date.now() - ts > DELIVERY_DEDUP_WINDOW_MS) {
    processedDeliveries.delete(deliveryId);
    return false;
  }
  return true;
}

function verifySignature(req) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) throw new Error("Missing WEBHOOK_SECRET in .env");

  const sig = req.headers["x-hub-signature-256"];
  if (!sig) return false;

  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(req.body).digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

function normalize(eventName, payload) {
  const repoUrl = payload?.repository?.html_url;
  const sender = payload?.sender?.login || null;

  if (eventName === "ping") {
    return { type: "ping", repoUrl, sender };
  }

  if (!repoUrl) {
    return { type: "unknown", repoUrl: null, sender, eventName };
  }

  if (eventName === "push") {
    const ref = payload.ref || "";
    return {
      type: "push",
      repoUrl,
      sender,
      branch: ref.replace("refs/heads/", ""),
    };
  }

  if (eventName === "pull_request") {
    const pr = payload.pull_request;
    return {
      type: "pull_request",
      repoUrl,
      sender,
      action: payload.action,
      prNumber: pr?.number,
      prTitle: pr?.title,
      base: pr?.base?.ref,
      head: pr?.head?.ref,
    };
  }

  if (eventName === "workflow_run") {
    const run = payload.workflow_run;
    return {
      type: "workflow_run",
      repoUrl,
      sender,
      action: payload.action,
      name: run?.name,
      status: run?.status,
      conclusion: run?.conclusion,
      branch: run?.head_branch,
    };
  }

  return { type: eventName, repoUrl, sender };
}

async function runPipeline(repoUrl) {
  const scan = await axios.post("http://localhost:8000/tool/github_scan", { repoUrl });
  const { deps, findings } = scan.data.output;

  const score = await axios.post("http://localhost:8000/tool/risk_score", { deps });
  const { scores, overall } = score.data.output;

  const rec = await axios.post("http://localhost:8000/tool/recommend_actions", {
    overall,
    findings,
  });
  const { actions } = rec.data.output;

  // ✅ CI/CD workflow security scan (always include)
  let cicdFindings = { workflowsScanned: 0, findings: [] };
  try {
    const wf = await axios.post("http://localhost:8000/tool/actions_security_scan", {
      repoUrl,
    });
    cicdFindings = wf.data.output;
  } catch (e) {
    cicdFindings = {
      workflowsScanned: 0,
      findings: [
        {
          severity: "LOW",
          ruleId: "ACTIONS_SCAN_UNAVAILABLE",
          workflow: "(system)",
          message: "CI/CD workflow security scan unavailable.",
          recommendation:
            "Check mcp-server tool /tool/actions_security_scan is running.",
        },
      ],
    };
  }

  return {
    success: true,
    repoUrl,
    dependencies: deps,
    riskAnalysis: scores,
    overallRisk: overall,
    recommendedActions: actions,
    cicdFindings,
    llmExplanation: null,
    updatedAt: new Date().toISOString(),
    mode: "webhook",
  };
}

function storeAnalysis(repoUrl, analysis) {
  latestByRepo.set(repoUrl, analysis);
  upsertScanCache(repoUrl, analysis?.riskAnalysis || [], analysis?.overallRisk || "Low");

  const arr = historyByRepo.get(repoUrl) || [];
  arr.push(analysis);
  historyByRepo.set(repoUrl, arr.slice(-MAX_HISTORY_PER_REPO));

  appendLine(ANALYSES_FILE, analysis);
}

function schedulePipeline(repoUrl, source = "webhook") {
  if (!repoUrl) return;

  if (inflightByRepo.has(repoUrl)) {
    // Collapse bursts: one extra rerun after current in-flight finishes.
    pendingByRepo.add(repoUrl);
    return;
  }

  const runner = (async () => {
    try {
      do {
        pendingByRepo.delete(repoUrl);
        const analysis = await runPipeline(repoUrl);
        storeAnalysis(repoUrl, analysis);
        console.log(`✅ ${source} scan updated for ${repoUrl}`);
      } while (pendingByRepo.has(repoUrl));
    } catch (err) {
      console.error(`❗ ${source} pipeline failed:`, err.message);
    } finally {
      inflightByRepo.delete(repoUrl);
    }
  })();

  inflightByRepo.set(repoUrl, runner);
}

// -----------------------------------
// POST /api/webhooks/github
// -----------------------------------
exports.githubWebhook = async (req, res) => {
  try {
    if (!verifySignature(req)) {
      return res.status(401).send("Invalid signature");
    }

    const eventName = req.headers["x-github-event"];
    const delivery = req.headers["x-github-delivery"];
    if (hasSeenDelivery(delivery)) {
      return res.status(200).json({ ok: true, deduped: true });
    }
    const payload = JSON.parse(req.body.toString("utf8"));
    rememberDelivery(delivery);

    const evt = normalize(eventName, payload);
    pushEvent({ delivery, receivedAt: Date.now(), ...evt });

    // ACK immediately
    res.status(200).json({ ok: true });

    // Run async
    if (evt.repoUrl && SCAN_TRIGGER_EVENTS.has(evt.type)) {
      schedulePipeline(evt.repoUrl, "Webhook");
    }
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: err.message });
  }
};

// -----------------------------------
// GET /api/webhooks/events
// -----------------------------------
exports.getEvents = (req, res) => {
  if (!isMonitorAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized monitor access" });
  }
  res.json({ events });
};

// -----------------------------------
// GET /api/webhooks/latest?repoUrl=...
// -----------------------------------
exports.getLatest = (req, res) => {
  if (!isMonitorAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized monitor access" });
  }
  const repoUrl = req.query.repoUrl;

  if (repoUrl) {
    const analysis = latestByRepo.get(repoUrl);
    if (!analysis) {
      return res.json({
        analysis: null,
        status: "pending",
        message:
          "No analysis yet for this repo. Trigger a webhook event or click Re-analyze now.",
      });
    }
    return res.json({ analysis });
  }

  // return latest available
  for (const e of events) {
    if (e.repoUrl && latestByRepo.has(e.repoUrl)) {
      return res.json({ analysis: latestByRepo.get(e.repoUrl) });
    }
  }

  return res.json({
    analysis: null,
    status: "pending",
    message: "No webhook analyses yet.",
  });
};

// -----------------------------------
// GET /api/webhooks/history?repoUrl=...&limit=20
// -----------------------------------
exports.getHistory = (req, res) => {
  if (!isMonitorAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized monitor access" });
  }
  const repoUrl = req.query.repoUrl;
  const limit = Math.max(1, Math.min(50, Number(req.query.limit || 20)));

  if (!repoUrl) return res.status(400).json({ error: "Missing repoUrl" });

  const arr = historyByRepo.get(repoUrl) || [];
  return res.json({ history: arr.slice(-limit) });
};

// POST /api/webhooks/reanalyze
// body: { repoUrl: "https://github.com/owner/repo" }
exports.reanalyze = async (req, res) => {
  try {
    if (!isMonitorAuthorized(req)) {
      return res.status(401).json({ error: "Unauthorized monitor access" });
    }
    const { repoUrl } = req.body || {};
    if (!repoUrl) return res.status(400).json({ error: "Missing repoUrl" });

    // respond immediately (don’t block UI)
    res.json({ ok: true, repoUrl });

    // run async pipeline (same as webhook)
    schedulePipeline(repoUrl, "Re-analyze");
  } catch (err) {
    console.error("Reanalyze error:", err);
    return res.status(500).json({ error: err.message });
  }
};
