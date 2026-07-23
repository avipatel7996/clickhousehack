/** Minimal, typed client for Featherless' OpenAI-compatible API. */
export interface FeatherlessClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatToolCall {
  id: string;
  type: "function" | string;
  function: { name: string; arguments: string };
}

export interface ChatTool {
  type: "function" | string;
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "text" | "json_object" };
  tools?: ChatTool[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  [key: string]: unknown;
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] };
  finish_reason?: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export class FeatherlessApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: unknown) {
    super(message);
    this.name = "FeatherlessApiError";
  }
}

export class FeatherlessClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly defaultModel?: string;
  constructor(private readonly options: FeatherlessClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) throw new Error("A fetch implementation is required");
    this.baseUrl = (options.baseUrl ?? "https://api.featherless.ai/v1").replace(/\/$/, "");
    this.defaultModel = options.model;
  }

  async chat(request: ChatCompletionRequest, signal?: AbortSignal): Promise<ChatCompletionResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}`, ...this.options.headers },
      body: JSON.stringify({ ...request, model: request.model ?? this.defaultModel }),
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = typeof body === "object" && body && "error" in body ? String((body as any).error?.message ?? "Request failed") : `Request failed (${response.status})`;
      throw new FeatherlessApiError(response.status, message, body);
    }
    return body as ChatCompletionResponse;
  }

  complete(request: ChatCompletionRequest, signal?: AbortSignal): Promise<ChatCompletionResponse> {
    return this.chat(request, signal);
  }
}

/** Explicit alias retained for callers that distinguish this from other OpenAI clients. */
export class FeatherlessOpenAIClient extends FeatherlessClient {}
export const createFeatherlessClient = (options: FeatherlessClientOptions) => new FeatherlessClient(options);
