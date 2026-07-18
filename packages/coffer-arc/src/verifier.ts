import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  keccak256,
  parseAbiItem,
  type Address,
  type Hex
} from "viem";
import { arcTestnet } from "viem/chains";
import { decisionRegistryAbi, memoAbi, usdcTransferAbi } from "./abis";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_MEMO_ADDRESS,
  ARC_TESTNET_RPC_URL,
  ARC_TESTNET_USDC_ADDRESS
} from "./constants";
import { decisionOutcomeCode } from "./commitment";
import { encodeUsdcTransfer } from "./encoding";
import type {
  ArcAgentWalletEvidenceVerifier,
  ArcAgentWalletSettlementEvidence,
  ArcAnchorEvidence,
  ArcEvidenceVerifier,
  ArcSettlementEvidence,
  CofferArcDecisionOutcome
} from "./types";

export function createArcPublicClient(rpcUrl = ARC_TESTNET_RPC_URL) {
  return createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl, { retryCount: 4, retryDelay: 500 })
  });
}

export type ArcPublicClient = ReturnType<typeof createArcPublicClient>;

export type ArcAgentWalletReadiness = {
  status: "ready_deployed" | "counterfactual_requires_human_checkpoint";
  network: "ARC-TESTNET";
  chainId: number;
  observedBlockNumber: bigint;
  agentWalletAddress: Address;
  tokenAddress: Address;
  tokenDecimals: 6;
  tokenCodeHash: Hex;
  usdcBalanceMinor: bigint;
  requiredAmountMinor: bigint;
  nativeBalanceWei: bigint;
  senderCodePresent: boolean;
  senderCodeHash: Hex | null;
};

const usdcMetadataAbi = [{
  type: "function",
  name: "decimals",
  stateMutability: "view",
  inputs: [],
  outputs: [{ name: "", type: "uint8" }]
}, {
  type: "function",
  name: "balanceOf",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "", type: "uint256" }]
}] as const;

export class ViemArcEvidenceVerifier implements ArcEvidenceVerifier, ArcAgentWalletEvidenceVerifier {
  constructor(private readonly publicClient: ArcPublicClient = createArcPublicClient()) {}

  async verifyNetwork(registryAddress?: Address): Promise<void> {
    const chainId = await this.publicClient.getChainId();
    if (chainId !== ARC_TESTNET_CHAIN_ID) throw new Error(`Expected Arc Testnet chain ${ARC_TESTNET_CHAIN_ID}, received ${chainId}`);
    const addresses = [ARC_TESTNET_MEMO_ADDRESS, ARC_TESTNET_USDC_ADDRESS, registryAddress].filter(
      (value): value is Address => Boolean(value)
    );
    for (const address of addresses) {
      const code = await this.publicClient.getCode({ address });
      if (!code || code === "0x") throw new Error(`Required Arc contract is not deployed at ${address}`);
    }
  }

  async verifyAgentWalletPreflight(): Promise<void> {
    await this.readAgentWalletNetworkState();
  }

  async inspectAgentWalletReadiness(input: {
    sender: Address;
    requiredAmountMinor: bigint;
  }): Promise<ArcAgentWalletReadiness> {
    const sender = getAddress(input.sender);
    if (input.requiredAmountMinor <= 0n) {
      throw new Error("Agent Wallet readiness amount must be greater than zero");
    }
    const network = await this.readAgentWalletNetworkState();
    const [rawBalance, senderCode, nativeBalanceWei] = await Promise.all([
      this.publicClient.readContract({
        address: ARC_TESTNET_USDC_ADDRESS,
        abi: usdcMetadataAbi,
        functionName: "balanceOf",
        args: [sender],
        blockNumber: network.blockNumber
      }),
      this.publicClient.getCode({ address: sender, blockNumber: network.blockNumber }),
      this.publicClient.getBalance({ address: sender, blockNumber: network.blockNumber })
    ]);
    const usdcBalanceMinor = BigInt(rawBalance);
    if (usdcBalanceMinor < input.requiredAmountMinor) {
      throw new Error("Agent Wallet Arc USDC balance is below the fixed proof amount");
    }
    const senderCodePresent = Boolean(senderCode && senderCode !== "0x");
    return {
      status: senderCodePresent ? "ready_deployed" : "counterfactual_requires_human_checkpoint",
      network: "ARC-TESTNET",
      chainId: network.chainId,
      observedBlockNumber: network.blockNumber,
      agentWalletAddress: sender,
      tokenAddress: getAddress(ARC_TESTNET_USDC_ADDRESS),
      tokenDecimals: 6,
      tokenCodeHash: keccak256(network.tokenCode),
      usdcBalanceMinor,
      requiredAmountMinor: input.requiredAmountMinor,
      nativeBalanceWei,
      senderCodePresent,
      senderCodeHash: senderCodePresent ? keccak256(senderCode as Hex) : null
    };
  }

