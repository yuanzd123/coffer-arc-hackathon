import { describe, expect, it, vi } from "vitest";
import {
  createCircleGuardedAgentWalletTransfer,
  createCircleGuardedAgentWalletTransferWithDependencies,
  sanitizeAgentWalletTransferResult
} from "./agent-wallet-factory";
import type { ArcAgentWalletEvidenceVerifier, ArcAgentWalletWriter } from "./types";

const sender = "0x1111111111111111111111111111111111111111" as const;
const recipient = "0x2222222222222222222222222222222222222222" as const;

describe("createCircleGuardedAgentWalletTransfer", () => {
  it("binds the same Agent Wallet sender into the Coffer decision context", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { metadata: Record<string, unknown> };
      expect(body.metadata).toMatchObject({
        sender,
        recipient,
        walletType: "Circle Agent Wallet SCA",
        executionProvider: "circle_agent_wallet_cli",
        memoBound: false,
        registryAnchored: false
      });
      return Response.json({
        outcome: "block",
        spendRequestId: "si_factory_block",
        decisionId: "pd_factory_block",
        spendDecisionRecordId: "sdr_factory_block",
        reasonCode: "blocked_vendor",
        reason: "Blocked in factory binding test"
      });
    });
    const executor = createCircleGuardedAgentWalletTransfer({
      apiKey: "coffer_test_key_value_long_enough",
      baseUrl: "https://app.example.test/api",
      senderAddress: sender,
      cliHome: "/path/not-used-for-blocked-decision",
      maxAmountMinor: 10_000n,
      maxAttempts: 1,
      fetch: fetchMock as typeof fetch
    });

    const result = await executor.execute({
      agentId: "agent_factory_test",
      vendorId: "blocked-vendor",
      vendorName: "Blocked Vendor",
      recipient,
      amount: "0.01",
      businessPurpose: "Prove the public factory preserves the Coffer-first gate",
      taskId: "factory-test-block",
      idempotencyKey: "factory-test-block-001"
    });

    expect(result).toMatchObject({ state: "not_executed", reason: "blocked" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("removes Circle's private provider reference from the public result", () => {
    const result = sanitizeAgentWalletTransferResult({
      state: "settled",
      decision: {
        outcome: "allow",
        spendRequestId: "si_private",
        decisionId: "pd_private",
        spendDecisionRecordId: "sdr_private",
        reasonCode: "within_budget",
        reason: "Synthetic result"
      },
      replayed: false,
      decisionCommitment: `0x${"1".repeat(64)}`,
      recordHash: `0x${"2".repeat(64)}`,
      settlement: {
        txHash: `0x${"3".repeat(64)}`,
        blockNumber: 1n,
        blockHash: `0x${"4".repeat(64)}`,
        transactionIndex: 0,
        transferLogIndex: 0,
        transactionSender: sender,
        transactionTarget: recipient,
        sender,
        senderCodeHash: `0x${"5".repeat(64)}`,
        recipient,
        amountMinor: 10_000n,
        tokenAddress: "0x3600000000000000000000000000000000000000",
        tokenCodeHash: `0x${"6".repeat(64)}`
      },
      providerTransactionId: "circle-private-provider-reference"
    });

    expect(result).not.toHaveProperty("providerTransactionId");
    expect(serializeForPrivacyAssertion(result)).not.toContain("circle-private-provider-reference");
  });

  it("keeps Circle correlation in the private settlement report but not the factory result", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body });
      if (url.endsWith("/v1/spend-intents")) {
        return Response.json({
          outcome: "allow",
          spendRequestId: "si_factory_allow",
          decisionId: "pd_factory_allow",
          spendDecisionRecordId: "sdr_factory_allow",
          reasonCode: "within_budget",
          reason: "Synthetic allow"
        });
      }
      if (url.endsWith("/v1/spend-intents/si_factory_allow/settlement")) {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected test route", { status: 404 });
    });
    const transactionHash = `0x${"a".repeat(64)}` as const;
    const blockHash = `0x${"b".repeat(64)}` as const;
    const codeHash = `0x${"c".repeat(64)}` as const;
    const writer: ArcAgentWalletWriter = {
      sender,
      maxAmountMinor: 10_000n,
      transferUsdc: vi.fn(async () => ({
        provider: "circle_agent_wallet_cli" as const,
        providerTransactionId: "circle-private-provider-reference",
        txHash: transactionHash
      }))
    };
    const verifier: ArcAgentWalletEvidenceVerifier = {
      verifyAgentWalletUsdcTransfer: vi.fn(async (input) => ({
        ...input,
        blockNumber: 1n,
        blockHash,
        transactionIndex: 0,
        transferLogIndex: 0,
        transactionSender: sender,
        transactionTarget: recipient,
        senderCodeHash: codeHash,
        tokenAddress: "0x3600000000000000000000000000000000000000",
        tokenCodeHash: codeHash
      }))
    };
    const executor = createCircleGuardedAgentWalletTransferWithDependencies({
      apiKey: "coffer_test_key_value_long_enough",
      baseUrl: "https://app.example.test/api",
      senderAddress: sender,
      cliHome: "/not-used-by-injected-test-writer",
      maxAmountMinor: 10_000n,
      maxAttempts: 1,
      fetch: fetchMock as typeof fetch
    }, { writer, verifier });

    const result = await executor.execute({
      agentId: "agent_factory_test",
      vendorId: "arc-data-agent",
      vendorName: "Arc Data Agent",
      recipient,
      amount: "0.01",
      businessPurpose: "Prove factory result privacy",
      taskId: "factory-test-allow",
      idempotencyKey: "factory-test-allow-001"
    });

    expect(result).not.toHaveProperty("providerTransactionId");
    expect(serializeForPrivacyAssertion(result)).not.toContain("circle-private-provider-reference");
    const settlementRequest = requests.find(({ url }) => url.endsWith("/settlement"));
    expect(settlementRequest?.body.metadata).toMatchObject({
      providerTransactionId: "circle-private-provider-reference"
    });
    expect(writer.transferUsdc).toHaveBeenCalledOnce();
    expect(verifier.verifyAgentWalletUsdcTransfer).toHaveBeenCalledOnce();
  });
});

function serializeForPrivacyAssertion(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => typeof nested === "bigint" ? nested.toString() : nested);
}
