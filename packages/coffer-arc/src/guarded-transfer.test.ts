import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { CofferGuardedArcTransfer } from "./guarded-transfer";
import type {
  ArcDecisionWriter,
  ArcEvidenceVerifier,
  CofferArcControlClient,
  CofferArcDecision,
  CofferArcSpendIntent
} from "./types";

const sender = "0x1111111111111111111111111111111111111111" as Address;
const recipient = "0x2222222222222222222222222222222222222222" as Address;
const registry = "0x3333333333333333333333333333333333333333" as Address;
const anchorHash = `0x${"a".repeat(64)}` as Hex;
const settlementHash = `0x${"b".repeat(64)}` as Hex;

const intent: CofferArcSpendIntent = {
  agentId: "agent_arc_research",
  vendorId: "vendor_arc_data",
  vendorName: "Arc Data Agent",
  recipient,
  amount: "0.01",
  businessPurpose: "Purchase a synthetic research result for the Arc hackathon demo",
  taskId: "task_arc_001",
  idempotencyKey: "arc-demo-allow-0001"
};

function decision(outcome: CofferArcDecision["outcome"], settlementTxHash?: Hex): CofferArcDecision {
  return {
    outcome,
    spendRequestId: "si_arc_001",
    decisionId: "pd_arc_001",
    spendDecisionRecordId: "sdr_si_arc_001",
    reasonCode: outcome === "allow" ? "within_budget" : "blocked_vendor",
    reason: "Synthetic test decision",
    settlementTxHash
  };
}

function harness(currentDecision: CofferArcDecision) {
  const order: string[] = [];
  const controlClient: CofferArcControlClient = {
    requestDecision: vi.fn(async () => {
      order.push("decision");
      return currentDecision;
    }),
    reportSettlement: vi.fn(async () => {
      order.push("report");
    })
  };
  const writer: ArcDecisionWriter = {
    sender,
    anchorDecision: vi.fn(async () => {
      order.push("anchor-write");
      return { provider: "test" as const, txHash: anchorHash };
    }),
    transferUsdcWithMemo: vi.fn(async () => {
      order.push("settlement-write");
      return { provider: "test" as const, txHash: settlementHash };
    })
  };
  const verifier: ArcEvidenceVerifier = {
    verifyRegistryState: vi.fn(async (input) => {
      order.push("anchor-state-verify");
      return { ...input, txHash: anchorHash, blockNumber: 100n };
    }),
    verifyAnchor: vi.fn(async (input) => {
      order.push("anchor-verify");
      return { ...input, blockNumber: 100n, operator: sender };
    }),
    verifyMemoTransfer: vi.fn(async (input) => {
      order.push("settlement-verify");
      return { ...input, blockNumber: 101n, callDataHash: `0x${"c".repeat(64)}` as Hex };
    })
  };
  const guard = new CofferGuardedArcTransfer({
    controlClient,
    writer,
    verifier,
    registryAddress: registry,
    now: () => new Date("2026-07-15T12:00:00.000Z")
  });
  return { controlClient, writer, verifier, guard, order };
}

describe("CofferGuardedArcTransfer", () => {
  it.each(["block", "requires_approval"] as const)("never touches the Arc wallet for a %s decision", async (outcome) => {
    const h = harness(decision(outcome));
    const result = await h.guard.execute(intent);
    expect(result.state).toBe("not_executed");
    expect(h.writer.anchorDecision).not.toHaveBeenCalled();
    expect(h.writer.transferUsdcWithMemo).not.toHaveBeenCalled();
    expect(h.controlClient.reportSettlement).not.toHaveBeenCalled();
    expect(h.order).toEqual(["decision"]);
  });

  it("anchors, verifies, settles, verifies, then reports in strict order", async () => {
    const h = harness(decision("allow"));
    const result = await h.guard.execute(intent);
    expect(result.state).toBe("settled");
    if (result.state !== "settled") throw new Error("Expected settlement");
    expect(result.replayed).toBe(false);
    expect(result.settlement.txHash).toBe(settlementHash);
    expect(h.order).toEqual([
      "decision",
      "anchor-write",
      "anchor-verify",
      "settlement-write",
      "settlement-verify",
      "report"
    ]);
    const anchorInput = vi.mocked(h.writer.anchorDecision).mock.calls[0]?.[0];
    const settlementInput = vi.mocked(h.writer.transferUsdcWithMemo).mock.calls[0]?.[0];
    expect(anchorInput?.operationId).toMatch(/-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
    expect(settlementInput?.operationId).not.toBe(anchorInput?.operationId);
    expect(settlementInput?.amountMinor).toBe(10_000n);
  });

  it("verifies a replayed settlement without sending a second payment", async () => {
    const h = harness(decision("allow", settlementHash));
    const result = await h.guard.execute(intent);
    expect(result.state).toBe("settled");
    if (result.state !== "settled") throw new Error("Expected settlement");
    expect(result.replayed).toBe(true);
    expect(h.writer.anchorDecision).not.toHaveBeenCalled();
    expect(h.writer.transferUsdcWithMemo).not.toHaveBeenCalled();
    expect(h.controlClient.reportSettlement).not.toHaveBeenCalled();
    expect(result.anchor.txHash).toBe(anchorHash);
    expect(h.order).toEqual(["decision", "anchor-state-verify", "settlement-verify"]);
  });
});
