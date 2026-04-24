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

// Single-response generator (stable, non-streaming)
exports.generateLLMExplanation = async (riskData, overallRisk, detail = "short") => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("Missing GEMINI_API_KEY");
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemma-3-1b-it" });

    // Use only High and Medium risks so we never truncate important ones; add counts so user knows scope
    const allRisks = Array.isArray(riskData) ? riskData : [];
    const mainRisks = allRisks.filter((r) => r && (r.level === "High" || r.level === "Medium"));
    const totalScanned = allRisks.length;
    const highCount = allRisks.filter((r) => r && r.level === "High").length;
    const mediumCount = allRisks.filter((r) => r && r.level === "Medium").length;
    const lowCount = totalScanned - highCount - mediumCount;

    if (mainRisks.length === 0) {
      return `## Summary\nWe scanned ${totalScanned} dependencies. **These are the main risks:** none. All ${totalScanned} are Low risk; no High or Medium issues were found. No further action required for dependencies.`;
    }

    const rawJson = safeStringify(mainRisks, 2);
    const jsonData = truncateJson(rawJson);
    const prompt = `You are a security analyst. Write a markdown report for the dependency risks below.

SCOPE (you must make this clear to the user):
- We scanned ${totalScanned} dependencies in total. Overall risk level: ${overallRisk}.
- The list below contains ALL main risks: ${highCount} High and ${mediumCount} Medium (every one is included). ${lowCount} Low-risk dependencies were checked but are not listed.
- In the Summary, say explicitly: "These are the main risks" and state how many High/Medium are listed so the user knows they see all of them.

RULES:
- Use markdown: ## for main headers, ### for each risk, - for bullets. No code fences.
- Include every package in the data below — each must get an explanation and an alternative/recommendation.

STRUCTURE (use these section headers):

## Summary
State overall risk (${overallRisk}) and: "We scanned ${totalScanned} dependencies. These are the main risks: ${highCount} High and ${mediumCount} Medium (all listed below). Low-risk dependencies are not shown."

## Main risks — explanation and alternatives
For each package in the data, use this format (do not skip any):

### Package name (Level)
- **Why it's risky:** Short explanation (use OSV/vuln info from the data if present; otherwise heuristic/deprecated/unpinned).
- **Alternative or recommendation:** What to do instead (e.g. pin version, replace package, run npm audit, remove if unused).

Raw data for all ${mainRisks.length} main risks (package, score, level, optional osv vulns):
${jsonData}

Output only the markdown report, no preamble.`;
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
