import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { CofferGuardedAgentWalletTransfer } from "./guarded-agent-wallet-transfer";
import { ARC_TESTNET_MEMO_ADDRESS, ARC_TESTNET_USDC_ADDRESS } from "./constants";
import type {
  ArcAgentWalletEvidenceVerifier,
  ArcAgentWalletWriter,
  CofferArcControlClient,
  CofferArcDecision,
  CofferArcSpendIntent
} from "./types";

const sender = "0x1111111111111111111111111111111111111111" as Address;
const recipient = "0x2222222222222222222222222222222222222222" as Address;
const transactionSender = "0x3333333333333333333333333333333333333333" as Address;
const transactionTarget = "0x4444444444444444444444444444444444444444" as Address;
const settlementHash = `0x${"a".repeat(64)}` as Hex;
const blockHash = `0x${"b".repeat(64)}` as Hex;
const codeHash = `0x${"c".repeat(64)}` as Hex;

const intent: CofferArcSpendIntent = {
  agentId: "agent_arc_agent_wallet",
  vendorId: "vendor_arc_agent_wallet",
  vendorName: "Arc Agent Service",
  recipient,
  amount: "0.01",
  businessPurpose: "Purchase a synthetic service result for Agent Wallet proof",
  taskId: "task_arc_agent_wallet_001",
  idempotencyKey: "arc-agent-wallet-allow-0001"
};

function decision(outcome: CofferArcDecision["outcome"], settlementTxHash?: Hex): CofferArcDecision {
  return {
    outcome,
    spendRequestId: "si_arc_agent_wallet_001",
    decisionId: "pd_arc_agent_wallet_001",
    spendDecisionRecordId: "sdr_arc_agent_wallet_001",
    reasonCode: outcome === "allow" ? "within_budget" : "policy_gate",
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
  const writer: ArcAgentWalletWriter = {
    sender,
    maxAmountMinor: 10_000n,
    transferUsdc: vi.fn(async () => {
      order.push("wallet-write");
      return {
        provider: "circle_agent_wallet_cli" as const,
        providerTransactionId: "circle-tx-001",
        txHash: settlementHash
      };
    })
  };
  const verifier: ArcAgentWalletEvidenceVerifier = {
    verifyAgentWalletUsdcTransfer: vi.fn(async (input) => {
      order.push("receipt-verify");
      return {
        ...input,
        blockNumber: 123n,
        blockHash,
        transactionIndex: 4,
        transferLogIndex: 9,
        transactionSender,
        transactionTarget,
        senderCodeHash: codeHash,
        tokenAddress: "0x3600000000000000000000000000000000000000" as Address,
        tokenCodeHash: codeHash
      };
    })
  };
  const guard = new CofferGuardedAgentWalletTransfer({
    controlClient,
    writer,
    verifier,
    now: () => new Date("2026-07-16T12:00:00.000Z")
  });
  return { controlClient, writer, verifier, guard, order };
}

describe("CofferGuardedAgentWalletTransfer", () => {
  it.each(["block", "requires_approval"] as const)("keeps every wallet mutation at zero for %s", async (outcome) => {
    const h = harness(decision(outcome));
    const result = await h.guard.execute(intent);
    expect(result.state).toBe("not_executed");
    expect(h.writer.transferUsdc).not.toHaveBeenCalled();
    expect(h.verifier.verifyAgentWalletUsdcTransfer).not.toHaveBeenCalled();
    expect(h.controlClient.reportSettlement).not.toHaveBeenCalled();
    expect(h.order).toEqual(["decision"]);
  });

  it("calls the Agent Wallet once, verifies the receipt, and only then reports", async () => {
    const h = harness(decision("allow"));
    const result = await h.guard.execute(intent);
    expect(result.state).toBe("settled");
    if (result.state !== "settled") throw new Error("Expected settlement");
    expect(result.replayed).toBe(false);
    expect(result.providerTransactionId).toBe("circle-tx-001");
    expect(h.writer.transferUsdc).toHaveBeenCalledOnce();
    expect(h.order).toEqual(["decision", "wallet-write", "receipt-verify", "report"]);

    const writeInput = vi.mocked(h.writer.transferUsdc).mock.calls[0]?.[0];
    expect(writeInput?.amountMinor).toBe(10_000n);
    expect(writeInput?.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const report = vi.mocked(h.controlClient.reportSettlement).mock.calls[0]?.[0];
    expect(report?.metadata).toMatchObject({
      walletType: "Circle Agent Wallet SCA",
      commitmentBinding: "offchain_correlation_only_no_arc_memo",
      executionProvider: "circle_agent_wallet_cli",
      evidence: "exact_arc_usdc_debit_and_claimed_sender_contract_code"
    });
  });

  it("verifies a replay without a second CLI mutation or settlement report", async () => {
    const h = harness(decision("allow", settlementHash));
    const result = await h.guard.execute(intent);
    expect(result.state).toBe("settled");
    if (result.state !== "settled") throw new Error("Expected settlement");
    expect(result.replayed).toBe(true);
    expect(h.writer.transferUsdc).not.toHaveBeenCalled();
    expect(h.controlClient.reportSettlement).not.toHaveBeenCalled();
    expect(h.order).toEqual(["decision", "receipt-verify"]);
  });

  it.each([
    "0x0000000000000000000000000000000000000000",
    sender,
    ARC_TESTNET_MEMO_ADDRESS,
    ARC_TESTNET_USDC_ADDRESS
  ] as const)("rejects unsafe recipient %s before decision or replay verification", async (unsafeRecipient) => {
    const h = harness(decision("allow", settlementHash));
    await expect(h.guard.execute({ ...intent, recipient: unsafeRecipient }))
      .rejects.toThrow("external fixed payment address");
    expect(h.controlClient.requestDecision).not.toHaveBeenCalled();
    expect(h.writer.transferUsdc).not.toHaveBeenCalled();
    expect(h.verifier.verifyAgentWalletUsdcTransfer).not.toHaveBeenCalled();
  });

  it("rejects an above-cap allowed replay before receipt verification", async () => {
    const h = harness(decision("allow", settlementHash));
    await expect(h.guard.execute({ ...intent, amount: "0.02" }))
      .rejects.toThrow("exceeds the configured hard cap");
    expect(h.controlClient.requestDecision).toHaveBeenCalledOnce();
    expect(h.writer.transferUsdc).not.toHaveBeenCalled();
    expect(h.verifier.verifyAgentWalletUsdcTransfer).not.toHaveBeenCalled();
  });

  it("returns a 12.00 approval decision without applying the settlement cap or touching the wallet", async () => {
    const h = harness(decision("requires_approval"));
    const result = await h.guard.execute({ ...intent, amount: "12.00" });
    expect(result).toMatchObject({ state: "not_executed", reason: "requires_approval" });
    expect(h.controlClient.requestDecision).toHaveBeenCalledOnce();
    expect(h.writer.transferUsdc).not.toHaveBeenCalled();
    expect(h.verifier.verifyAgentWalletUsdcTransfer).not.toHaveBeenCalled();
  });
});
