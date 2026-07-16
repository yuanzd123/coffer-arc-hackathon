import { describe, expect, it } from "vitest";
import {
  buildDecisionCommitment,
  deterministicCircleOperationId,
  formatUsdcMinorAsUsd,
  parseUsdAmountToUsdcMinor
} from "./commitment";

const base = {
  spendRequestId: "si_demo_001",
  decisionId: "pd_demo_001",
  spendDecisionRecordId: "sdr_si_demo_001",
  outcome: "allow" as const,
  agentId: "agent_arc_research",
  recipient: "0x1111111111111111111111111111111111111111" as const,
  amountMinor: 10_000n,
  idempotencyKey: "arc-demo-allow-0001"
};

describe("Arc decision commitment", () => {
  it("is deterministic and changes with settlement-critical fields", () => {
    const first = buildDecisionCommitment(base);
    expect(buildDecisionCommitment(base)).toBe(first);
    expect(buildDecisionCommitment({ ...base, amountMinor: 20_000n })).not.toBe(first);
    expect(buildDecisionCommitment({ ...base, recipient: "0x2222222222222222222222222222222222222222" })).not.toBe(first);
  });

  it("derives stable, stage-specific UUIDv4 idempotency keys", () => {
    const commitment = buildDecisionCommitment(base);
    const anchor = deterministicCircleOperationId(commitment, "anchor");
    const settlement = deterministicCircleOperationId(commitment, "settle");
    expect(anchor).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicCircleOperationId(commitment, "anchor")).toBe(anchor);
    expect(settlement).not.toBe(anchor);
  });

  it("maps Coffer cent precision to the Arc USDC six-decimal interface", () => {
    expect(parseUsdAmountToUsdcMinor("0.01")).toBe(10_000n);
    expect(parseUsdAmountToUsdcMinor("12.30")).toBe(12_300_000n);
    expect(formatUsdcMinorAsUsd(12_300_000n)).toBe("12.30");
    expect(() => parseUsdAmountToUsdcMinor("0.001")).toThrow("at most two");
  });
});
