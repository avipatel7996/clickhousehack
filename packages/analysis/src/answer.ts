import { answerEnvelope, type AnswerEnvelope } from "./envelope";
export type { AnswerEnvelope } from "./envelope";

export interface DemoAnswer { answer: string; envelope: AnswerEnvelope<string> }

/** Deterministic local answer used by demos and smoke tests. */
export function buildDemoAnswer(question: string): string {
  const q = question.trim();
  return q ? `Demo answer: ${q}` : "Demo answer: ask a question to get started.";
}

export function buildDemoAnswerEnvelope(question: string): AnswerEnvelope<string> {
  return answerEnvelope(buildDemoAnswer(question), { metadata: { demo: true } });
}
