import { tasks } from "@trigger.dev/sdk/v3";

export type TriggerDispatch = { enabled: boolean; runId?: string; error?: string };

/** Trigger is intentionally optional: local development keeps the demo response working. */
export async function dispatchTask(taskId: string, payload: Record<string, unknown>): Promise<TriggerDispatch> {
  if (!process.env.TRIGGER_SECRET_KEY) return { enabled: false };
  try {
    const run = await tasks.trigger(taskId, payload as never);
    return { enabled: true, runId: run.id };
  } catch (error) {
    return { enabled: true, error: error instanceof Error ? error.message : String(error) };
  }
}
