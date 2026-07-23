"use client";

import { FormEvent, useMemo, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import { mintDatasetChatToken, startDatasetChat } from "./actions";

type Scalar = string | number | boolean | null;
type Insight = {
  title: string;
  summary: string;
  cards?: Array<{ label: string; value: string; detail?: string }>;
  table?: { columns: string[]; rows: Array<Record<string, Scalar>> };
  chart?: { type: "bar" | "line" | "none"; x?: string; y?: string; data: Array<Record<string, Scalar>> };
  caveat?: string;
};

function insightFromPart(part: any): Insight | null {
  if (part?.type !== "tool-present_insight") return null;
  const value = part.output ?? part.result ?? part.input;
  return value && typeof value.title === "string" && typeof value.summary === "string" ? value as Insight : null;
}

function InsightView({ insight }: { insight: Insight }) {
  const chart = insight.chart;
  const max = chart?.y ? Math.max(1, ...chart.data.map((row) => Number(row[chart.y!] ?? 0)).filter(Number.isFinite)) : 1;
  return <article style={{ marginTop: 10, padding: 16, border: "1px solid #cbd5e1", borderRadius: 12, background: "#f8fafc" }}>
    <h3 style={{ margin: 0 }}>{insight.title}</h3>
    <p>{insight.summary}</p>
    {insight.cards?.length ? <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>{insight.cards.map((card, index) => <div key={index} style={{ background: "white", borderRadius: 8, padding: 12, border: "1px solid #e2e8f0" }}><small>{card.label}</small><strong style={{ display: "block", fontSize: 20 }}>{card.value}</strong>{card.detail && <small>{card.detail}</small>}</div>)}</div> : null}
    {insight.table?.rows?.length ? <div style={{ overflowX: "auto", marginTop: 12 }}><table style={{ borderCollapse: "collapse", width: "100%" }}><thead><tr>{insight.table.columns.map((column) => <th key={column} style={{ textAlign: "left", borderBottom: "1px solid #cbd5e1", padding: 8 }}>{column}</th>)}</tr></thead><tbody>{insight.table.rows.map((row, rowIndex) => <tr key={rowIndex}>{insight.table!.columns.map((column) => <td key={column} style={{ borderBottom: "1px solid #e2e8f0", padding: 8 }}>{String(row[column] ?? "—")}</td>)}</tr>)}</tbody></table></div> : null}
    {chart?.type && chart.type !== "none" && chart.data.length && chart.x && chart.y ? <div style={{ display: "grid", gap: 8, marginTop: 14 }}>{chart.data.map((row, index) => { const value = Number(row[chart.y!] ?? 0); return <div key={index} style={{ display: "grid", gridTemplateColumns: "minmax(90px, 1fr) 3fr auto", gap: 8, alignItems: "center" }}><small style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(row[chart.x!] ?? "—")}</small><div style={{ height: 10, borderRadius: 99, background: "#e2e8f0", overflow: "hidden" }}><div style={{ width: `${Math.max(0, Math.min(100, (value / max) * 100))}%`, height: "100%", background: "linear-gradient(90deg,#2563eb,#7c3aed)" }} /></div><small>{String(row[chart.y!] ?? "—")}</small></div>; })}</div> : null}
    {insight.caveat && <small style={{ color: "#64748b" }}>{insight.caveat}</small>}
  </article>;
}

function WorkTrace({ parts }: { parts: any[] }) {
  const steps = parts.filter((part) => part.type === "tool-inspect_dataset" || part.type === "tool-search_records" || part.type === "tool-query_clickhouse");
  if (!steps.length) return null;
  return <details style={{ marginTop: 10, border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 12px", background: "white" }}>
    <summary style={{ cursor: "pointer", fontWeight: 600 }}>Show work · {steps.length} ClickHouse step{steps.length === 1 ? "" : "s"}</summary>
    {steps.map((step, index) => {
      const output = step.output ?? step.result;
      return <div key={index} style={{ marginTop: 12, paddingTop: 12, borderTop: index ? "1px solid #e2e8f0" : undefined }}><strong>{index + 1}. {step.type.replace("tool-", "").replaceAll("_", " ")}</strong>{step.input && <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, color: "#475569" }}>{JSON.stringify(step.input, null, 2)}</pre>}{output?.sql && <pre style={{ whiteSpace: "pre-wrap", overflowX: "auto", fontSize: 12, background: "#0f172a", color: "#e2e8f0", padding: 10, borderRadius: 6 }}>{output.sql}</pre>}{typeof output?.rowCount === "number" && <small>Returned {output.rowCount} row{output.rowCount === 1 ? "" : "s"}</small>}{output?.rows?.length ? <pre style={{ whiteSpace: "pre-wrap", overflowX: "auto", fontSize: 11 }}>{JSON.stringify(output.rows.slice(0, 5), null, 2)}</pre> : null}</div>;
    })}
  </details>;
}

export function DatasetAgentChat({ datasetId, datasetName }: { datasetId: string; datasetName: string }) {
  const [chatId] = useState(() => crypto.randomUUID());
  const [input, setInput] = useState("");
  const transport = useTriggerChatTransport({
    task: "dataset-chat",
    clientData: { datasetId },
    accessToken: ({ chatId }) => mintDatasetChatToken(chatId),
    startSession: ({ chatId, clientData }) => startDatasetChat({ chatId, clientData: clientData as { datasetId: string } }),
    onEvent: (event) => { if (event.type === "stream-error") console.error("Dataset agent stream error", event); },
  });
  const { messages, sendMessage, status, stop } = useChat({ id: chatId, transport });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!input.trim() || status === "streaming") return;
    sendMessage({ text: input.trim() });
    setInput("");
  };
  return <section style={{ marginTop: 24, padding: 24, border: "1px solid #e2e8f0", borderRadius: 12 }}>
    <h2 style={{ marginTop: 0 }}>Ask {datasetName}</h2>
    <p style={{ color: "#64748b" }}>The agent searches name variations, queries ClickHouse, and returns evidence-backed UI.</p>
    <div aria-live="polite">{messages.map((message: any) => <div key={message.id} style={{ margin: "16px 0" }}><strong>{message.role === "user" ? "You" : "Analyst"}</strong>{message.parts?.map((part: any, index: number) => {
      if (part.type === "text") return <p key={index}>{part.text}</p>;
      const insight = insightFromPart(part);
      if (insight) return <InsightView key={index} insight={insight} />;
      if (part.type?.startsWith("tool-") && part.state !== "output-available") return <p key={index} style={{ color: "#64748b" }}>Working: {part.type.replace("tool-", "").replaceAll("_", " ")}…</p>;
      return null;
    })}{message.role === "assistant" && <WorkTrace parts={message.parts ?? []} />}</div>)}</div>
    <form onSubmit={submit} style={{ display: "flex", gap: 12, marginTop: 16 }}><input value={input} onChange={(event) => setInput(event.target.value)} placeholder="e.g. Which Nolan movie features Leonardo DiCaprio?" style={{ flex: 1, padding: 12 }} /><button disabled={status === "streaming"}>{status === "streaming" ? "Thinking…" : "Ask"}</button>{status === "streaming" && <button type="button" onClick={stop}>Stop</button>}</form>
  </section>;
}
