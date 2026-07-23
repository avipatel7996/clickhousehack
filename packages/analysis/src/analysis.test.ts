import { describe, expect, it } from "vitest";
import { assessForecastEligibility } from "./eligibility";
import { buildDemoAnswer } from "./answer";

describe("analysis primitives", () => {
  it("rejects insufficient history", () => {
    expect(assessForecastEligibility({ observations: 2, horizon: 1 }).eligible).toBe(false);
  });
  it("builds a deterministic demo answer", () => {
    expect(buildDemoAnswer("What is this?")).toContain("What is this?");
  });
});
