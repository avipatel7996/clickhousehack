"use client";

import { FormEvent, useMemo, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import type { datasetChat } from "../../../trigger/dataset-chat";
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
  return <article style={{ marginTop: 10, padding: 16, border: "1px solid #cbd5e1", borderRadius: 12, background: "#f8fafc" }}>
    <h3 style={{ margin: 0 }}>{insight.title}</h3>
    <p>{insight.summary}</p>
    {insight.cards?.length ? <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>{insight.cards.map((card, index) => <div key={index} style={{ background: "white", borderRadius: 8, padding: 12, border: "1px solid #e2e8f0" }}><small>{card.label}</small><strong style={{ display: "block", fontSize: 20 }}>{card.value}</strong>{card.detail && <small>{card.detail}</small>}</div>)}</div> : null}
    {insight.table?.rows?.length ? <div style={{ overflowX: "auto", marginTop: 12 }}><table style={{ borderCollapse: "collapse", width: "100%" }}><thead><tr>{insight.table.columns.map((column) => <th key={column} style={{ textAlign: "left", borderBottom: "1px solid #cbd5e1", padding: 8 }}>{column}</th>)}</tr></thead><tbody>{insight.table.rows.map((row, rowIndex) => <tr key={rowIndex}>{insight.table!.columns.map((column) => <td key={column} style={{ borderBottom: "1px solid #e2e8f0", padding: 8 }}>{String(row[column] ?? "—")}</td>)}</tr>)}</tbody></table></div> : null}
    {insight.chart?.type && insight.chart.type !== "none" && insight.chart.data.length ? <pre style={{ overflowX: "auto", fontSize: 12, background: "#0f172a", color: "#e2e8f0", padding: 12, borderRadius: 8 }}>{JSON.stringify(insight.chart, null, 2)}</pre> : null}
    {insight.caveat && <small style={{ color: "#64748b" }}>{insight.caveat}</small>}
  </article>;
}

export function DatasetAgentChat({ datasetId, datasetName }: { datasetId: string; datasetName: string }) {
  const [chatId] = useState(() => crypto.randomUUID());
  const [input, setInput] = useState("");
  const transport = useTriggerChatTransport<typeof datasetChat>({
    task: "dataset-chat",
    clientData: { datasetId },
    accessToken: ({ chatId }) => mintDatasetChatToken(chatId),
    startSession: ({ chatId, clientData }) => startDatasetChat({ chatId, clientData }),
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
    })}</div>)}</div>
    <form onSubmit={submit} style={{ display: "flex", gap: 12, marginTop: 16 }}><input value={input} onChange={(event) => setInput(event.target.value)} placeholder="e.g. Which Nolan movie features Leonardo DiCaprio?" style={{ flex: 1, padding: 12 }} /><button disabled={status === "streaming"}>{status === "streaming" ? "Thinking…" : "Ask"}</button>{status === "streaming" && <button type="button" onClick={stop}>Stop</button>}</form>
  </section>;
}
