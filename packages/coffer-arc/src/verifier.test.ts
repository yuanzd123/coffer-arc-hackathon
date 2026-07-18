import { describe, expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  type Address,
  type Hex
} from "viem";
import { decisionRegistryAbi, memoAbi, usdcTransferAbi } from "./abis";
import { ARC_TESTNET_MEMO_ADDRESS, ARC_TESTNET_USDC_ADDRESS } from "./constants";
import { encodeUsdcTransfer } from "./encoding";
import { ViemArcEvidenceVerifier } from "./verifier";

const sender = "0x1111111111111111111111111111111111111111" as Address;
const recipient = "0x2222222222222222222222222222222222222222" as Address;
const registry = "0x3333333333333333333333333333333333333333" as Address;
const commitment = `0x${"a".repeat(64)}` as Hex;
const memoData = `0x${"b".repeat(64)}` as Hex;
const anchorHash = `0x${"c".repeat(64)}` as Hex;
const settlementHash = `0x${"d".repeat(64)}` as Hex;
const entryPoint = "0x4444444444444444444444444444444444444444" as Address;

describe("ViemArcEvidenceVerifier", () => {
  it("accepts only a matching DecisionAnchored receipt", async () => {
    const topics = encodeEventTopics({
      abi: decisionRegistryAbi,
      eventName: "DecisionAnchored",
      args: { commitment, outcome: 2, operator: sender }
    });
    const publicClient = fakePublicClient({
      from: sender,
      to: registry,
      logs: [{
        address: registry,
        topics,
        data: encodeAbiParameters([{ type: "uint64" }], [1_000n])
      }]
    });
    const verifier = new ViemArcEvidenceVerifier(publicClient as never);
    const evidence = await verifier.verifyAnchor({
      txHash: anchorHash,
      registryAddress: registry,
      operator: sender,
      commitment,
      outcome: "allow"
    });
    expect(evidence.blockNumber).toBe(123n);
    expect(evidence.commitment).toBe(commitment);
  });

  it("verifies the Memo and exact USDC transfer evidence", async () => {
    const amountMinor = 10_000n;
    const transferData = encodeUsdcTransfer(recipient, amountMinor);
    const memoTopics = encodeEventTopics({
      abi: memoAbi,
      eventName: "Memo",
      args: { sender, target: ARC_TESTNET_USDC_ADDRESS, memoId: commitment }
    });
    const transferTopics = encodeEventTopics({
      abi: usdcTransferAbi,
      eventName: "Transfer",
      args: { from: sender, to: recipient }
    });
    const publicClient = fakePublicClient({
      from: sender,
      to: ARC_TESTNET_MEMO_ADDRESS,
      logs: [
        {
          address: ARC_TESTNET_USDC_ADDRESS,
          topics: transferTopics,
          data: encodeAbiParameters([{ type: "uint256" }], [amountMinor])
        },
        {
          address: ARC_TESTNET_MEMO_ADDRESS,
          topics: memoTopics,
          data: encodeAbiParameters(
            [{ type: "bytes32" }, { type: "bytes" }, { type: "uint256" }],
            [keccak256(transferData), memoData, 7n]
          )
        }
      ]
    });
    const verifier = new ViemArcEvidenceVerifier(publicClient as never);
    const evidence = await verifier.verifyMemoTransfer({
      txHash: settlementHash,
      sender,
      recipient,
      amountMinor,
      memoId: commitment,
      memoData
    });
    expect(evidence.amountMinor).toBe(10_000n);
    expect(evidence.callDataHash).toBe(keccak256(transferData));
    expect(publicClient.getLogs).toHaveBeenCalledOnce();
  });

  it("rejects a receipt whose USDC amount differs from the approved amount", async () => {
    const approvedAmount = 10_000n;
    const transferData = encodeUsdcTransfer(recipient, approvedAmount);
    const publicClient = fakePublicClient({
      from: sender,
      to: ARC_TESTNET_MEMO_ADDRESS,
      logs: [
        {
          address: ARC_TESTNET_USDC_ADDRESS,
          topics: encodeEventTopics({
            abi: usdcTransferAbi,
            eventName: "Transfer",
            args: { from: sender, to: recipient }
          }),
          data: encodeAbiParameters([{ type: "uint256" }], [20_000n])
        },
        {
          address: ARC_TESTNET_MEMO_ADDRESS,
          topics: encodeEventTopics({
            abi: memoAbi,
            eventName: "Memo",
            args: { sender, target: ARC_TESTNET_USDC_ADDRESS, memoId: commitment }
          }),
          data: encodeAbiParameters(
            [{ type: "bytes32" }, { type: "bytes" }, { type: "uint256" }],
            [keccak256(transferData), memoData, 7n]
          )
        }
      ]
    });
    const verifier = new ViemArcEvidenceVerifier(publicClient as never);
    await expect(verifier.verifyMemoTransfer({
      txHash: settlementHash,
      sender,
      recipient,
      amountMinor: approvedAmount,
      memoId: commitment,
      memoData
    })).rejects.toThrow("Expected one matching Arc USDC Transfer event, found 0");
  });
});

