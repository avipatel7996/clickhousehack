"use server";

import { auth } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { ensureWorkspace, getAuthenticatedUser, getSupabaseServerClient } from "../lib/supabase-server";

const startSession = chat.createStartSessionAction("dataset-chat");

type GeminiClientSettings = { baseURL?: string; model?: string };
type DatasetChatClientData = { datasetId: string; provider?: "featherless" | "gemini" | "bedrock-kimi" | "bedrock-claude-opus" | "bedrock-claude-sonnet"; gemini?: GeminiClientSettings };

/** Authorizes a browser session against the selected workspace before minting a session token. */
export async function startDatasetChat(params: { chatId: string; clientData: DatasetChatClientData }) {
  const supabase = await getSupabaseServerClient();
  if (!supabase) throw new Error("Authentication is required");
  const user = await getAuthenticatedUser(supabase);
  if (!user) throw new Error("Authentication is required");
  const workspaceId = await ensureWorkspace(supabase, user.id);
  if (!workspaceId) throw new Error("Workspace membership is required");
  const { data, error } = await supabase.from("dataset_imports").select("id,status").eq("id", params.clientData.datasetId).eq("workspace_id", workspaceId).maybeSingle();
  if (error || !data || data.status !== "published") throw new Error("Select a published dataset before starting chat");
  const provider = params.clientData.provider ?? "featherless";
  return startSession({ chatId: params.chatId, clientData: provider === "gemini"
    ? { datasetId: data.id, provider, gemini: params.clientData.gemini }
    : { datasetId: data.id, provider } });
}

export async function mintDatasetChatToken(chatId: string) {
  return auth.createPublicToken({
    scopes: { read: { sessions: chatId }, write: { sessions: chatId } },
    expirationTime: "1h",
  });
}
