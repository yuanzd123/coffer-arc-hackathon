import { getAddress, type Address, type Hex } from "viem";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_MEMO_ADDRESS,
  ARC_TESTNET_USDC_ADDRESS,
  COFFER_ARC_ADAPTER_VERSION
} from "./constants";
import type {
  CofferArcControlClient,
  CofferArcDecision,
  CofferArcDecisionOutcome,
  CofferArcSpendIntent,
  CofferSettlementReport
} from "./types";

export type HostedCofferArcClientOptions = {
  apiKey: string;
  baseUrl: string;
  registryAddress?: Address;
  senderAddress: Address;
  walletMode?: "developer_controlled_eoa" | "agent_wallet_sca";
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
};

export class HostedCofferArcClient implements CofferArcControlClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly registryAddress?: Address;
  private readonly senderAddress: Address;
  private readonly walletMode: "developer_controlled_eoa" | "agent_wallet_sca";
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;

  constructor(options: HostedCofferArcClientOptions) {
    this.apiKey = requireText(options.apiKey, "Coffer API key", 512);
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.senderAddress = getAddress(options.senderAddress);
    const walletMode = options.walletMode ?? "developer_controlled_eoa";
    if (walletMode !== "developer_controlled_eoa" && walletMode !== "agent_wallet_sca") {
      throw new Error("Unsupported Circle wallet mode");
    }
    this.walletMode = walletMode;
    if (this.walletMode === "developer_controlled_eoa") {
      if (!options.registryAddress) throw new Error("Decision registry address is required for the developer-controlled EOA lane");
      this.registryAddress = getAddress(options.registryAddress);
    } else {
      if (options.registryAddress !== undefined) {
        throw new Error("Agent Wallet SCA compatibility lane must not claim a Registry binding");
      }
      this.registryAddress = undefined;
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = boundedInteger(options.requestTimeoutMs ?? 10_000, "request timeout", 1, 60_000);
    this.maxAttempts = boundedInteger(options.maxAttempts ?? 3, "maximum attempts", 1, 5);
    this.retryDelayMs = boundedInteger(options.retryDelayMs ?? 250, "retry delay", 0, 5_000);
  }

  async requestDecision(intent: CofferArcSpendIntent): Promise<CofferArcDecision> {
    const sharedMetadata = {
      ...(intent.metadata ?? {}),
      adapterVersion: COFFER_ARC_ADAPTER_VERSION,
      chain: "Arc Testnet",
      network: "ARC-TESTNET",
      chainId: ARC_TESTNET_CHAIN_ID,
      asset: "USDC",
      assetAddress: ARC_TESTNET_USDC_ADDRESS,
      sender: this.senderAddress,
      recipient: getAddress(intent.recipient)
    };
    const metadata = this.walletMode === "developer_controlled_eoa"
      ? {
          ...sharedMetadata,
          walletType: "Circle Developer-Controlled EOA",
          executionProvider: "circle_developer_controlled_wallets",
          memoBound: true,
          registryAnchored: true,
          memoContract: ARC_TESTNET_MEMO_ADDRESS,
          decisionRegistry: this.registryAddress
        }
      : {
          ...sharedMetadata,
          walletType: "Circle Agent Wallet SCA",
          executionProvider: "circle_agent_wallet_cli",
          memoBound: false,
          registryAnchored: false,
          compatibilityLane: true
        };
    const response = await this.request<Record<string, unknown>>("/v1/spend-intents", {
      method: "POST",
      headers: { "idempotency-key": requireText(intent.idempotencyKey, "idempotency key", 240) },
      body: JSON.stringify({
        agentId: requireText(intent.agentId, "agent id", 80),
        agentName: optionalText(intent.agentName, "agent name", 160),
        vendorId: optionalText(intent.vendorId, "vendor id", 120),
        vendorName: requireText(intent.vendorName, "vendor name", 160),
        source: "wallet",
        paymentRail: "circle_wallet",
        resourceType: "wallet_payment",
        paymentDestination: getAddress(intent.recipient),
        amount: normalizeUsdAmount(intent.amount),
        currency: "USD",
        category: "agent_to_agent_service",
        businessPurpose: requireText(intent.businessPurpose, "business purpose", 500),
        sourceSystem: "coffer_arc_demo",
        sourceTaskId: requireText(intent.taskId, "task id", 160),
        taskDescription: optionalText(intent.taskDescription, "task description", 500),
        requestedRail: "wallet",
        idempotencyKey: intent.idempotencyKey,
        metadata
      })
    });
    return parseHostedDecision(response);
  }

  async reportSettlement(report: CofferSettlementReport): Promise<void> {
    await this.request(`/v1/spend-intents/${encodeURIComponent(requireText(report.spendRequestId, "spend request id", 240))}/settlement`, {
      method: "POST",
      body: JSON.stringify({
        railType: "wallet",
        paymentRail: "circle_wallet",
        referenceType: "tx_hash",
        referenceValue: requireTxHash(report.txHash),
        amount: normalizeUsdAmount(report.amount),
        currency: "USD",
        settledAt: report.settledAt,
        metadata: report.metadata
      })
    });
  }

  private async request<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const requestInit = {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...(init.headers ?? {})
      }
    } satisfies RequestInit;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchWithTimeout(url, requestInit);
      } catch (error) {
        if (requestInit.signal?.aborted) {
          throw new HostedCofferArcError(0, "request was aborted");
        }
        if (attempt < this.maxAttempts) {
          await this.waitBeforeRetry(attempt);
          continue;
        }
        const message = isTimeoutError(error)
          ? `request timed out after ${this.requestTimeoutMs}ms`
          : `network request failed after ${this.maxAttempts} attempt${this.maxAttempts === 1 ? "" : "s"}`;
        throw new HostedCofferArcError(0, message);
      }

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return response.json() as Promise<T>;
      }

      if (isRetryableStatus(response.status) && attempt < this.maxAttempts) {
        await response.body?.cancel();
        await this.waitBeforeRetry(attempt);
        continue;
      }

      const message = response.status >= 500
        ? response.statusText || "temporary upstream error"
        : sanitizeErrorBody((await response.text()).slice(0, 2_000)) || response.statusText;
      throw new HostedCofferArcError(response.status, message || "request rejected");
    }

    throw new HostedCofferArcError(0, "request failed");
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(init.signal?.reason);
    if (init.signal?.aborted) {
      abortFromCaller();
    } else {
      init.signal?.addEventListener("abort", abortFromCaller, { once: true });
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (timedOut) {
        throw new HostedCofferArcTimeoutError();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private async waitBeforeRetry(attempt: number): Promise<void> {
    const delayMs = Math.min(this.retryDelayMs * (2 ** (attempt - 1)), 5_000);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

class HostedCofferArcTimeoutError extends Error {
  constructor() {
    super("Hosted Coffer request timed out");
    this.name = "HostedCofferArcTimeoutError";
  }
}

export class HostedCofferArcError extends Error {
  constructor(readonly status: number, message: string) {
    super(`Hosted Coffer request failed (${status}): ${message}`);
    this.name = "HostedCofferArcError";
  }
}

export function parseHostedDecision(response: Record<string, unknown>): CofferArcDecision {
  const rawOutcome = String(response.outcome ?? "");
  if (rawOutcome !== "allow" && rawOutcome !== "block" && rawOutcome !== "requires_approval") {
    throw new Error("Hosted Coffer response has an invalid canonical outcome");
  }
  const outcome = rawOutcome as CofferArcDecisionOutcome;
  const spendRequestId = requiredResponseText(response.spendRequestId);
  const decisionId = requiredResponseText(response.decisionId);
  const spendDecisionRecordId = requiredResponseText(response.spendDecisionRecordId);
  if (!spendRequestId || !decisionId || !spendDecisionRecordId) {
    throw new Error("Hosted Coffer response is missing decision identifiers");
  }
  const settlementReference = optionalResponseText(response.paymentReference);
  return {
    outcome,
    spendRequestId,
    decisionId,
    spendDecisionRecordId,
    reasonCode: requiredResponseText(response.reasonCode) || "unknown",
    reason: requiredResponseText(response.reason) || "Coffer returned a spend decision.",
    settlementTxHash: extractTxHash(settlementReference)
  };
}

function extractTxHash(value: string): Hex | undefined {
  const match = /(?:^|:)(0x[a-fA-F0-9]{64})$/.exec(value.trim());
  return match?.[1] as Hex | undefined;
}

function requiredResponseText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalResponseText(value: unknown): string {
  return value === undefined || value === null ? "" : requiredResponseText(value);
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  const parsed = new URL(normalized);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("Hosted Coffer base URL must use HTTPS except on localhost");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("Hosted Coffer base URL must not include credentials or a fragment");
  }
  return normalized;
}

function normalizeUsdAmount(value: string): string {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error("amount must be a USD decimal with at most two fraction digits");
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  return `${BigInt(whole)}.${fraction.padEnd(2, "0")}`;
}

function requireText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must be non-empty, bounded text without control characters`);
  }
  return normalized;
}

function optionalText(value: string | undefined, label: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : requireText(value, label, maxLength);
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof HostedCofferArcTimeoutError;
}

function sanitizeErrorBody(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email redacted]")
    .replace(/\b(?:si|pd|sdr|sr|dec)[_-][A-Za-z0-9_-]{3,240}\b/gi, "[Coffer record id redacted]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
}

function requireTxHash(value: Hex): Hex {
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error("Arc transaction hash must be 32-byte hex");
  return value;
}