describe("ViemArcEvidenceVerifier Agent Wallet lane", () => {
  it("preflights Arc chain identity plus the fixed USDC code and decimals", async () => {
    const publicClient = fakeAgentPublicClient([]);
    const verifier = new ViemArcEvidenceVerifier(publicClient as never);
    await expect(verifier.verifyAgentWalletPreflight()).resolves.toBeUndefined();
    expect(publicClient.getChainId).toHaveBeenCalledOnce();
    expect(publicClient.getCode).toHaveBeenCalledOnce();
    expect(publicClient.readContract).toHaveBeenCalledOnce();
  });

  it("reports deployed Agent Wallet readiness from one Arc block", async () => {
    const publicClient = fakeAgentReadinessClient();
    const verifier = new ViemArcEvidenceVerifier(publicClient as never);

    await expect(verifier.inspectAgentWalletReadiness({
      sender,
      requiredAmountMinor: 10_000n
    })).resolves.toEqual({
      status: "ready_deployed",
      network: "ARC-TESTNET",
      chainId: 5_042_002,
      observedBlockNumber: 789n,
      agentWalletAddress: sender,
      tokenAddress: ARC_TESTNET_USDC_ADDRESS,
      tokenDecimals: 6,
      tokenCodeHash: keccak256("0x6001600055"),
      usdcBalanceMinor: 20_000_000n,
      requiredAmountMinor: 10_000n,
      nativeBalanceWei: 0n,
      senderCodePresent: true,
      senderCodeHash: keccak256("0x6002600055")
    });
    expect(publicClient.getCode).toHaveBeenNthCalledWith(1, {
      address: ARC_TESTNET_USDC_ADDRESS,
      blockNumber: 789n
    });
    expect(publicClient.getCode).toHaveBeenNthCalledWith(2, {
      address: sender,
      blockNumber: 789n
    });
  });

  it("marks counterfactual code explicitly and rejects an underfunded wallet", async () => {
    const counterfactualClient = fakeAgentReadinessClient({ senderCode: "0x" });
    const verifier = new ViemArcEvidenceVerifier(counterfactualClient as never);
    const result = await verifier.inspectAgentWalletReadiness({ sender, requiredAmountMinor: 10_000n });
    expect(result.status).toBe("counterfactual_requires_human_checkpoint");
    expect(result.senderCodePresent).toBe(false);
    expect(result.senderCodeHash).toBeNull();

    const underfundedClient = fakeAgentReadinessClient({ usdcBalanceMinor: 9_999n });
    await expect(new ViemArcEvidenceVerifier(underfundedClient as never).inspectAgentWalletReadiness({
      sender,
      requiredAmountMinor: 10_000n
    })).rejects.toThrow("below the fixed proof amount");
  });

  it("accepts an exact claimed contract debit without requiring receipt.from to equal that contract", async () => {
    const publicClient = fakeAgentPublicClient([{ from: sender, to: recipient, value: 10_000n }]);
    const verifier = new ViemArcEvidenceVerifier(publicClient as never);
    const evidence = await verifier.verifyAgentWalletUsdcTransfer({
      txHash: settlementHash,
      sender,
      recipient,
      amountMinor: 10_000n
    });

    expect(evidence.sender).toBe(sender);
    expect(evidence.transactionSender).toBe(entryPoint);
    expect(evidence.transactionTarget).toBe(entryPoint);
    expect(evidence.transferLogIndex).toBe(0);
    expect(evidence.amountMinor).toBe(10_000n);
    expect(publicClient.getCode).toHaveBeenCalledTimes(2);
  });

  it("rejects any second USDC debit from the same Agent Wallet in the receipt", async () => {
    const publicClient = fakeAgentPublicClient([
      { from: sender, to: recipient, value: 10_000n },
      { from: sender, to: entryPoint, value: 1n }
    ]);
    const verifier = new ViemArcEvidenceVerifier(publicClient as never);
    await expect(verifier.verifyAgentWalletUsdcTransfer({
      txHash: settlementHash,
      sender,
      recipient,
      amountMinor: 10_000n
    })).rejects.toThrow("Expected exactly one Agent Wallet Arc USDC debit, found 2");
  });

  it("rejects an address without contract bytecode even when a matching Transfer log exists", async () => {
    const publicClient = fakeAgentPublicClient(
      [{ from: sender, to: recipient, value: 10_000n }],
      { senderCode: "0x" }
    );
    const verifier = new ViemArcEvidenceVerifier(publicClient as never);
    await expect(verifier.verifyAgentWalletUsdcTransfer({
      txHash: settlementHash,
      sender,
      recipient,
      amountMinor: 10_000n
    })).rejects.toThrow("has no deployed contract bytecode");
  });
});