  private async readAgentWalletNetworkState(): Promise<{
    chainId: number;
    blockNumber: bigint;
    tokenCode: Hex;
  }> {
    const chainId = await this.publicClient.getChainId();
    if (chainId !== ARC_TESTNET_CHAIN_ID) {
      throw new Error(`Expected Arc Testnet chain ${ARC_TESTNET_CHAIN_ID}, received ${chainId}`);
    }
    const blockNumber = await this.publicClient.getBlockNumber();
    const tokenCode = await this.publicClient.getCode({
      address: ARC_TESTNET_USDC_ADDRESS,
      blockNumber
    });
    if (!tokenCode || tokenCode === "0x") {
      throw new Error("Arc USDC contract is not deployed at the expected address");
    }
    const decimals = await this.publicClient.readContract({
      address: ARC_TESTNET_USDC_ADDRESS,
      abi: usdcMetadataAbi,
      functionName: "decimals",
      blockNumber
    });
    if (Number(decimals) !== 6) throw new Error("Arc USDC decimals mismatch");
    return { chainId, blockNumber, tokenCode };
  }

  async verifyRegistryState(input: {
    registryAddress: Address;
    operator: Address;
    commitment: Hex;
    outcome: CofferArcDecisionOutcome;
    fromBlock?: bigint;
  }): Promise<ArcAnchorEvidence> {
    const configuredOperator = await this.publicClient.readContract({
      address: input.registryAddress,
      abi: decisionRegistryAbi,
      functionName: "operator"
    });
    if (getAddress(configuredOperator) !== getAddress(input.operator)) {
      throw new Error("Decision registry operator does not match the configured wallet");
    }

    const rawDecision = await this.publicClient.readContract({
      address: input.registryAddress,
      abi: decisionRegistryAbi,
      functionName: "getDecision",
      args: [input.commitment]
    });
    const decision = parseRegistryDecision(rawDecision);
    if (!decision.exists) throw new Error("Decision commitment is not anchored in the registry");
    if (decision.outcome !== decisionOutcomeCode(input.outcome)) throw new Error("Registry decision outcome mismatch");

    const decisionEvent = parseAbiItem(
      "event DecisionAnchored(bytes32 indexed commitment,uint8 indexed outcome,address indexed operator,uint64 anchoredAtBlock)"
    );
    const matchingLogs = await this.publicClient.getLogs({
      address: input.registryAddress,
      event: decisionEvent,
      args: {
        commitment: input.commitment,
        outcome: decisionOutcomeCode(input.outcome),
        operator: input.operator
      },
      fromBlock: input.fromBlock ?? 0n,
      toBlock: "latest"
    });
    const exactLogs = matchingLogs.filter((log) =>
      log.transactionHash && log.blockNumber === decision.anchoredAtBlock
    );
    if (exactLogs.length !== 1) {
      throw new Error(`Expected one registry anchor event for the stored decision, found ${exactLogs.length}`);
    }
    const anchorLog = exactLogs[0];
    if (!anchorLog?.transactionHash) throw new Error("Registry anchor event is missing its transaction hash");

    return {
      txHash: anchorLog.transactionHash,
      blockNumber: decision.anchoredAtBlock,
      registryAddress: getAddress(input.registryAddress),
      operator: getAddress(input.operator),
      commitment: input.commitment,
      outcome: input.outcome
    };
  }

