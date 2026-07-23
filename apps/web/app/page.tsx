"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { DatasetAgentChat } from "./dataset-agent-chat";

type Dataset = { id: string; canonical_ref: string; status: string; row_count?: number | null };
type ActiveImport = { importId: string; triggerRunId?: string; triggerAccessToken?: string };

function formatBytes(value?: number) {
  if (!value) return "";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function ImportProgress({ active, onComplete }: { active: ActiveImport; onComplete: () => void }) {
  const { run, error } = useRealtimeRun(active.triggerRunId, {
    accessToken: active.triggerAccessToken,
    enabled: Boolean(active.triggerRunId && active.triggerAccessToken),
    skipColumns: ["payload", "output"],
    onComplete,
  });
  const progress = run?.metadata?.import as { stage?: string; message?: string; completedFiles?: number; totalFiles?: number; completedBytes?: number; totalBytes?: number; events?: Array<{ at: string; stage: string; message: string }> } | undefined;
  const percent = progress?.totalFiles ? Math.round(((progress.completedFiles ?? 0) / progress.totalFiles) * 100) : undefined;
  return <div role="status" style={{ marginTop: 12, padding: 12, borderRadius: 8, background: "#f8fafc", color: "#334155" }}>
    <strong>{progress?.stage ?? run?.status?.toLowerCase() ?? "queued"}</strong>{progress?.message ? ` · ${progress.message}` : " · Waiting for a worker"}
    {progress?.totalFiles ? <><br /><small>{progress.completedFiles ?? 0}/{progress.totalFiles} files{progress.totalBytes ? ` · ${formatBytes(progress.completedBytes)} / ${formatBytes(progress.totalBytes)}` : ""}</small><progress style={{ display: "block", width: "100%", marginTop: 8 }} value={percent ?? undefined} max={100} /></> : null}
    {progress?.events?.length ? <details style={{ marginTop: 8 }}><summary>Import events</summary><ol style={{ margin: "8px 0 0", paddingLeft: 20 }}>{progress.events.map((event, index) => <li key={`${event.at}-${index}`}><small>{new Date(event.at).toLocaleTimeString()} · {event.stage} · {event.message}</small></li>)}</ol></details> : null}
    {error ? <><br /><small>Live progress disconnected: {error.message}. The final result is still saved.</small></> : null}
  </div>;
}

export default function HomePage() {
  const [url, setUrl] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [activeImport, setActiveImport] = useState<ActiveImport | null>(null);
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
      setActiveImport({ importId: body.importId, triggerRunId: body.triggerRunId, triggerAccessToken: body.triggerAccessToken });
    }
  }

  async function finishImport() {
    if (!activeImport) return;
    const response = await fetch(`/api/imports?id=${encodeURIComponent(activeImport.importId)}`);
    const result = await response.json().catch(() => ({}));
    if (response.ok && result.status === "published") {
      setImportStatus(`Imported ${result.row_count ?? 0} rows into ClickHouse (finished).`);
      await refreshDatasets();
    } else if (result.status === "failed") {
      setImportStatus(`Import failed: ${result.error_message ?? "unknown error"}`);
    } else {
      setImportStatus(`Import ${result.status ?? "finished"}. Refresh to view the latest saved state.`);
    }
    setActiveImport(null);
  }

  return <main style={{ maxWidth: 920, margin: "0 auto", padding: "48px 24px", fontFamily: "system-ui" }}>
    <p style={{ color: "#64748b", letterSpacing: 1 }}>KAGGLE → CLICKHOUSE · <a href="/login">Sign in</a></p>
    <h1>Ask your data, with evidence.</h1>
    <p style={{ maxWidth: 650, color: "#475569" }}>Import a public Kaggle dataset and get answers backed by executed ClickHouse queries, immutable dataset versions, and visual summaries.</p>
    <section style={{ marginTop: 32, padding: 24, border: "1px solid #e2e8f0", borderRadius: 12 }}>
      <h2>1. Import a dataset</h2>
      <form onSubmit={importDataset} style={{ display: "flex", gap: 12 }}><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.kaggle.com/datasets/owner/slug" style={{ flex: 1, padding: 12 }} /><button type="submit">Import</button></form>
      {importStatus && <p role="status">{importStatus}</p>}
      {activeImport && <ImportProgress active={activeImport} onComplete={finishImport} />}
    </section>
    <section style={{ marginTop: 24, padding: 24, border: "1px solid #e2e8f0", borderRadius: 12 }}>
      <h2>2. Choose a dataset</h2>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}><button type="button" onClick={refreshDatasets}>Refresh datasets</button><select value={datasetId} onChange={(event) => setDatasetId(event.target.value)} style={{ flex: 1, padding: 10 }}><option value="">Select an imported dataset</option>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.canonical_ref} ({dataset.row_count ?? "?"} rows)</option>)}</select></div>
    </section>
    {datasetId && <DatasetAgentChat key={datasetId} datasetId={datasetId} datasetName={datasets.find((dataset) => dataset.id === datasetId)?.canonical_ref ?? "selected dataset"} />}
    <small style={{ display: "block", marginTop: 24, color: "#64748b" }}>Forecasts are only produced when the dataset contains suitable historical outcomes and predictors. Otherwise the analyst explains what the data can support.</small>
  </main>;
}
