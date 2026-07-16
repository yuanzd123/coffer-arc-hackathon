import { describe, expect, it, vi } from "vitest";
import type { ArcDecisionWriter, CofferArcControlClient } from "@coffer/arc";
import { arcTestnetLiveProof, arcTestnetLiveProofItems, publicDemoScenarios } from "./scenarios";
import { ScenarioBoundControlClient, ScenarioBoundWriter } from "./scenario-boundary";

const sender = "0x1111111111111111111111111111111111111111" as const;
const recipient = "0x2222222222222222222222222222222222222222" as const;
const registry = "0x3333333333333333333333333333333333333333" as const;
const commitment = `0x${"a".repeat(64)}` as const;
const operationId = "11111111-1111-4111-8111-111111111111";

describe("server-controlled Arc scenario boundary", () => {
  it("fails closed when Coffer returns an outcome other than the scenario requires", async () => {
    const inner: CofferArcControlClient = {
      async requestDecision() {
        return {
          outcome: "allow",
          spendRequestId: "private-spend-id",
          decisionId: "private-decision-id",
          spendDecisionRecordId: "private-record-id",
          reasonCode: "within_budget",
          reason: "misconfigured test"
        };
      },
      async reportSettlement() {}
    };
    const client = new ScenarioBoundControlClient(inner, publicDemoScenarios.approval);
    await expect(client.requestDecision({
      ...publicDemoScenarios.approval.intent,
      recipient,
      idempotencyKey: "arc:approval:test"
    })).rejects.toThrow(/configured to require requires_approval/);
  });

  it("never lets approval or block scenarios reach a writer", async () => {
    const inner = writer();
    const bounded = new ScenarioBoundWriter(inner, "approval", registry, recipient);
    await expect(bounded.anchorDecision({
      registryAddress: registry,
      commitment,
      outcome: "allow",
      operationId
    })).rejects.toThrow(/not permitted to call the Arc writer/);
    expect(inner.anchorDecision).not.toHaveBeenCalled();
  });

  it("allows only the fixed recipient and exactly $0.01 in the allow scenario", async () => {
    const inner = writer();
    const bounded = new ScenarioBoundWriter(inner, "allow", registry, recipient);
    await expect(bounded.transferUsdcWithMemo({
      recipient,
      amountMinor: 20_000n,
      memoId: commitment,
      memoData: commitment,
      operationId
    })).rejects.toThrow(/fixed \$0.01 recipient boundary/);
    expect(inner.transferUsdcWithMemo).not.toHaveBeenCalled();
  });
});

describe("public Arc Testnet proof", () => {
  it("publishes the Registry and three transaction links on ArcScan", () => {
    expect(arcTestnetLiveProofItems).toHaveLength(4);
    expect(arcTestnetLiveProof.registry.value).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(arcTestnetLiveProof.deploymentTransaction.value).toMatch(/^0x[a-f0-9]{64}$/);
    expect(arcTestnetLiveProof.decisionAnchorTransaction.value).toMatch(/^0x[a-f0-9]{64}$/);
    expect(arcTestnetLiveProof.settlementTransaction.value).toMatch(/^0x[a-f0-9]{64}$/);
    for (const item of arcTestnetLiveProofItems) {
      const url = new URL(item.href);
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe("testnet.arcscan.app");
      expect(url.pathname.endsWith(item.value)).toBe(true);
    }
  });

  it("contains no operator, recipient, provider, wallet, or private decision identifiers", () => {
    const serialized = JSON.stringify(arcTestnetLiveProof);
    expect(serialized).not.toMatch(/operator|recipient|sender|walletId|providerId|decisionId|spendRequestId|recordHash|decisionCommitment/);
  });
});

function writer(): ArcDecisionWriter {
  return {
    sender,
    anchorDecision: vi.fn(async () => ({ provider: "test" as const, txHash: commitment })),
    transferUsdcWithMemo: vi.fn(async () => ({ provider: "test" as const, txHash: commitment }))
  };
}
