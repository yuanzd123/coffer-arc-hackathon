import { createRequire } from "node:module";
import type { CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { getAddress, type Address, type Hex } from "viem";
import { ARC_TESTNET_MEMO_ADDRESS } from "./constants";
import { encodeDecisionAnchor, encodeMemoUsdcTransfer } from "./encoding";
import type {
  AnchorDecisionInput,
  ArcDecisionWriter,
  ArcWriteResult,
  MemoUsdcTransferInput
} from "./types";

export type CircleArcWriterOptions = {
  apiKey: string;
  entitySecret: string;
  walletId: string;
  walletAddress: Address;
  pollingIntervalMs?: number;
  timeoutMs?: number;
  client?: CircleDeveloperControlledWalletsClient;
};

export class CircleArcWriter implements ArcDecisionWriter {
  readonly sender: Address;
  private readonly walletId: string;
  private readonly pollingIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly client: CircleDeveloperControlledWalletsClient;

  constructor(options: CircleArcWriterOptions) {
    this.sender = getAddress(options.walletAddress);
    this.walletId = requireIdentifier(options.walletId, "Circle wallet id");
    this.pollingIntervalMs = options.pollingIntervalMs ?? 1_500;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.client = options.client ?? circleWalletsSdk.initiateDeveloperControlledWalletsClient({
      apiKey: requireSecret(options.apiKey, "Circle API key"),
      entitySecret: requireSecret(options.entitySecret, "Circle entity secret")
    });
  }

  async anchorDecision(input: AnchorDecisionInput): Promise<ArcWriteResult> {
    return this.submitContractExecution({
      contractAddress: input.registryAddress,
      callData: encodeDecisionAnchor(input),
      operationId: input.operationId,
      refId: `coffer-anchor-${input.commitment.slice(2, 18)}`
    });
  }

  async transferUsdcWithMemo(input: MemoUsdcTransferInput): Promise<ArcWriteResult> {
    const encoded = encodeMemoUsdcTransfer(input);
    return this.submitContractExecution({
      contractAddress: ARC_TESTNET_MEMO_ADDRESS,
      callData: encoded.memoCallData,
      operationId: input.operationId,
      refId: `coffer-settle-${input.memoId.slice(2, 18)}`
    });
  }

  private async submitContractExecution(input: {
    contractAddress: Address;
    callData: Hex;
    operationId: string;
    refId: string;
  }): Promise<ArcWriteResult> {
    const submitted = await this.client.createContractExecutionTransaction({
      walletId: this.walletId,
      contractAddress: input.contractAddress,
      callData: input.callData,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey: requireUuidV4(input.operationId),
      refId: input.refId
    });
    const transactionId = submitted.data?.id;
    if (!transactionId) throw new Error("Circle did not return a transaction id");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Circle transaction polling timed out")), this.timeoutMs);
    try {
      const completed = await this.client.getTransaction({
        id: transactionId,
        waitForState: "COMPLETE",
        pollingInterval: this.pollingIntervalMs,
        signal: controller.signal
      });
      const txHash = completed.data?.transaction?.txHash;
      if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
        throw new Error("Circle completed the transaction without a valid Arc transaction hash");
      }
      return {
        provider: "circle_dev_controlled_eoa",
        providerTransactionId: transactionId,
        txHash: txHash as Hex
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// The Circle package currently publishes its ESM build as .js without declaring
// `type: module`. Loading its documented CJS export avoids Node treating that
// ESM file as CommonJS and dropping named exports.
const circleWalletsSdk = createRequire(import.meta.url)("@circle-fin/developer-controlled-wallets") as {
  initiateDeveloperControlledWalletsClient(input: {
    apiKey: string;
    entitySecret: string;
  }): CircleDeveloperControlledWalletsClient;
};

function requireUuidV4(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error("Circle operation id must be a UUIDv4");
  }
  return normalized;
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function requireSecret(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length < 16 || normalized.length > 2_000) throw new Error(`${label} is missing or invalid`);
  return normalized;
}
