import type { Address, Hex } from "viem";

export type CofferArcDecisionOutcome = "allow" | "block" | "requires_approval";

export type CofferArcSpendIntent = {
  agentId: string;
  agentName?: string;
  vendorId?: string;
  vendorName: string;
  recipient: Address;
  amount: string;
  businessPurpose: string;
  taskId: string;
  taskDescription?: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
};

export type CofferArcDecision = {
  outcome: CofferArcDecisionOutcome;
  spendRequestId: string;
  decisionId: string;
  spendDecisionRecordId: string;
  reasonCode: string;
  reason: string;
  settlementTxHash?: Hex;
};

export type CofferSettlementReport = {
  spendRequestId: string;
  amount: string;
  txHash: Hex;
  settledAt: string;
  metadata: Record<string, unknown>;
};

export interface CofferArcControlClient {
  requestDecision(intent: CofferArcSpendIntent): Promise<CofferArcDecision>;
  reportSettlement(report: CofferSettlementReport): Promise<void>;
}

export type ArcWriteResult = {
  provider: "circle_dev_controlled_eoa" | "viem_eoa" | "test";
  providerTransactionId?: string;
  txHash: Hex;
};

export type AnchorDecisionInput = {
  registryAddress: Address;
  commitment: Hex;
  outcome: CofferArcDecisionOutcome;
  operationId: string;
};

export type MemoUsdcTransferInput = {
  recipient: Address;
  amountMinor: bigint;
  memoId: Hex;
  memoData: Hex;
  operationId: string;
};

export interface ArcDecisionWriter {
  readonly sender: Address;
  anchorDecision(input: AnchorDecisionInput): Promise<ArcWriteResult>;
  transferUsdcWithMemo(input: MemoUsdcTransferInput): Promise<ArcWriteResult>;
}

export type DirectUsdcTransferInput = {
  recipient: Address;
  amountMinor: bigint;
  operationId: string;
};

export type ArcAgentWalletWriteResult = {
  provider: "circle_agent_wallet_cli";
  providerTransactionId: string;
  txHash: Hex;
};

export interface ArcAgentWalletWriter {
  readonly sender: Address;
  readonly maxAmountMinor: bigint;
  transferUsdc(input: DirectUsdcTransferInput): Promise<ArcAgentWalletWriteResult>;
}

export type ArcAnchorEvidence = {
  txHash: Hex;
  blockNumber: bigint;
  registryAddress: Address;
  operator: Address;
  commitment: Hex;
  outcome: CofferArcDecisionOutcome;
};

export type ArcSettlementEvidence = {
  txHash: Hex;
  blockNumber: bigint;
  sender: Address;
  recipient: Address;
  amountMinor: bigint;
  memoId: Hex;
  memoData: Hex;
  callDataHash: Hex;
};

export type ArcAgentWalletSettlementEvidence = {
  txHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  transactionIndex: number;
  transferLogIndex: number;
  transactionSender: Address;
  transactionTarget?: Address;
  sender: Address;
  senderCodeHash: Hex;
  recipient: Address;
  amountMinor: bigint;
  tokenAddress: Address;
  tokenCodeHash: Hex;
};

export interface ArcEvidenceVerifier {
  verifyRegistryState(input: {
    registryAddress: Address;
    operator: Address;
    commitment: Hex;
    outcome: CofferArcDecisionOutcome;
    fromBlock?: bigint;
  }): Promise<ArcAnchorEvidence>;
  verifyAnchor(input: {
    txHash: Hex;
    registryAddress: Address;
    operator: Address;
    commitment: Hex;
    outcome: CofferArcDecisionOutcome;
  }): Promise<ArcAnchorEvidence>;
  verifyMemoTransfer(input: {
    txHash: Hex;
    sender: Address;
    recipient: Address;
    amountMinor: bigint;
    memoId: Hex;
    memoData: Hex;
  }): Promise<ArcSettlementEvidence>;
};

export interface ArcAgentWalletEvidenceVerifier {
  verifyAgentWalletUsdcTransfer(input: {
    txHash: Hex;
    sender: Address;
    recipient: Address;
    amountMinor: bigint;
  }): Promise<ArcAgentWalletSettlementEvidence>;
}

export type GuardedArcTransferResult =
  | {
      state: "not_executed";
      decision: CofferArcDecision;
      reason: "blocked" | "requires_approval";
    }
  | {
      state: "settled";
      decision: CofferArcDecision;
      replayed: boolean;
      decisionCommitment: Hex;
      recordHash: Hex;
      anchor: ArcAnchorEvidence;
      settlement: ArcSettlementEvidence;
    };

export type GuardedArcTransferOptions = {
  controlClient: CofferArcControlClient;
  writer: ArcDecisionWriter;
  verifier: ArcEvidenceVerifier;
  registryAddress: Address;
  registryDeploymentBlock?: bigint;
  now?: () => Date;
};

export type GuardedAgentWalletTransferResult =
  | {
      state: "not_executed";
      decision: CofferArcDecision;
      reason: "blocked" | "requires_approval";
    }
  | {
      state: "settled";
      decision: CofferArcDecision;
      replayed: boolean;
      decisionCommitment: Hex;
      recordHash: Hex;
      settlement: ArcAgentWalletSettlementEvidence;
    };

/**
 * Internal-only result used while reporting Circle audit correlation to the
 * hosted control plane. Public executors must remove the provider reference.
 */
export type InternalGuardedAgentWalletTransferResult =
  | Extract<GuardedAgentWalletTransferResult, { state: "not_executed" }>
  | (Extract<GuardedAgentWalletTransferResult, { state: "settled" }> & {
      providerTransactionId?: string;
    });

export type GuardedAgentWalletTransferOptions = {
  controlClient: CofferArcControlClient;
  writer: ArcAgentWalletWriter;
  verifier: ArcAgentWalletEvidenceVerifier;
  now?: () => Date;
};
