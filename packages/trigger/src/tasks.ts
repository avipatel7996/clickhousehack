import type { AnswerEnvelope } from "../../analysis/src/envelope";
import { answerEnvelope, errorEnvelope } from "../../analysis/src/envelope";
import { assessForecastEligibility, type ForecastEligibilityInput } from "../../analysis/src/eligibility";

export interface TriggerLogger { info?(message: string, data?: Record<string, unknown>): void; error?(message: string, data?: Record<string, unknown>): void }
export interface ForecastAnalyzer { forecast(input: Record<string, unknown>): Promise<unknown> }
export interface TriggerDependencies { analyzer: ForecastAnalyzer; logger?: TriggerLogger; now?: () => Date }
export interface TriggerTask<TInput = Record<string, unknown>, TResult = unknown> { run(input: TInput, signal?: AbortSignal): Promise<AnswerEnvelope<TResult>> }

export interface ForecastTaskInput extends Record<string, unknown> {
  series?: number[];
  eligibility?: ForecastEligibilityInput;
  [key: string]: unknown;
}

/** A deliberately small task boundary; scheduling and transport are injected by callers. */
export class ForecastTriggerTask implements TriggerTask<ForecastTaskInput> {
  constructor(private readonly deps: TriggerDependencies) {}
  async run(input: ForecastTaskInput, signal?: AbortSignal): Promise<AnswerEnvelope<unknown>> {
    if (input.eligibility) {
      const gate = assessForecastEligibility(input.eligibility);
      if (!gate.eligible) return errorEnvelope("FORECAST_NOT_ELIGIBLE", gate.reasons.join("; "), { metadata: { eligibility: gate } });
    }
    try {
      const result = await this.deps.analyzer.forecast({ ...input, signal });
      this.deps.logger?.info?.("forecast trigger completed");
      return answerEnvelope(result, { metadata: { triggeredAt: (this.deps.now ?? (() => new Date()))().toISOString() } });
    } catch (error) {
      this.deps.logger?.error?.("forecast trigger failed", { error: String(error) });
      return errorEnvelope("FORECAST_FAILED", error instanceof Error ? error.message : String(error));
    }
  }
}

export interface AlertTaskInput extends Record<string, unknown> { condition?: string; [key: string]: unknown }
export class AlertTriggerTask implements TriggerTask<AlertTaskInput> {
  constructor(private readonly deps: TriggerDependencies) {}
  async run(input: AlertTaskInput, signal?: AbortSignal): Promise<AnswerEnvelope<unknown>> {
    try {
      const result = await this.deps.analyzer.forecast({ ...input, signal, mode: "alert" });
      return answerEnvelope(result, { metadata: { triggeredAt: (this.deps.now ?? (() => new Date()))().toISOString() } });
    } catch (error) {
      return errorEnvelope("ALERT_FAILED", error instanceof Error ? error.message : String(error));
    }
  }
}

export function createForecastTriggerTask(deps: TriggerDependencies): ForecastTriggerTask { return new ForecastTriggerTask(deps); }
export function createAlertTriggerTask(deps: TriggerDependencies): AlertTriggerTask { return new AlertTriggerTask(deps); }
