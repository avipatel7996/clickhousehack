"use client";

import { FormEvent, useEffect, useState } from "react";
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
type AgentStatus = { stage: string; message: string; at: string };
type AgentEvent = { stage: string; message: string; state: "started" | "completed" | "failed"; at: string };
type ChatActivity = Pick<AgentStatus, "stage" | "message">;
type GeminiSettings = { baseURL?: string; model?: string };
type ChatProvider = { kind: "featherless" } | { kind: "gemini"; settings: GeminiSettings };

const providerStorageKey = "clickhouse-analyst.gemini-settings";
const defaultGeminiSettings: GeminiSettings = {
  baseURL: "https://generativelanguage.googleapis.com/v1beta",
  model: "gemini-flash-latest",
};

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour12: false });
}

function statusFromParts(parts: any[]): AgentStatus | undefined {
  return [...parts].reverse().find((part) => part?.type === "data-agent-status")?.data as AgentStatus | undefined;
}

function eventsFromParts(parts: any[]): AgentEvent[] {
  return parts.filter((part) => part?.type === "data-agent-event" && part.data?.message).map((part) => part.data as AgentEvent);
}

function insightFromPart(part: any): Insight | null {
  if (part?.type !== "tool-present_insight" && part?.type !== "data-analyst-insight") return null;
  const value = part.data ?? part.output ?? part.result ?? part.input;
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
  const steps = parts.filter((part) => part.type === "tool-inspect_dataset" || part.type === "tool-search_records" || part.type === "tool-query_clickhouse" || part.type === "tool-rank_entities");
  if (!steps.length) return null;
  return <details style={{ marginTop: 10, border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 12px", background: "white" }}>
    <summary style={{ cursor: "pointer", fontWeight: 600 }}>Show work · {steps.length} ClickHouse step{steps.length === 1 ? "" : "s"}</summary>
    {steps.map((step, index) => {
      const output = step.output ?? step.result;
      return <div key={index} style={{ marginTop: 12, paddingTop: 12, borderTop: index ? "1px solid #e2e8f0" : undefined }}><strong>{index + 1}. {step.type.replace("tool-", "").replaceAll("_", " ")}</strong>{step.input && <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, color: "#475569" }}>{JSON.stringify(step.input, null, 2)}</pre>}{output?.sql && <pre style={{ whiteSpace: "pre-wrap", overflowX: "auto", fontSize: 12, background: "#0f172a", color: "#e2e8f0", padding: 10, borderRadius: 6 }}>{output.sql}</pre>}{typeof output?.rowCount === "number" && <small>Returned {output.rowCount} row{output.rowCount === 1 ? "" : "s"}</small>}{output?.rows?.length ? <pre style={{ whiteSpace: "pre-wrap", overflowX: "auto", fontSize: 11 }}>{JSON.stringify(output.rows.slice(0, 5), null, 2)}</pre> : null}</div>;
    })}
  </details>;
}

function WorkflowTrace({ parts, activity }: { parts: any[]; activity: ChatActivity | null }) {
  const status = activity ? (statusFromParts(parts) ?? { ...activity, at: "" }) : undefined;
  const events = eventsFromParts(parts);
  if (!status && !events.length) return null;
  const active = Boolean(activity);
  const color = status?.stage === "error" ? "#b91c1c" : active ? "#0369a1" : "#166534";
  return <aside style={{ marginTop: 10, padding: 12, border: `1px solid ${active ? "#bae6fd" : "#bbf7d0"}`, borderRadius: 10, background: active ? "#f0f9ff" : "#f0fdf4" }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}><strong style={{ color }}>Analyst workflow</strong><small style={{ color }}>{active ? "LIVE" : "COMPLETE"}</small></div>
    {status && <p aria-live={active ? "polite" : "off"} aria-atomic="true" style={{ margin: "6px 0 0", color: "#334155" }}>{status.message}</p>}
    {events.length ? <details open={active || status?.stage === "error"} style={{ marginTop: 8 }}><summary style={{ cursor: "pointer", fontWeight: 600 }}>Timeline · {events.length} event{events.length === 1 ? "" : "s"}</summary><div style={{ maxHeight: 220, overflowY: "auto", marginTop: 8, padding: 10, borderRadius: 6, background: "#0f172a", color: "#e2e8f0", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, lineHeight: 1.55 }}>{events.map((event, index) => <div key={`${event.at}-${index}`} style={{ display: "grid", gridTemplateColumns: "72px 88px minmax(0, 1fr)", gap: 8, padding: "2px 0", borderBottom: "1px solid #1e293b" }}><span style={{ color: "#94a3b8" }}>{formatTime(event.at)}</span><span style={{ color: event.state === "failed" ? "#fca5a5" : event.state === "completed" ? "#86efac" : "#7dd3fc" }}>{event.stage}</span><span style={{ overflowWrap: "anywhere" }}>{event.message}</span></div>)}</div></details> : null}
  </aside>;
}

