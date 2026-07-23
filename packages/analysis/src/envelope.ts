export interface AnswerCitation { title?: string; url?: string; excerpt?: string; [key: string]: unknown }
export interface AnswerEnvelope<T = string> {
  answer: T;
  status: "ok" | "error";
  confidence?: number;
  citations: AnswerCitation[];
  /** Alias for clients that call supporting material evidence. */
  evidence?: AnswerCitation[];
  metadata: Record<string, unknown>;
  traceId?: string;
  createdAt: string;
  error?: { code: string; message: string };
}

export function answerEnvelope<T>(answer: T, options: Partial<Omit<AnswerEnvelope<T>, "answer" | "status" | "createdAt">> = {}): AnswerEnvelope<T> {
  return { answer, status: "ok", citations: [], metadata: {}, createdAt: new Date().toISOString(), ...options };
}

export function errorEnvelope(code: string, message: string, options: Partial<AnswerEnvelope<null>> = {}): AnswerEnvelope<null> {
  return { answer: null, status: "error", citations: [], metadata: {}, createdAt: new Date().toISOString(), error: { code, message }, ...options };
}