  async verifyAnchor(input: {
    txHash: Hex;
    registryAddress: Address;
    operator: Address;
    commitment: Hex;
    outcome: CofferArcDecisionOutcome;
  }): Promise<ArcAnchorEvidence> {
    const receipt = await this.publicClient.getTransactionReceipt({ hash: input.txHash });
    if (receipt.status !== "success") throw new Error(`Decision anchor transaction reverted: ${input.txHash}`);
    if (getAddress(receipt.from) !== getAddress(input.operator)) throw new Error("Decision anchor sender does not match the configured operator");
    if (!receipt.to || getAddress(receipt.to) !== getAddress(input.registryAddress)) {
      throw new Error("Decision anchor transaction target does not match the registry");
    }

    const matching = receipt.logs
      .filter((log) => getAddress(log.address) === getAddress(input.registryAddress))
      .flatMap((log) => {
        try {
          const decoded = decodeEventLog({ abi: decisionRegistryAbi, data: log.data, topics: log.topics });
          return decoded.eventName === "DecisionAnchored" ? [decoded] : [];
        } catch {
          return [];
        }
      });
    if (matching.length !== 1) throw new Error(`Expected one DecisionAnchored event, found ${matching.length}`);
    const args = matching[0]?.args as {
      commitment: Hex;
      outcome: number;
      operator: Address;
      anchoredAtBlock: bigint;
    };
    if (args.commitment.toLowerCase() !== input.commitment.toLowerCase()) throw new Error("Anchored decision commitment mismatch");
    if (Number(args.outcome) !== decisionOutcomeCode(input.outcome)) throw new Error("Anchored decision outcome mismatch");
    if (getAddress(args.operator) !== getAddress(input.operator)) throw new Error("Anchored decision operator mismatch");
    const stateEvidence = await this.verifyRegistryState({
      registryAddress: input.registryAddress,
      operator: input.operator,
      commitment: input.commitment,
      outcome: input.outcome,
      fromBlock: receipt.blockNumber
    });
    if (stateEvidence.txHash.toLowerCase() !== input.txHash.toLowerCase()) {
      throw new Error("Registry state event transaction does not match the anchor receipt");
    }
    return stateEvidence;
  }

