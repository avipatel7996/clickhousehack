import { describe, expect, it, vi } from "vitest";
import { runAnalysis } from "./runtime";

describe("analysis runtime", () => {
  it("executes a model query tool call and returns grounded evidence", async () => {
    const chat = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "q1", type: "function", function: { name: "query_dataset", arguments: JSON.stringify({ sql: "SELECT city, sum(sales) AS total FROM sales GROUP BY city" }) } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: JSON.stringify({ answer: "Paris leads", chart: { type: "bar", x: "city", y: "total" }, caveats: [] }) } }] });
    const result = await runAnalysis("Which city leads?", {
      client: { chat },
      queryExecutor: { query: vi.fn().mockResolvedValue({ rows: [{ city: "Paris", total: 4 }] }) },
      schema: { datasetId: "d1", version: 3, columns: [{ name: "city", type: "String" }, { name: "sales", type: "UInt64" }] },
    });
    expect(result.answer).toBe("Paris leads");
    expect(result.evidence[0]).toMatchObject({ queryId: "q1", rowCount: 1, datasetId: "d1" });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("rejects mutating SQL before it reaches the executor", async () => {
    const chat = vi.fn().mockResolvedValue({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "q1", type: "function", function: { name: "query_dataset", arguments: JSON.stringify({ sql: "DROP TABLE sales" }) } }] } }] });
    const query = vi.fn();
    await expect(runAnalysis("remove it", { client: { chat }, queryExecutor: { query }, schema: { datasetId: "d", version: 1, columns: [] } })).rejects.toThrow(/read-only/);
    expect(query).not.toHaveBeenCalled();
  });
});