function fakePublicClient(receipt: {
  from: Address;
  to: Address;
  logs: Array<{ address: Address; topics: readonly unknown[]; data: Hex }>;
}) {
  const transactionHash = receipt.to === registry ? anchorHash : settlementHash;
  const receiptLogs = receipt.logs.map((log, logIndex) => ({
    ...log,
    blockNumber: 123n,
    transactionHash,
    transactionIndex: 0,
    blockHash: `0x${"e".repeat(64)}` as Hex,
    logIndex,
    removed: false
  }));
  return {
    getTransactionReceipt: vi.fn(async () => ({
      status: "success",
      blockNumber: 123n,
      from: receipt.from,
      to: receipt.to,
      logs: receiptLogs
    })),
    readContract: vi.fn(async (input: { functionName: string }) => input.functionName === "operator"
      ? sender
      : { exists: true, outcome: 2, anchoredAtBlock: 123n }),
    getLogs: vi.fn(async () => [{
      address: receipt.to,
      blockNumber: 123n,
      transactionHash,
      logIndex: receipt.to === registry ? 0 : 1
    }])
  };
}

function fakeAgentPublicClient(
  transfers: Array<{ from: Address; to: Address; value: bigint }>,
  options: { senderCode?: Hex } = {}
) {
  const agentBlockHash = `0x${"f".repeat(64)}` as Hex;
  const tokenCode = "0x6001600055" as Hex;
  const senderCode = options.senderCode ?? ("0x6002600055" as Hex);
  const logs = transfers.map((transfer, logIndex) => ({
    address: ARC_TESTNET_USDC_ADDRESS,
    topics: encodeEventTopics({
      abi: usdcTransferAbi,
      eventName: "Transfer",
      args: { from: transfer.from, to: transfer.to }
    }),
    data: encodeAbiParameters([{ type: "uint256" }], [transfer.value]),
    blockNumber: 456n,
    transactionHash: settlementHash,
    transactionIndex: 7,
    blockHash: agentBlockHash,
    logIndex,
    removed: false
  }));
  return {
    getChainId: vi.fn(async () => 5_042_002),
    getBlockNumber: vi.fn(async () => 456n),
    getTransactionReceipt: vi.fn(async () => ({
      status: "success",
      transactionHash: settlementHash,
      blockNumber: 456n,
      blockHash: agentBlockHash,
      transactionIndex: 7,
      from: entryPoint,
      to: entryPoint,
      logs
    })),
    getTransaction: vi.fn(async () => ({
      hash: settlementHash,
      blockNumber: 456n,
      blockHash: agentBlockHash,
      transactionIndex: 7
    })),
    getCode: vi.fn(async ({ address }: { address: Address }) =>
      address.toLowerCase() === ARC_TESTNET_USDC_ADDRESS.toLowerCase() ? tokenCode : senderCode
    ),
    readContract: vi.fn(async () => 6),
    getLogs: vi.fn(async () => [{
      transactionHash: settlementHash,
      logIndex: 0,
      args: { value: 10_000n }
    }])
  };
}

function fakeAgentReadinessClient(options: {
  senderCode?: Hex;
  usdcBalanceMinor?: bigint;
  chainId?: number;
  decimals?: number;
  tokenCode?: Hex;
} = {}) {
  const tokenCode = options.tokenCode ?? ("0x6001600055" as Hex);
  const senderCode = options.senderCode ?? ("0x6002600055" as Hex);
  return {
    getChainId: vi.fn(async () => options.chainId ?? 5_042_002),
    getBlockNumber: vi.fn(async () => 789n),
    getCode: vi.fn(async ({ address }: { address: Address }) =>
      address.toLowerCase() === ARC_TESTNET_USDC_ADDRESS.toLowerCase() ? tokenCode : senderCode
    ),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === "decimals" ? (options.decimals ?? 6) : (options.usdcBalanceMinor ?? 20_000_000n)
    ),
    getBalance: vi.fn(async () => 0n)
  };
}