  async verifyMemoTransfer(input: {
    txHash: Hex;
    sender: Address;
    recipient: Address;
    amountMinor: bigint;
    memoId: Hex;
    memoData: Hex;
  }): Promise<ArcSettlementEvidence> {
    const receipt = await this.publicClient.getTransactionReceipt({ hash: input.txHash });
    if (receipt.status !== "success") throw new Error(`Arc Memo transaction reverted: ${input.txHash}`);
    if (getAddress(receipt.from) !== getAddress(input.sender)) throw new Error("Arc Memo sender mismatch");
    if (!receipt.to || getAddress(receipt.to) !== getAddress(ARC_TESTNET_MEMO_ADDRESS)) {
      throw new Error("Arc Memo transaction target mismatch");
    }
    const transferData = encodeUsdcTransfer(input.recipient, input.amountMinor);
    const expectedCallDataHash = keccak256(transferData);

    const memoEvents = receipt.logs
      .filter((log) => getAddress(log.address) === getAddress(ARC_TESTNET_MEMO_ADDRESS))
      .flatMap((log) => {
        try {
          const decoded = decodeEventLog({ abi: memoAbi, data: log.data, topics: log.topics });
          return decoded.eventName === "Memo" ? [{ decoded, log }] : [];
        } catch {
          return [];
        }
      });
    if (memoEvents.length !== 1) throw new Error(`Expected one Arc Memo event, found ${memoEvents.length}`);
    const memoReceiptLog = memoEvents[0]?.log;
    const memoArgs = memoEvents[0]?.decoded.args as {
      sender: Address;
      target: Address;
      callDataHash: Hex;
      memoId: Hex;
      memo: Hex;
      memoIndex: bigint;
    };
    if (getAddress(memoArgs.sender) !== getAddress(input.sender)) throw new Error("Memo event sender mismatch");
    if (getAddress(memoArgs.target) !== getAddress(ARC_TESTNET_USDC_ADDRESS)) throw new Error("Memo event target is not Arc USDC");
    if (memoArgs.callDataHash.toLowerCase() !== expectedCallDataHash.toLowerCase()) throw new Error("Memo callDataHash mismatch");
    if (memoArgs.memoId.toLowerCase() !== input.memoId.toLowerCase()) throw new Error("Memo decision id mismatch");
    if (memoArgs.memo.toLowerCase() !== input.memoData.toLowerCase()) throw new Error("Memo record hash mismatch");

    const transferEvents = receipt.logs
      .filter((log) => getAddress(log.address) === getAddress(ARC_TESTNET_USDC_ADDRESS))
      .flatMap((log) => {
        try {
          const decoded = decodeEventLog({ abi: usdcTransferAbi, data: log.data, topics: log.topics });
          return decoded.eventName === "Transfer" ? [decoded] : [];
        } catch {
          return [];
        }
      })
      .filter((event) => {
        const args = event.args as { from: Address; to: Address; value: bigint };
        return getAddress(args.from) === getAddress(input.sender)
          && getAddress(args.to) === getAddress(input.recipient)
          && args.value === input.amountMinor;
      });
    if (transferEvents.length !== 1) throw new Error(`Expected one matching Arc USDC Transfer event, found ${transferEvents.length}`);

    const memoEvent = parseAbiItem(
      "event Memo(address indexed sender,address indexed target,bytes32 callDataHash,bytes32 indexed memoId,bytes memo,uint256 memoIndex)"
    );
    const indexedMatches = await this.publicClient.getLogs({
      address: ARC_TESTNET_MEMO_ADDRESS,
      event: memoEvent,
      args: {
        sender: input.sender,
        target: ARC_TESTNET_USDC_ADDRESS,
        memoId: input.memoId
      },
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber
    });
    const exactIndexedMatches = indexedMatches.filter((log) =>
      log.transactionHash?.toLowerCase() === input.txHash.toLowerCase() &&
      (memoReceiptLog?.logIndex === undefined || log.logIndex === memoReceiptLog.logIndex)
    );
    if (exactIndexedMatches.length !== 1) {
      throw new Error(`Expected one indexed Arc Memo event in the settlement transaction, found ${exactIndexedMatches.length}`);
    }

    return {
      txHash: input.txHash,
      blockNumber: receipt.blockNumber,
      sender: getAddress(input.sender),
      recipient: getAddress(input.recipient),
      amountMinor: input.amountMinor,
      memoId: input.memoId,
      memoData: input.memoData,
      callDataHash: expectedCallDataHash
    };
  }

