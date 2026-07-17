import { describe, expect, it } from "vitest";
import type { CofferArcSpendIntent } from "@coffer/arc";
import { evaluateReferenceSpend } from "./reference-policy";
import { publicDemoScenarios, scenarioIntent } from "./scenarios";

const recipient = "0x2222222222222222222222222222222222222222" as const;

describe("public hackathon reference policy", () => {
  it.each(["allow", "approval", "block"] as const)("derives the %s outcome from public intent fields", (id) => {
    const intent = scenarioIntent(id, recipient, `11111111-1111-4111-8111-11111111111${id.length}`);
    expect(evaluateReferenceSpend(intent).outcome).toBe(publicDemoScenarios[id].expectedOutcome);
  });

  it("does not trust the demo scenario label as policy input", () => {
    const intent = scenarioIntent("block", recipient, "11111111-1111-4111-8111-111111111111");
    intent.metadata = { ...intent.metadata, demoScenario: "allow" };
    expect(evaluateReferenceSpend(intent)).toMatchObject({
      outcome: "block",
      reasonCode: "blocked_unknown_vendor"
    });
  });

  it("fails closed for malformed amounts, unknown agents, missing purpose, and exceeded budget", () => {
    expect(evaluateReferenceSpend(baseIntent({ amount: "0.010" })).reasonCode).toBe("invalid_amount");
    expect(evaluateReferenceSpend(baseIntent({ agentId: "unknown-agent" })).reasonCode).toBe("blocked_unknown_agent");
    expect(evaluateReferenceSpend(baseIntent({ businessPurpose: " " })).reasonCode).toBe("missing_business_purpose");
    expect(evaluateReferenceSpend(baseIntent({ amount: "20.01" })).reasonCode).toBe("budget_exceeded");
  });
});

function baseIntent(overrides: Partial<CofferArcSpendIntent>): CofferArcSpendIntent {
  return {
    agentId: "external_research_agent",
    vendorId: "arc-data-agent",
    vendorName: "Arc Data Agent",
    recipient,
    amount: "0.01",
    businessPurpose: "Purchase a synthetic market signal",
    taskId: "reference-policy-test",
    idempotencyKey: "arc:reference-policy:test",
    ...overrides
  };
}
