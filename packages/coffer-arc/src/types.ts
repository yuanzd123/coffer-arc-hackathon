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
