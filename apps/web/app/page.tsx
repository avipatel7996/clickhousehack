"use client";

import { FormEvent, useState } from "react";

type Message = { role: "user" | "assistant"; text: string };

export default function HomePage() {
  const [url, setUrl] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);

  async function importDataset(event: FormEvent) {
    event.preventDefault();
    setImportStatus("Validating Kaggle dataset…");
    const response = await fetch("/api/imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
    const body = await response.json();
    if (!response.ok) { setImportStatus(body.error ?? "Import failed."); return; }
    setImportStatus(`Import queued (run ${body.triggerRunId ?? "pending"}).`);
    if (body.importId) {
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const poll = await fetch(`/api/imports?id=${encodeURIComponent(body.importId)}`);
        if (!poll.ok) continue;
        const result = await poll.json();
        setImportStatus(`Import ${result.status}…`);
        if (result.status === "published") { setImportStatus(`Imported ${result.row_count ?? 0} rows into ClickHouse.`); return; }
        if (result.status === "failed") { setImportStatus("Import failed. Check Trigger Runs."); return; }
      }
      setImportStatus("Import is still running. Open Trigger Runs for live logs.");
    }
  }

  async function askQuestion(event: FormEvent) {
    event.preventDefault();
    if (!question.trim()) return;
    const current = question;
    setQuestion("");
    setMessages((items) => [...items, { role: "user", text: current }]);
    const response = await fetch("/api/analyses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: current }) });
    const body = await response.json();
    if (!response.ok || body.status === "failed") {
      setMessages((items) => [...items, { role: "assistant", text: body.warning ?? body.error ?? "Analysis could not be queued." }]);
      return;
    }
    setMessages((items) => [...items, { role: "assistant", text: "Analysis queued; waiting for the ClickHouse-backed result…" }]);
    for (let attempt = 0; attempt < 90; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const poll = await fetch(`/api/analyses?id=${encodeURIComponent(body.analysisId)}`);
      if (!poll.ok) continue;
      const result = await poll.json();
      if (result.status === "completed") {
        const answer = result.answer?.answer ?? result.answer?.result?.answer ?? "Analysis completed.";
        setMessages((items) => [...items, { role: "assistant", text: String(answer) }]);
        return;
      }
      if (result.status === "failed") {
        setMessages((items) => [...items, { role: "assistant", text: "Analysis failed; inspect the Trigger run logs." }]);
        return;
      }
    }
    setMessages((items) => [...items, { role: "assistant", text: "Analysis is still running. Open Trigger Runs for live logs." }]);
  }

  return <main style={{ maxWidth: 920, margin: "0 auto", padding: "48px 24px", fontFamily: "system-ui" }}>
    <p style={{ color: "#64748b", letterSpacing: 1 }}>KAGGLE → CLICKHOUSE · <a href="/login">Sign in</a></p>
    <h1>Ask your data, with evidence.</h1>
    <p style={{ maxWidth: 650, color: "#475569" }}>Import a public Kaggle dataset and get answers backed by executed ClickHouse queries, immutable dataset versions, and visual summaries.</p>
    <section style={{ marginTop: 32, padding: 24, border: "1px solid #e2e8f0", borderRadius: 12 }}>
      <h2>1. Import a dataset</h2>
      <form onSubmit={importDataset} style={{ display: "flex", gap: 12 }}><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.kaggle.com/datasets/owner/slug" style={{ flex: 1, padding: 12 }} /><button type="submit">Import</button></form>
      {importStatus && <p role="status">{importStatus}</p>}
    </section>
    <section style={{ marginTop: 24, padding: 24, border: "1px solid #e2e8f0", borderRadius: 12 }}>
      <h2>2. Ask a grounded question</h2>
      <form onSubmit={askQuestion} style={{ display: "flex", gap: 12 }}><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Which team has the strongest evidence?" style={{ flex: 1, padding: 12 }} /><button type="submit">Analyze</button></form>
      <div aria-live="polite">{messages.map((message, index) => <p key={index}><strong>{message.role === "user" ? "You" : "Analyst"}:</strong> {message.text}</p>)}</div>
    </section>
    <small style={{ display: "block", marginTop: 24, color: "#64748b" }}>Forecasts are only produced when the dataset contains suitable historical outcomes and predictors. Otherwise the analyst explains what the data can support.</small>
  </main>;
}