function DatasetChatSession({ datasetId, provider }: { datasetId: string; provider: ChatProvider }) {
  const [chatId] = useState(() => crypto.randomUUID());
  const [input, setInput] = useState("");
  const [transportError, setTransportError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ChatActivity | null>(null);
  const transport = useTriggerChatTransport({
    task: "dataset-chat",
    clientData: provider.kind === "gemini"
      ? { datasetId, provider: "gemini" as const, gemini: provider.settings }
      : { datasetId, provider: "featherless" as const },
    accessToken: ({ chatId }) => mintDatasetChatToken(chatId),
    startSession: ({ chatId, clientData }) => startDatasetChat({ chatId, clientData: clientData as { datasetId: string; provider?: "featherless" | "gemini"; gemini?: GeminiSettings } }),
    onEvent: (event) => {
      if (event.type === "message-sent") setActivity({ stage: "planning", message: "Question received — preparing the analyst" });
      if (event.type === "stream-connected") setActivity({ stage: "planning", message: "Analyst is checking the dataset" });
      if (event.type === "first-chunk") setActivity({ stage: "answering", message: "Streaming the answer" });
      if (event.type === "turn-completed") setActivity(null);
      if (event.type === "stream-error" || event.type === "message-send-failed") {
        setActivity(null);
        setTransportError("The analyst connection was interrupted. Please try again.");
      }
    },
  });
  const { messages, sendMessage, status, stop, error } = useChat({ id: chatId, transport });
  const busy = status === "submitted" || status === "streaming";
  const latestAssistantId = [...messages].reverse().find((message: any) => message.role === "assistant")?.id;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!input.trim() || busy) return;
    setTransportError(null);
    setActivity({ stage: "planning", message: "Sending your question" });
    sendMessage({ text: input.trim() });
    setInput("");
  };
  return <>
    <div>{activity && !latestAssistantId && <WorkflowTrace parts={[]} activity={activity} />}{messages.map((message: any) => {
      const isLiveAssistant = Boolean(activity) && message.role === "assistant" && message.id === latestAssistantId;
      return <div key={message.id} style={{ margin: "16px 0" }}><strong>{message.role === "user" ? "You" : "Analyst"}</strong>{message.role === "assistant" && <WorkflowTrace parts={message.parts ?? []} activity={isLiveAssistant ? activity : null} />}{message.parts?.map((part: any, index: number) => {
        if (part.type === "text") return <p key={index}>{part.text}{isLiveAssistant && <span aria-hidden="true" style={{ color: "#0284c7" }}> ▍</span>}</p>;
        const insight = insightFromPart(part);
        if (insight) return <InsightView key={index} insight={insight} />;
        return null;
      })}{message.role === "assistant" && <WorkTrace parts={message.parts ?? []} />}</div>;
    })}</div>
    {(error || transportError) && <p role="alert" style={{ marginTop: 12, color: "#b91c1c" }}>{error?.message ?? transportError}</p>}
    <form onSubmit={submit} style={{ display: "flex", gap: 12, marginTop: 16 }}><input value={input} onChange={(event) => setInput(event.target.value)} placeholder="e.g. Which Nolan movie features Leonardo DiCaprio?" style={{ flex: 1, padding: 12 }} /><button disabled={busy}>{status === "submitted" ? "Connecting…" : status === "streaming" ? "Analysing…" : "Ask"}</button>{busy && <button type="button" onClick={() => { setActivity({ stage: "planning", message: "Stopping the analyst" }); stop(); }}>Stop</button>}</form>
  </>;
}

