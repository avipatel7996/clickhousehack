"use client";

import { FormEvent, useEffect, useState } from "react";
import { DatasetAgentChat } from "./dataset-agent-chat";

type Dataset = { id: string; canonical_ref: string; status: string; row_count?: number | null };

export default function HomePage() {
  const [url, setUrl] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [datasetId, setDatasetId] = useState("");
  useEffect(() => { refreshDatasets(); }, []);

  async function refreshDatasets() {
    const response = await fetch("/api/imports");
    if (!response.ok) return;
    const body = await response.json() as { imports?: Dataset[] };
    const available = (body.imports ?? []).filter((item) => item.status === "published");
    setDatasets(available);
    if (!datasetId && available[0]) setDatasetId(available[0].id);
  }

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
        if (result.status === "published") { setImportStatus(`Imported ${result.row_count ?? 0} rows into ClickHouse (finished).`); await refreshDatasets(); return; }
        if (result.status === "failed") { setImportStatus(`Import failed: ${result.error_message ?? "unknown error"}`); return; }
      }
      setImportStatus("Import is still running. Open Trigger Runs for live logs.");
    }
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
      <h2>2. Choose a dataset</h2>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}><button type="button" onClick={refreshDatasets}>Refresh datasets</button><select value={datasetId} onChange={(event) => setDatasetId(event.target.value)} style={{ flex: 1, padding: 10 }}><option value="">Select an imported dataset</option>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.canonical_ref} ({dataset.row_count ?? "?"} rows)</option>)}</select></div>
    </section>
    {datasetId && <DatasetAgentChat key={datasetId} datasetId={datasetId} datasetName={datasets.find((dataset) => dataset.id === datasetId)?.canonical_ref ?? "selected dataset"} />}
    <small style={{ display: "block", marginTop: 24, color: "#64748b" }}>Forecasts are only produced when the dataset contains suitable historical outcomes and predictors. Otherwise the analyst explains what the data can support.</small>
  </main>;
}