  async verifyAgentWalletUsdcTransfer(input: {
    txHash: Hex;
    sender: Address;
    recipient: Address;
    amountMinor: bigint;
  }): Promise<ArcAgentWalletSettlementEvidence> {
    const sender = getAddress(input.sender);
    const recipient = getAddress(input.recipient);
    if (input.amountMinor <= 0n) throw new Error("Agent Wallet USDC amount must be greater than zero");

    const chainId = await this.publicClient.getChainId();
    if (chainId !== ARC_TESTNET_CHAIN_ID) {
      throw new Error(`Expected Arc Testnet chain ${ARC_TESTNET_CHAIN_ID}, received ${chainId}`);
    }
    const receipt = await this.publicClient.getTransactionReceipt({ hash: input.txHash });
    if (receipt.status !== "success") throw new Error(`Agent Wallet transaction reverted: ${input.txHash}`);
    if (receipt.transactionHash.toLowerCase() !== input.txHash.toLowerCase()) {
      throw new Error("Agent Wallet receipt transaction hash mismatch");
    }
    const transaction = await this.publicClient.getTransaction({ hash: input.txHash });
    if (transaction.hash.toLowerCase() !== input.txHash.toLowerCase()
      || transaction.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase()
      || transaction.blockNumber !== receipt.blockNumber
      || transaction.transactionIndex !== receipt.transactionIndex) {
      throw new Error("Agent Wallet transaction and receipt inclusion data mismatch");
    }

    const tokenCode = await this.publicClient.getCode({
      address: ARC_TESTNET_USDC_ADDRESS,
      blockNumber: receipt.blockNumber
    });
    if (!tokenCode || tokenCode === "0x") throw new Error("Arc USDC contract is not deployed at the expected address");
    const decimals = await this.publicClient.readContract({
      address: ARC_TESTNET_USDC_ADDRESS,
      abi: usdcMetadataAbi,
      functionName: "decimals",
      blockNumber: receipt.blockNumber
    });
    if (Number(decimals) !== 6) throw new Error("Arc USDC decimals mismatch");

    const senderCode = await this.publicClient.getCode({
      address: sender,
      blockNumber: receipt.blockNumber
    });
    if (!senderCode || senderCode === "0x") {
      throw new Error("Claimed Agent Wallet address has no deployed contract bytecode");
    }

    const parsedTransfers = receipt.logs
      .filter((log) => getAddress(log.address) === getAddress(ARC_TESTNET_USDC_ADDRESS))
      .flatMap((log) => {
        try {
          const decoded = decodeEventLog({ abi: usdcTransferAbi, data: log.data, topics: log.topics });
          return decoded.eventName === "Transfer" ? [{ decoded, log }] : [];
        } catch {
          return [];
        }
      });
    const senderDebits = parsedTransfers.filter(({ decoded }) => {
      const args = decoded.args as { from: Address; to: Address; value: bigint };
      return getAddress(args.from) === sender;
    });
    if (senderDebits.length !== 1) {
      throw new Error(`Expected exactly one Agent Wallet Arc USDC debit, found ${senderDebits.length}`);
    }
    const matching = senderDebits.filter(({ decoded }) => {
        const args = decoded.args as { from: Address; to: Address; value: bigint };
        return getAddress(args.to) === recipient
          && args.value === input.amountMinor;
      });
    if (matching.length !== 1) {
      throw new Error(`Expected one matching Agent Wallet Arc USDC Transfer event, found ${matching.length}`);
    }

    const transferEvent = parseAbiItem(
      "event Transfer(address indexed from,address indexed to,uint256 value)"
    );
    const indexedMatches = await this.publicClient.getLogs({
      address: ARC_TESTNET_USDC_ADDRESS,
      event: transferEvent,
      args: { from: sender, to: recipient },
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber
    });
    const receiptLog = matching[0]?.log;
    if (receiptLog?.logIndex === undefined) throw new Error("Agent Wallet Arc USDC Transfer log index is missing");
    const exactIndexedMatches = indexedMatches.filter((log) =>
      log.transactionHash?.toLowerCase() === input.txHash.toLowerCase()
      && (receiptLog?.logIndex === undefined || log.logIndex === receiptLog.logIndex)
      && (log.args?.value === undefined || log.args.value === input.amountMinor)
    );
    if (exactIndexedMatches.length !== 1) {
      throw new Error(`Expected one indexed Agent Wallet Arc USDC Transfer event, found ${exactIndexedMatches.length}`);
    }

    return {
      txHash: input.txHash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      transactionIndex: receipt.transactionIndex,
      transferLogIndex: receiptLog.logIndex,
      transactionSender: getAddress(receipt.from),
      ...(receipt.to ? { transactionTarget: getAddress(receipt.to) } : {}),
      sender,
      senderCodeHash: keccak256(senderCode),
      recipient,
      amountMinor: input.amountMinor,
      tokenAddress: getAddress(ARC_TESTNET_USDC_ADDRESS),
      tokenCodeHash: keccak256(tokenCode)
    };
  }
}

function parseRegistryDecision(value: unknown): { exists: boolean; outcome: number; anchoredAtBlock: bigint } {
  if (Array.isArray(value)) {
    const [exists, outcome, anchoredAtBlock] = value;
    return {
      exists: exists === true,
      outcome: Number(outcome),
      anchoredAtBlock: BigInt(String(anchoredAtBlock))
    };
  }
  const record = value as { exists?: unknown; outcome?: unknown; anchoredAtBlock?: unknown };
  return {
    exists: record?.exists === true,
    outcome: Number(record?.outcome),
    anchoredAtBlock: BigInt(String(record?.anchoredAtBlock))
  };
}
