import React, { useEffect, useMemo, useState } from "react";
import AnalysisResult from "./AnalysisResult";

const WebhookMonitor = () => {
  const [events, setEvents] = useState([]);
  const [selectedRepo, setSelectedRepo] = useState("");
  const [repoInput, setRepoInput] = useState("");
  const [latest, setLatest] = useState(null);
  const [loadingLatest, setLoadingLatest] = useState(false);

  // NEW: reanalyze button state
  const [reanalyzing, setReanalyzing] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  // poll events
  useEffect(() => {
    let alive = true;

    const fetchEvents = async () => {
      try {
        const r = await fetch("http://localhost:4000/api/webhooks/events");
        const j = await r.json();
        if (!alive) return;
        setEvents(j.events || []);
      } catch (e) {
        console.error("Events fetch failed:", e);
      }
    };

    fetchEvents();
    const t = setInterval(fetchEvents, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // unique repos from newest-first events list
  const reposFromEvents = useMemo(() => {
    const seen = new Set();
    const list = [];
    for (const e of events) {
      if (e.repoUrl && !seen.has(e.repoUrl)) {
        seen.add(e.repoUrl);
        list.push(e.repoUrl);
      }
    }
    return list;
  }, [events]);

  // Keep selected repo visible in dropdown even if it wasn't from events
  const repos = useMemo(() => {
    if (!selectedRepo) return reposFromEvents;
    return reposFromEvents.includes(selectedRepo)
      ? reposFromEvents
      : [selectedRepo, ...reposFromEvents];
  }, [reposFromEvents, selectedRepo]);

  // poll latest analysis for selected repo
  useEffect(() => {
    if (!selectedRepo) return;
    let alive = true;

    const fetchLatest = async () => {
      try {
        setLoadingLatest(true);
        const url =
          "http://localhost:4000/api/webhooks/latest?repoUrl=" +
          encodeURIComponent(selectedRepo);

        const r = await fetch(url);
        const j = await r.json();

        if (!alive) return;
        if (!r.ok) setLatest(null);
        else setLatest(j.analysis);
      } catch (e) {
        console.error("Latest fetch failed:", e);
        setLatest(null);
      } finally {
        if (alive) setLoadingLatest(false);
      }
    };

    fetchLatest();
    const t = setInterval(fetchLatest, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [selectedRepo]);

  // Filter event list by the selected repo so UI stays consistent.
  const displayedEvents = useMemo(() => {
    if (!selectedRepo) return events;
    return events.filter((e) => e.repoUrl === selectedRepo);
  }, [events, selectedRepo]);

  // ✅ NEW: trigger re-analysis manually
  const reanalyzeNow = async () => {
    if (!selectedRepo) return;

    try {
      setReanalyzing(true);
      setStatusMsg("🔁 Re-analysis triggered… waiting for update");

      const r = await fetch("http://localhost:4000/api/webhooks/reanalyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: selectedRepo }),
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || "Failed to trigger re-analysis");

      // just a small UX touch—polling will update latest automatically
      setTimeout(() => setStatusMsg(""), 4000);
    } catch (e) {
      console.error("Reanalyze failed:", e);
      setStatusMsg(`⚠️ Re-analysis failed: ${e.message}`);
    } finally {
      setReanalyzing(false);
    }
  };

  const useTypedRepo = () => {
    const typed = repoInput.trim();
    if (!typed) return;
    setSelectedRepo(typed);
  };

  return (
    <div style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0 }}>🔔 Webhook Mode (Real-time)</h2>

      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <label>
          <strong>Repo:</strong>
        </label>

        <select
          value={selectedRepo}
          onChange={(e) => setSelectedRepo(e.target.value)}
          style={{ padding: 6, minWidth: 420 }}
        >
          <option value="">Select repo</option>
          {repos.length === 0 && <option value="" disabled>No repos from events yet</option>}
          {repos.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        <input
          value={repoInput}
          onChange={(e) => setRepoInput(e.target.value)}
          placeholder="or paste repo URL (https://github.com/owner/repo)"
          style={{ padding: 6, minWidth: 360 }}
        />
        <button
          onClick={useTypedRepo}
          disabled={!repoInput.trim()}
          style={{ padding: "6px 10px", cursor: "pointer" }}
          title="Use the typed repo URL in webhook mode"
        >
          Use repo URL
        </button>

        {/* ✅ NEW BUTTON */}
        <button
          onClick={reanalyzeNow}
          disabled={!selectedRepo || reanalyzing}
          style={{ padding: "6px 10px", cursor: "pointer" }}
          title="Trigger analysis now (does not require a GitHub event)"
        >
          {reanalyzing ? "Re-analyzing..." : "🔁 Re-analyze now"}
        </button>

        <span style={{ opacity: 0.7 }}>
          {loadingLatest ? "Refreshing..." : "Live"}
        </span>

        {statusMsg && (
          <span style={{ opacity: 0.85, marginLeft: 8 }}>{statusMsg}</span>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", gap: 16 }}>
        {/* events feed */}
        <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
          <h3 style={{ marginTop: 0 }}>Recent Events</h3>
          <div style={{ maxHeight: 520, overflow: "auto" }}>
            {displayedEvents.length === 0 && (
              <p>
                {selectedRepo
                  ? "No events yet for this repo. Trigger a push/PR/workflow."
                  : "No events yet. Trigger a push/PR/workflow."}
              </p>
            )}

            {displayedEvents.map((e, idx) => (
              <div
                key={e.delivery || `${e.type}-${e.receivedAt}-${idx}`}
                style={{ padding: "8px 0", borderBottom: "1px solid #eee" }}
              >
                <div>
                  <strong>{e.type}</strong> {e.action ? `(${e.action})` : ""}
                </div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  {e.repoUrl || "—"}
                </div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  {new Date(e.receivedAt).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* latest analysis */}
        <div>
          <h3 style={{ marginTop: 0 }}>Latest Analysis</h3>
          {!selectedRepo && null}
          {selectedRepo && !latest && (
            <p>
              Waiting for analysis… trigger an event (push/PR/workflow) OR click
              “Re-analyze now”.
            </p>
          )}
          {latest && <AnalysisResult data={latest} />}
        </div>
      </div>
    </div>
  );
};

export default WebhookMonitor;
