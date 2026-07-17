import { describe, expect, it } from "vitest";
import { runArcDemo } from "./run-demo";

describe("public demo response", () => {
  it("maps private decision identifiers and raw reasons out of the allowed HTTP result", async () => {
    const output = await runArcDemo({
      scenarioId: "allow",
      runId: "11111111-1111-4111-8111-111111111111",
      live: false
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("si_mock_");
    expect(serialized).not.toContain("pd_mock_");
    expect(serialized).not.toContain("sdr_mock_");
    expect(serialized).not.toContain("si_reference_");
    expect(serialized).not.toContain("pd_reference_");
    expect(serialized).not.toContain("sdr_reference_");
    expect(serialized).not.toContain("PUBLIC REFERENCE decision");
    expect(serialized).not.toContain("SIMULATED decision");
    expect(serialized).not.toContain("within_budget");
    expect(serialized).not.toContain("reasonCode");
    expect("recordIdHash" in output.result.decision).toBe(true);
    if (!("recordIdHash" in output.result.decision)) throw new Error("allowed result must expose the public record hash");
    expect(output.result.decision.recordIdHash).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it.each(["approval", "block"] as const)("does not expose a linkable record hash for %s", async (scenarioId) => {
    const output = await runArcDemo({
      scenarioId,
      runId: scenarioId === "approval"
        ? "22222222-2222-4222-8222-222222222222"
        : "33333333-3333-4333-8333-333333333333",
      live: false
    });
    const serialized = JSON.stringify(output);
    expect(output.result.decision).not.toHaveProperty("recordIdHash");
    expect(serialized).not.toContain("reasonCode");
    expect(serialized).not.toContain("requires_approval_amount_threshold");
    expect(serialized).not.toContain("blocked_unknown_vendor");
  });
});