export function DatasetAgentChat({ datasetId, datasetName }: { datasetId: string; datasetName: string }) {
  const [selectedKind, setSelectedKind] = useState<ChatProvider["kind"]>("featherless");
  const [geminiSettings, setGeminiSettings] = useState<GeminiSettings>(defaultGeminiSettings);
  const [activeProvider, setActiveProvider] = useState<ChatProvider>({ kind: "featherless" });
  const [sessionKey, setSessionKey] = useState(0);
  const [settingsMessage, setSettingsMessage] = useState("");

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(providerStorageKey) ?? "") as { kind?: ChatProvider["kind"]; settings?: GeminiSettings };
      if (saved.kind === "gemini") {
        setSelectedKind("gemini");
        const settings = saved.settings ?? defaultGeminiSettings;
        setGeminiSettings(settings);
        setActiveProvider({ kind: "gemini", settings });
      }
    } catch {
      // A malformed local preference should never prevent the chat from loading.
    }
  }, []);

  const startNewChat = () => {
    if (selectedKind === "gemini") {
      const settings = { baseURL: geminiSettings.baseURL?.trim(), model: geminiSettings.model?.trim() };
      if (!settings.baseURL || !settings.model) {
        setSettingsMessage("Enter the Gemini API base URL and model first.");
        return;
      }
      window.localStorage.setItem(providerStorageKey, JSON.stringify({ kind: "gemini", settings }));
      setGeminiSettings(settings);
      setActiveProvider({ kind: "gemini", settings });
      setSettingsMessage("Gemini settings saved on this device. New chat ready.");
    } else {
      window.localStorage.setItem(providerStorageKey, JSON.stringify({ kind: "featherless", settings: geminiSettings }));
      setActiveProvider({ kind: "featherless" });
      setSettingsMessage("Featherless selected. New chat ready.");
    }
    setSessionKey((value) => value + 1);
  };

  return <section style={{ marginTop: 24, padding: 24, border: "1px solid #e2e8f0", borderRadius: 12 }}>
    <h2 style={{ marginTop: 0 }}>Ask {datasetName}</h2>
    <p style={{ color: "#64748b" }}>The agent queries ClickHouse, then streams an evidence-backed answer.</p>
    <details style={{ margin: "14px 0", padding: "10px 12px", border: "1px solid #e2e8f0", borderRadius: 8, background: "#f8fafc" }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>Model connection · {activeProvider.kind === "gemini" ? `Gemini (${activeProvider.settings.model})` : "Featherless"}</summary>
      <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
        <label>Provider <select value={selectedKind} onChange={(event) => setSelectedKind(event.target.value as ChatProvider["kind"])} style={{ marginLeft: 8, padding: 8 }}><option value="featherless">Featherless</option><option value="gemini">Gemini API</option></select></label>
        {selectedKind === "gemini" && <><label>Gemini API base URL <input value={geminiSettings.baseURL ?? ""} onChange={(event) => setGeminiSettings((value) => ({ ...value, baseURL: event.target.value }))} style={{ display: "block", width: "100%", boxSizing: "border-box", marginTop: 4, padding: 8 }} /></label><label>Model <input value={geminiSettings.model ?? ""} onChange={(event) => setGeminiSettings((value) => ({ ...value, model: event.target.value }))} style={{ display: "block", width: "100%", boxSizing: "border-box", marginTop: 4, padding: 8 }} /></label></>}
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}><button type="button" onClick={startNewChat}>{selectedKind === "gemini" ? "Save Gemini settings & start new chat" : "Start new Featherless chat"}</button>{settingsMessage && <small style={{ color: "#475569" }}>{settingsMessage}</small>}</div>
        <small style={{ color: "#64748b" }}>The API key is read only from `GEMINI_API_KEY` in Trigger. This browser stores only the provider, base URL, and model. Start a new chat after changing settings.</small>
      </div>
    </details>
    <DatasetChatSession key={sessionKey} datasetId={datasetId} provider={activeProvider} />
  </section>;
}
