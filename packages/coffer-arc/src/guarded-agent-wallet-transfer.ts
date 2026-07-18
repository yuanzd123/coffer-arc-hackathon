import { getAddress, zeroAddress } from "viem";
import {
  buildDecisionCommitment,
  deterministicCircleOperationId,
  hashPublicRecordId,
  parseUsdAmountToUsdcMinor
} from "./commitment";
import { ARC_TESTNET_MEMO_ADDRESS, ARC_TESTNET_USDC_ADDRESS } from "./constants";
import type {
  CofferArcSpendIntent,
  GuardedAgentWalletTransferOptions,
  InternalGuardedAgentWalletTransferResult
} from "./types";

/**
 * Coffer-first guard for Circle Agent Wallet SCA transfers.
 *
 * This is intentionally separate from the EOA Registry + Memo path: Arc's
 * Memo contract requires an EOA as its direct caller and does not support an
 * SCA in that role. The deployed Registry operator is also the dedicated EOA.
 * The commitment below is therefore an off-chain correlation value; the exact
 * on-chain proof is contract bytecode at the claimed sender plus the exact
 * USDC Transfer event verified after the CLI returns. Circle/ERC-4337 identity
 * remains a separate runner-attested claim.
 */
export class CofferGuardedAgentWalletTransfer {
  private readonly now: () => Date;

  constructor(private readonly options: GuardedAgentWalletTransferOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async execute(intent: CofferArcSpendIntent): Promise<InternalGuardedAgentWalletTransferResult> {
    const recipient = getAddress(intent.recipient);
    const forbiddenRecipients = new Set([
      zeroAddress.toLowerCase(),
      this.options.writer.sender.toLowerCase(),
      ARC_TESTNET_MEMO_ADDRESS.toLowerCase(),
      ARC_TESTNET_USDC_ADDRESS.toLowerCase()
    ]);
    if (forbiddenRecipients.has(recipient.toLowerCase())) {
      throw new Error("Agent Wallet recipient must be an external fixed payment address");
    }
    const amountMinor = parseUsdAmountToUsdcMinor(intent.amount);
    if (amountMinor <= 0n) throw new Error("Agent Wallet settlement amount must be greater than zero");
    const decision = await this.options.controlClient.requestDecision({ ...intent, recipient });

    if (decision.outcome !== "allow") {
      return {
        state: "not_executed",
        decision,
        reason: decision.outcome === "requires_approval" ? "requires_approval" : "blocked"
      };
    }
    if (amountMinor > this.options.writer.maxAmountMinor) {
      throw new Error("Agent Wallet settlement amount exceeds the configured hard cap");
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
      const settlement = await this.options.verifier.verifyAgentWalletUsdcTransfer({
        txHash: decision.settlementTxHash,
        sender: this.options.writer.sender,
        recipient,
        amountMinor
      });
      return {
        state: "settled",
        decision,
        replayed: true,
        decisionCommitment,
        recordHash,
        settlement
      };
    }

    const settlementWrite = await this.options.writer.transferUsdc({
      recipient,
      amountMinor,
      operationId: deterministicCircleOperationId(decisionCommitment, "agent-wallet-settle")
    });
    if (settlementWrite.provider !== "circle_agent_wallet_cli") {
      throw new Error("Agent Wallet guard received an unsupported execution provider");
    }
    const settlement = await this.options.verifier.verifyAgentWalletUsdcTransfer({
      txHash: settlementWrite.txHash,
      sender: this.options.writer.sender,
      recipient,
      amountMinor
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
        assetAddress: ARC_TESTNET_USDC_ADDRESS,
        walletType: "Circle Agent Wallet SCA",
        sender: settlement.sender,
        senderCodeHash: settlement.senderCodeHash,
        recipient: settlement.recipient,
        decisionCommitment,
        recordHash,
        commitmentBinding: "offchain_correlation_only_no_arc_memo",
        settlementBlockNumber: settlement.blockNumber.toString(),
        transactionSender: settlement.transactionSender,
        transactionTarget: settlement.transactionTarget,
        executionProvider: settlementWrite.provider,
        providerTransactionId: settlementWrite.providerTransactionId,
        evidence: "exact_arc_usdc_debit_and_claimed_sender_contract_code"
      }
    });

    return {
      state: "settled",
      decision,
      replayed: false,
      decisionCommitment,
      recordHash,
      settlement,
      providerTransactionId: settlementWrite.providerTransactionId
    };
  }
}
