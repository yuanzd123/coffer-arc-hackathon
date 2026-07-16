import { describe, expect, it, vi } from "vitest";
import { HostedCofferArcClient, parseHostedDecision } from "./coffer-client";

const registry = "0x3333333333333333333333333333333333333333" as const;
const sender = "0x1111111111111111111111111111111111111111" as const;
const recipient = "0x2222222222222222222222222222222222222222" as const;

describe("HostedCofferArcClient", () => {
  it("maps the minimal public Arc contract without importing private Core", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        source: "wallet",
        paymentRail: "circle_wallet",
        resourceType: "wallet_payment",
        paymentDestination: recipient,
        requestedRail: "wallet",
        amount: "0.01"
      });
      expect(body.metadata).toMatchObject({
        network: "ARC-TESTNET",
        asset: "USDC",
        sender,
        recipient,
        decisionRegistry: registry
      });
      return Response.json({
        outcome: "allow",
        spendRequestId: "si_arc_001",
        decisionId: "pd_arc_001",
        spendDecisionRecordId: "sdr_si_arc_001",
        reasonCode: "within_budget",
        reason: "Within policy"
      });
    });
    const client = new HostedCofferArcClient({
      apiKey: "coffer_test_key_value_long_enough",
      baseUrl: "https://app.example.test/api",
      registryAddress: registry,
      senderAddress: sender,
      fetch: fetchMock as typeof fetch
    });
    const response = await client.requestDecision({
      agentId: "agent_arc",
      vendorId: "vendor_arc",
      vendorName: "Arc Vendor",
      recipient,
      amount: "0.01",
      businessPurpose: "Run a synthetic Arc agent purchase",
      taskId: "task_arc_001",
      idempotencyKey: "arc-idempotency-001"
    });
    expect(response.outcome).toBe("allow");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("extracts a tx hash from an idempotently replayed hosted decision", () => {
    const txHash = `0x${"a".repeat(64)}`;
    const parsed = parseHostedDecision({
      outcome: "allow",
      spendRequestId: "si_arc_001",
      decisionId: "pd_arc_001",
      spendDecisionRecordId: "sdr_si_arc_001",
      reasonCode: "idempotency_replay",
      reason: "Existing decision replayed",
      paymentReference: `tx_hash:${txHash}`
    });
    expect(parsed.outcome).toBe("allow");
    expect(parsed.settlementTxHash).toBe(txHash);
  });

  it("retries a transient HTTP failure with the identical idempotent request", async () => {
    const attempts: Array<{ body: string; idempotencyKey: string | null }> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      attempts.push({
        body: String(init?.body),
        idempotencyKey: new Headers(init?.headers).get("idempotency-key")
      });
      if (attempts.length === 1) {
        return new Response("temporary failure", { status: 503, statusText: "Service Unavailable" });
      }
      return Response.json({
        outcome: "allow",
        spendRequestId: "si_arc_retry",
        decisionId: "pd_arc_retry",
        spendDecisionRecordId: "sdr_si_arc_retry",
        reasonCode: "within_budget",
        reason: "Within policy"
      });
    });
    const client = createHostedClient(fetchMock, { retryDelayMs: 0 });

    await expect(client.requestDecision(sampleIntent())).resolves.toMatchObject({ outcome: "allow" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(attempts[0]?.idempotencyKey).toBe("arc-idempotency-retry");
  });

  it("retries a network failure and then succeeds", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("socket closed"))
      .mockResolvedValueOnce(Response.json({
        outcome: "allow",
        spendRequestId: "si_arc_network_retry",
        decisionId: "pd_arc_network_retry",
        spendDecisionRecordId: "sdr_si_arc_network_retry",
        reasonCode: "within_budget",
        reason: "Within policy"
      }));
    const client = createHostedClient(fetchMock, { retryDelayMs: 0 });

    await expect(client.requestDecision(sampleIntent())).resolves.toMatchObject({ outcome: "allow" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-transient 409 response", async () => {
    const fetchMock = vi.fn(async () => new Response("settlement conflict", {
      status: 409,
      statusText: "Conflict"
    }));
    const client = createHostedClient(fetchMock, { retryDelayMs: 0 });

    await expect(client.requestDecision(sampleIntent())).rejects.toMatchObject({
      status: 409,
      message: "Hosted Coffer request failed (409): settlement conflict"
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("aborts a hung request at the configured timeout", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const client = createHostedClient(fetchMock, {
      maxAttempts: 1,
      requestTimeoutMs: 5,
      retryDelayMs: 0
    });

    await expect(client.requestDecision(sampleIntent())).rejects.toMatchObject({
      status: 0,
      message: "Hosted Coffer request failed (0): request timed out after 5ms"
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function createHostedClient(
  fetchMock: ReturnType<typeof vi.fn>,
  overrides: Partial<ConstructorParameters<typeof HostedCofferArcClient>[0]> = {}
) {
  return new HostedCofferArcClient({
    apiKey: "coffer_test_key_value_long_enough",
    baseUrl: "https://app.example.test/api",
    registryAddress: registry,
    senderAddress: sender,
    fetch: fetchMock as typeof fetch,
    ...overrides
  });
}

function sampleIntent() {
  return {
    agentId: "external_research_agent",
    vendorId: "arc-data-agent",
    vendorName: "Arc Data Agent",
    recipient,
    amount: "0.01",
    businessPurpose: "Run a synthetic Arc agent purchase",
    taskId: "task_arc_retry",
    idempotencyKey: "arc-idempotency-retry"
  };
}
