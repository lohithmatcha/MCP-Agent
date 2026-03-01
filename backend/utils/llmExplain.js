// backend/utils/llmExplain.js
const { GoogleGenerativeAI } = require("@google/generative-ai");

const MAX_JSON_CHARS = 8000; // ~2k tokens; free tier limit ~15k/min
const MAX_RETRIES = 2;
const DEFAULT_RETRY_MS = 30000;

function safeStringify(obj, space = 2) {
  const seen = new WeakSet();
  return JSON.stringify(
    obj,
    (key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
      return value;
    },
    space
  );
}

function truncateJson(str) {
  if (str.length <= MAX_JSON_CHARS) return str;
  return str.slice(0, MAX_JSON_CHARS) + '\n... [truncated to reduce token usage]';
}

function extractRetryDelayMs(err) {
  const msg = err?.message || String(err);
  const m = msg.match(/retry\s+(?:in\s+)?(\d+(?:\.\d+)?)\s*s/i);
  if (m) return Math.ceil(parseFloat(m[1]) * 1000);
  return DEFAULT_RETRY_MS;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a focused summary for the LLM: high/medium risk packages with reasons, so it can suggest alternatives.
function buildRiskSummary(scores, recommendedActions, cicdFindings) {
  const high = (scores || []).filter((s) => s.level === "High");
  const medium = (scores || []).filter((s) => s.level === "Medium");
  const lines = [];

  if (high.length) {
    lines.push("High-risk packages (prioritize replacing or upgrading):");
    high.forEach((s) => {
      const osvInfo = (s.osv || []).slice(0, 2).map((v) => v.id + (v.summary ? ": " + v.summary.slice(0, 80) : "")).join("; ");
      lines.push(`  - ${s.package} (score ${s.score})${osvInfo ? " — " + osvInfo : ""}`);
    });
  }
  if (medium.length) {
    lines.push("Medium-risk packages (review or consider alternatives):");
    medium.forEach((s) => {
      const osvInfo = (s.osv || []).slice(0, 1).map((v) => v.id + (v.summary ? ": " + v.summary.slice(0, 60) : "")).join("");
      lines.push(`  - ${s.package} (score ${s.score})${osvInfo ? " — " + osvInfo : ""}`);
    });
  }
  if (recommendedActions && recommendedActions.length) {
    lines.push("Recommended actions from scan:");
    recommendedActions.forEach((a) => lines.push(`  - [${a.type}] ${(a.message || "").slice(0, 120)}`));
  }
  if (cicdFindings && cicdFindings.findings && cicdFindings.findings.length) {
    lines.push("CI/CD findings:");
    cicdFindings.findings.slice(0, 5).forEach((f) =>
      lines.push(`  - ${f.severity}: ${f.ruleId || ""} — ${(f.message || "").slice(0, 80)}`)
    );
  }
  return lines.join("\n");
}

// Single-response generator (stable, non-streaming)
exports.generateLLMExplanation = async (riskData, overallRisk, detail = "short", options = {}) => {
  const { recommendedActions = [], cicdFindings = null } = options;
  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("Missing GEMINI_API_KEY");
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemma-3-1b-it" });

    const riskSummary = buildRiskSummary(riskData, recommendedActions, cicdFindings);
    const rawJson = safeStringify(riskData, 2);
    const jsonData = truncateJson(rawJson);

    const prompt = `You are a security-focused developer assistant. Your goal is to help the user understand repo risk and fix it.

Use the following structured format. Use these exact section headings so the app can show them clearly.

## Summary
In 1–3 sentences, state the overall risk (${overallRisk}) and what the user should do first.

## Risky dependencies
List the main risky packages (from the data below) and briefly why each is risky (CVE, deprecated, or pattern-based). Focus on High and Medium risk entries.

## Safer alternatives
For each risky dependency you listed, suggest a concrete safer alternative (e.g. another package or upgrade path). Format as: "**PackageName** → use **Alternative** (reason)." If no good alternative exists, say "No drop-in replacement; upgrade to latest and monitor."

## Recommendations
Short, actionable steps: update packages, pin versions, fix CI/CD if mentioned, and any other quick wins.

---
Data (risk summary):
${riskSummary}

Full risk data (JSON):
${jsonData}

Overall risk level: ${overallRisk}

Respond with markdown only. Use the section headings above. No code fences around the whole response.`;

    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        return result.response.text();
      } catch (err) {
        lastErr = err;
        const is429 = /429|Too Many Requests|quota|rate.?limit/i.test(err?.message || "");
        if (is429 && attempt < MAX_RETRIES) {
          const delay = extractRetryDelayMs(err);
          console.log(`⏳ Rate limited. Retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
          await sleep(delay);
        } else {
          throw err;
        }
      }
    }
    throw lastErr;
  } catch (err) {
    console.error("❗ LLM generation failed:", err?.message || err);
    return "⚠️ AI explanation unavailable.";
  }
};
