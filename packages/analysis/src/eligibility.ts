export interface ForecastEligibilityInput {
  observations: number;
  horizon: number;
  seasonalPeriod?: number;
  minObservations?: number;
  maxHorizonRatio?: number;
  hasRegularCadence?: boolean;
}
export interface ForecastEligibility { eligible: boolean; reasons: string[]; checks: Record<string, boolean> }

/** Guardrail used before invoking a forecasting model. It never throws. */
export function assessForecastEligibility(input: ForecastEligibilityInput): ForecastEligibility {
  const min = input.minObservations ?? Math.max(10, (input.seasonalPeriod ?? 1) * 2);
  const ratio = input.maxHorizonRatio ?? 0.5;
  const checks = {
    observations: Number.isFinite(input.observations) && input.observations >= min,
    horizon: Number.isFinite(input.horizon) && input.horizon > 0 && input.horizon <= input.observations * ratio,
    cadence: input.hasRegularCadence !== false,
  };
  const reasons: string[] = [];
  if (!checks.observations) reasons.push(`at least ${min} observations are required`);
  if (!checks.horizon) reasons.push(`horizon must be positive and no greater than ${ratio}x history`);
  if (!checks.cadence) reasons.push("observations must have a regular cadence");
  return { eligible: Object.values(checks).every(Boolean), reasons, checks };
}

export const isForecastEligible = (input: ForecastEligibilityInput) => assessForecastEligibility(input).eligible;
export const forecastEligibilityGate = assessForecastEligibility;
