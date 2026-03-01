import React, { useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import "./AnalysisResult.css";

const AnalysisResult = ({ data }) => {
  const [aiText, setAiText] = useState(data.llmExplanation);
  const [loading, setLoading] = useState(false);
  const [expandedIndex, setExpandedIndex] = React.useState(null);

  // OSV toggle state per-row (use a stable key instead of index to work with pagination)
  const [openOSVKey, setOpenOSVKey] = useState(null);

  // Pagination state for Dependency table
  const rowsPerPage = 10;
  const [currentPage, setCurrentPage] = useState(0);

  if (!data) return null;

  const { repoUrl, riskAnalysis, overallRisk, recommendedActions, cicdFindings } = data;

  const totalPages = Math.max(1, Math.ceil((riskAnalysis?.length || 0) / rowsPerPage));
  const startIndex = currentPage * rowsPerPage;
  const endIndex = startIndex + rowsPerPage;
  const paginatedRisk = (riskAnalysis || []).slice(startIndex, endIndex);

  const goPrev = () => {
    setCurrentPage((p) => {
      const next = Math.max(0, p - 1);
      if (next !== p) setOpenOSVKey(null);
      return next;
    });
  };

  const goNext = () => {
    setCurrentPage((p) => {
      const next = Math.min(totalPages - 1, p + 1);
      if (next !== p) setOpenOSVKey(null);
      return next;
    });
  };

  const fetchAI = async (detail = "short") => {
    try {
      setAiText("");
      setLoading(true);

      const url = `http://localhost:4000/api/ai-explain?repoUrl=${encodeURIComponent(
        repoUrl
      )}&detail=${detail}`;

      const resp = await fetch(url);
      const json = await resp.json();

      if (!resp.ok) {
        throw new Error(json?.error || "Failed to fetch AI explanation");
      }

      setAiText(json.explanation || "");
    } catch (err) {
      console.error("AI fetch error:", err);
      setAiText(`⚠️ Failed to load AI explanation: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const renderSeverity = (sev) => {
    if (typeof sev === "number") return String(sev);
    if (Array.isArray(sev)) return sev.join(", ");
    return sev || "—";
  };

  // ---- CI/CD helpers ----
  const normalizeSeverity = (s) => String(s || "LOW").toUpperCase();
  const severityClass = (s) => {
    const sev = normalizeSeverity(s);
    if (sev === "CRITICAL" || sev === "HIGH") return "cicd-sev-high";
    if (sev === "MEDIUM") return "cicd-sev-medium";
    return "cicd-sev-low";
  };

  const cicdRows = cicdFindings?.findings || [];
  const cicdScanned = cicdFindings?.workflowsScanned ?? 0;

  // Risk-at-a-glance counts
  const riskCounts = (riskAnalysis || []).reduce(
    (acc, r) => {
      const l = (r.level || "").toLowerCase();
      if (l === "high") acc.high++;
      else if (l === "medium") acc.medium++;
      else acc.low++;
      return acc;
    },
    { high: 0, medium: 0, low: 0 }
  );
  const riskSummaryLine =
    riskCounts.high > 0
      ? `${riskCounts.high} high-risk and ${riskCounts.medium} medium-risk dependencies need attention.`
      : riskCounts.medium > 0
      ? `${riskCounts.medium} medium-risk dependencies to review.`
      : "No high or medium risk dependencies detected.";

  // Parse AI response into sections for prominent "Safer alternatives" display
  const getSection = (text, heading) => {
    if (!text || typeof text !== "string") return null;
    const regex = new RegExp(`##\\s*${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*([\\s\\S]*?)(?=##|$)`, "im");
    const match = text.match(regex);
    return match ? match[1].trim() : null;
  };
  const alternativesSection = aiText ? getSection(aiText, "Safer alternatives") : null;

  return (
    <div className="analysis-page">
      <div className="analysis-container">
        <h2 className="title">📦 Repository Analysis</h2>
        <p>
          <strong>Repository:</strong>{" "}
          <a href={repoUrl} target="_blank" rel="noreferrer">
            {repoUrl}
          </a>
        </p>

        <div className={`overall-risk ${overallRisk.toLowerCase()}`}>
          <strong>Overall Risk:</strong> {overallRisk}
        </div>

        {/* Risk at a glance */}
        <div className="risk-at-a-glance">
          <div className="risk-counts">
            <span className="risk-badge high">{riskCounts.high} High</span>
            <span className="risk-badge medium">{riskCounts.medium} Medium</span>
            <span className="risk-badge low">{riskCounts.low} Low</span>
          </div>
          <p className="risk-summary-line">{riskSummaryLine}</p>
        </div>

        <h3 className="section-title">🧩 Dependency Risk Breakdown</h3>

        <div className="risk-table-wrapper">
          <table className="risk-table">
            <thead>
              <tr>
                <th>Package</th>
                <th>Risk Level</th>
                <th>Score</th>
                <th>OSV</th>
              </tr>
            </thead>
            <tbody>
              {paginatedRisk.map((pkg, i) => {
                const absoluteIndex = startIndex + i;
                const hasOSV = pkg.osv && pkg.osv.length > 0;
                const first = hasOSV ? pkg.osv[0] : null;
                const rest = hasOSV && pkg.osv.length > 1 ? pkg.osv.slice(1) : [];
                const rowKey = `${pkg.package || "pkg"}|${absoluteIndex}`;
                const isOpen = openOSVKey === rowKey;

                return (
                  <tr key={rowKey}>
                    <td>{pkg.package}</td>
                    <td className={pkg.level.toLowerCase()}>{pkg.level}</td>
                    <td>{pkg.score}</td>
                    <td className="osv-cell">
                      {!hasOSV && <span className="osv-empty">—</span>}

                      {hasOSV && (
                        <>
                          <div className="osv-line">
                            <span className="osv-main">
                              <a href={first.url} target="_blank" rel="noreferrer">
                                {first.id}
                              </a>
                              {first.summary ? ` — ${first.summary}` : ""}
                              {first.severity != null
                                ? ` (severity: ${renderSeverity(first.severity)})`
                                : ""}
                            </span>

                            {rest.length > 0 && (
                              <button
                                type="button"
                                className={`osv-toggle ${isOpen ? "open" : ""}`}
                                aria-expanded={isOpen}
                                onClick={() => setOpenOSVKey(isOpen ? null : rowKey)}
                                title={
                                  isOpen ? "Hide other OSV entries" : "Show other OSV entries"
                                }
                              >
                                {isOpen ? "▴" : "▾"}
                              </button>
                            )}
                          </div>

                          {rest.length > 0 && isOpen && (
                            <ul className="osv-list">
                              {rest.map((v, j) => (
                                <li key={j}>
                                  <a href={v.url} target="_blank" rel="noreferrer">
                                    {v.id}
                                  </a>
                                  {v.summary ? ` — ${v.summary}` : ""}
                                  {v.severity != null
                                    ? ` (severity: ${renderSeverity(v.severity)})`
                                    : ""}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div className="table-pagination">
              <button
                type="button"
                className="page-btn"
                onClick={goPrev}
                disabled={currentPage === 0}
              >
                ◀ Prev
              </button>
              <span className="page-status">
                Page {currentPage + 1} of {totalPages}
              </span>
              <button
                type="button"
                className="page-btn"
                onClick={goNext}
                disabled={currentPage >= totalPages - 1}
              >
                Next ▶
              </button>
            </div>
          )}
        </div>

        {/* Recommended Actions */}
        <h3 className="section-title">🚨 Recommended Actions</h3>

        <div className="actions-list">
          {(recommendedActions || []).length === 0 && <p>✅ No critical actions required.</p>}

          {(recommendedActions || []).map((a, i) => {
            const isAlert = a.type === "ALERT";
            const isBlock = a.type === "BLOCK_PR";
            const isComment = a.type === "COMMENT";
            const shortMessage =
              a.message.length > 300 ? a.message.substring(0, 300) + "..." : a.message;

            const isExpanded = expandedIndex === i;

            return (
              <div
                key={i}
                className={`action-card ${
                  isAlert ? "alert" : isBlock ? "block" : isComment ? "comment" : ""
                }`}
              >
                <div className="action-header">
                  {isAlert && (
                    <span>
                      ⚠️ <strong>Alert:</strong>
                    </span>
                  )}
                  {isBlock && (
                    <span>
                      ⛔ <strong>Block PR:</strong>
                    </span>
                  )}
                  {isComment && (
                    <span>
                      💬 <strong>Comment:</strong>
                    </span>
                  )}
                  {!isAlert && !isBlock && !isComment && (
                    <span>
                      ✅ <strong>{a.type}:</strong>
                    </span>
                  )}
                </div>

                <div className="action-body">
                  <pre className="action-text">{isExpanded ? a.message : shortMessage}</pre>
                  {a.message.length > 300 && (
                    <button
                      onClick={() => setExpandedIndex(isExpanded ? null : i)}
                      className="show-more-btn"
                    >
                      {isExpanded ? "Show Less ▲" : "Show More ▼"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* ✅ CI/CD Workflow Security */}
        <h3 className="section-title">🛠 CI/CD Workflow Security</h3>

        <div className="cicd-box">
          <p style={{ marginTop: 0 }}>
            <strong>Workflows scanned:</strong> {cicdScanned}
          </p>

          {cicdRows.length === 0 ? (
            <p>✅ No risky GitHub Actions workflow patterns detected.</p>
          ) : (
            <div className="cicd-list">
              {cicdRows.map((f, idx) => (
                <div key={idx} className="cicd-card">
                  <div className="cicd-top">
                    <span className={`cicd-sev ${severityClass(f.severity)}`}>
                      {normalizeSeverity(f.severity)}
                    </span>
                    <span className="cicd-rule">{f.ruleId || "RULE"}</span>
                    <span className="cicd-workflow">{f.workflow || "(workflow)"}</span>
                  </div>

                  <div className="cicd-msg">{f.message}</div>

                  {f.recommendation && (
                    <div className="cicd-rec">
                      <strong>Fix:</strong> {f.recommendation}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* AI Explanation & Safer Alternatives */}
        <h3 className="section-title">🧠 AI Explanation & Safer Alternatives</h3>
        <p className="ai-section-desc">
          Get a plain-language summary, which dependencies are risky and why, and <strong>concrete safer alternatives</strong> for your repo.
        </p>
        <div className="ai-controls">
          <button onClick={() => fetchAI("short")} disabled={loading}>
            {loading ? "Generating… (may take 15–30s)…" : "📋 Summary & alternatives"}
          </button>
          <button onClick={() => fetchAI("detailed")} disabled={loading}>
            {loading ? "Generating…" : "🧩 Detailed explanation"}
          </button>
        </div>

        {alternativesSection && (
          <div className="alternatives-highlight">
            <h4 className="alternatives-title">🔄 Safer alternatives</h4>
            <div
              className="alternatives-body markdown"
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(marked.parse(alternativesSection)),
              }}
            />
          </div>
        )}

        <div className="explanation">
          <div className="markdown">
            {loading && !aiText ? (
              <p className="ai-loading">⏳ Generating summary and alternatives…</p>
            ) : aiText ? (
              <div
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(marked.parse(aiText)),
                }}
              />
            ) : (
              <p className="ai-empty">Click <strong>Summary & alternatives</strong> above to see risk summary and suggested package replacements.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AnalysisResult;
