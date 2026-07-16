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
