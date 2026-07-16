import { getAddress } from "viem";
import {
  buildDecisionCommitment,
  deterministicCircleOperationId,
  hashPublicRecordId,
  parseUsdAmountToUsdcMinor
} from "./commitment";
import type {
  CofferArcSpendIntent,
  GuardedArcTransferOptions,
  GuardedArcTransferResult
} from "./types";

export class CofferGuardedArcTransfer {
  private readonly now: () => Date;

  constructor(private readonly options: GuardedArcTransferOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async execute(intent: CofferArcSpendIntent): Promise<GuardedArcTransferResult> {
    const recipient = getAddress(intent.recipient);
    const amountMinor = parseUsdAmountToUsdcMinor(intent.amount);
    if (amountMinor <= 0n) throw new Error("Arc settlement amount must be greater than zero");
    const decision = await this.options.controlClient.requestDecision({ ...intent, recipient });

    if (decision.outcome !== "allow") {
      return {
        state: "not_executed",
        decision,
        reason: decision.outcome === "requires_approval" ? "requires_approval" : "blocked"
      };
    }

    const decisionCommitment = buildDecisionCommitment({
      spendRequestId: decision.spendRequestId,
      decisionId: decision.decisionId,
      spendDecisionRecordId: decision.spendDecisionRecordId,
      outcome: decision.outcome,
      agentId: intent.agentId,
      recipient,
      amountMinor,
      idempotencyKey: intent.idempotencyKey
    });
    const recordHash = hashPublicRecordId(decision.spendDecisionRecordId);

    if (decision.settlementTxHash) {
      const anchor = await this.options.verifier.verifyRegistryState({
        registryAddress: this.options.registryAddress,
        operator: this.options.writer.sender,
        commitment: decisionCommitment,
        outcome: "allow",
        fromBlock: this.options.registryDeploymentBlock
      });
      const settlement = await this.options.verifier.verifyMemoTransfer({
        txHash: decision.settlementTxHash,
        sender: this.options.writer.sender,
        recipient,
        amountMinor,
        memoId: decisionCommitment,
        memoData: recordHash
      });
      return {
        state: "settled",
        decision,
        replayed: true,
        decisionCommitment,
        recordHash,
        anchor,
        settlement
      };
    }

    const anchorWrite = await this.options.writer.anchorDecision({
      registryAddress: this.options.registryAddress,
      commitment: decisionCommitment,
      outcome: "allow",
      operationId: deterministicCircleOperationId(decisionCommitment, "anchor")
    });
    const anchor = await this.options.verifier.verifyAnchor({
      txHash: anchorWrite.txHash,
      registryAddress: this.options.registryAddress,
      operator: this.options.writer.sender,
      commitment: decisionCommitment,
      outcome: "allow"
    });

    const settlementWrite = await this.options.writer.transferUsdcWithMemo({
      recipient,
      amountMinor,
      memoId: decisionCommitment,
      memoData: recordHash,
      operationId: deterministicCircleOperationId(decisionCommitment, "settle")
    });
    const settlement = await this.options.verifier.verifyMemoTransfer({
      txHash: settlementWrite.txHash,
      sender: this.options.writer.sender,
      recipient,
      amountMinor,
      memoId: decisionCommitment,
      memoData: recordHash
    });

    await this.options.controlClient.reportSettlement({
      spendRequestId: decision.spendRequestId,
      amount: intent.amount,
      txHash: settlement.txHash,
      settledAt: this.now().toISOString(),
      metadata: {
        chain: "Arc Testnet",
        network: "ARC-TESTNET",
        asset: "USDC",
        sender: this.options.writer.sender,
        recipient,
        decisionCommitment,
        recordHash,
        registryAddress: this.options.registryAddress,
        anchorTxHash: anchor.txHash,
        anchorBlockNumber: anchor.blockNumber.toString(),
        memoId: settlement.memoId,
        memoData: settlement.memoData,
        memoCallDataHash: settlement.callDataHash,
        settlementBlockNumber: settlement.blockNumber.toString(),
        executionProvider: settlementWrite.provider,
        providerTransactionId: settlementWrite.providerTransactionId
      }
    });

    return {
      state: "settled",
      decision,
      replayed: false,
      decisionCommitment,
      recordHash,
      anchor,
      settlement
    };
  }
}
