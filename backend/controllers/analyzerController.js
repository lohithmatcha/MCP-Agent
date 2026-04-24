// backend/controllers/analyzerController.js
const axios = require("axios");
const { generateLLMExplanation } = require("../utils/llmExplain");

const scanCache = new Map();

function upsertScanCache(repoUrl, scores, overall) {
  if (!repoUrl) return;
  const prev = scanCache.get(repoUrl) || {};
  scanCache.set(repoUrl, { ...prev, scores, overall });
}

exports.analyzePackage = async (req, res) => {
  try {
    const { repoUrl } = req.body;
    if (!repoUrl)
      return res.status(400).json({ error: 'Expected "repoUrl" in request body.' });

    // Step 1 – GitHub scan
    const scan = await axios.post("http://localhost:8000/tool/github_scan", { repoUrl });
    const { deps, findings } = scan.data.output;

    // Step 2 – Risk scoring
    const score = await axios.post("http://localhost:8000/tool/risk_score", { deps });
    const { scores, overall } = score.data.output;

    // Step 3 – Governance actions
    const rec = await axios.post("http://localhost:8000/tool/recommend_actions", {
      overall,
      findings,
    });
    const { actions } = rec.data.output;

    // ✅ Step 4 – CI/CD workflow security scan (new)
    let cicdFindings = { workflowsScanned: 0, findings: [] };
    try {
      const wf = await axios.post("http://localhost:8000/tool/actions_security_scan", { repoUrl });
      cicdFindings = wf.data.output; // { workflowsScanned, findings }
    } catch (e) {
      // don't fail the whole analysis if CI/CD tool fails
      cicdFindings = {
        workflowsScanned: 0,
        findings: [
          {
            severity: "LOW",
            ruleId: "ACTIONS_SCAN_UNAVAILABLE",
            workflow: "(system)",
            message: "CI/CD workflow security scan unavailable.",
            recommendation: "Check mcp-server tool /tool/actions_security_scan is running.",
          },
        ],
      };
    }

    // cache for AI endpoint
    upsertScanCache(repoUrl, scores, overall);

    // ✅ respond once
    res.json({
      success: true,
      repoUrl,
      dependencies: deps,
      riskAnalysis: scores,
      overallRisk: overall,
      recommendedActions: actions,
      cicdFindings, // ✅ NEW FIELD
      llmExplanation: null,
    });

    // background LLM generation (optional; skip if already cached)
    const cached = scanCache.get(repoUrl) || {};
    if (!cached.shortAI) {
      generateLLMExplanation(scores, overall, "short").then((text) => {
        const prev = scanCache.get(repoUrl) || {};
        scanCache.set(repoUrl, { ...prev, shortAI: text });
        console.log(`🧠 Cached LLM summary for ${repoUrl}`);
      });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};

exports.getAIExplanation = async (req, res) => {
  try {
    const { repoUrl, detail } = req.query;
    if (!repoUrl) return res.status(400).json({ error: "Missing repoUrl" });

    const analysis = scanCache.get(repoUrl);
    if (!analysis) return res.status(404).json({ error: "No previous scan found" });

    const d = detail || "short";
    const cacheKey = d === "detailed" ? "detailedAI" : "shortAI";
    if (analysis[cacheKey]) {
      return res.json({ explanation: analysis[cacheKey] });
    }

    const text = await generateLLMExplanation(analysis.scores, analysis.overall, d);
    const prev = scanCache.get(repoUrl) || {};
    scanCache.set(repoUrl, { ...prev, [cacheKey]: text });

    return res.json({ explanation: text });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};

exports.getCachedScan = () => scanCache;
exports.upsertScanCache = upsertScanCache;
