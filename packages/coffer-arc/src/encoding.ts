import { encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { decisionRegistryAbi, memoAbi, usdcTransferAbi } from "./abis";
import { ARC_TESTNET_MEMO_ADDRESS, ARC_TESTNET_USDC_ADDRESS } from "./constants";
import { decisionOutcomeCode } from "./commitment";
import type { AnchorDecisionInput, MemoUsdcTransferInput } from "./types";

export function encodeDecisionAnchor(input: Pick<AnchorDecisionInput, "commitment" | "outcome">): Hex {
  return encodeFunctionData({
    abi: decisionRegistryAbi,
    functionName: "anchorDecision",
    args: [input.commitment, decisionOutcomeCode(input.outcome)]
  });
}

export function encodeUsdcTransfer(recipient: Address, amountMinor: bigint): Hex {
  if (amountMinor <= 0n) throw new Error("USDC transfer amount must be greater than zero");
  return encodeFunctionData({
    abi: usdcTransferAbi,
    functionName: "transfer",
    args: [recipient, amountMinor]
  });
}

export function encodeMemoUsdcTransfer(input: Pick<MemoUsdcTransferInput, "recipient" | "amountMinor" | "memoId" | "memoData">): {
  memoAddress: Address;
  usdcAddress: Address;
  transferData: Hex;
  transferCallDataHash: Hex;
  memoCallData: Hex;
} {
  const transferData = encodeUsdcTransfer(input.recipient, input.amountMinor);
  const memoCallData = encodeFunctionData({
    abi: memoAbi,
    functionName: "memo",
    args: [ARC_TESTNET_USDC_ADDRESS, transferData, input.memoId, input.memoData]
  });
  return {
    memoAddress: ARC_TESTNET_MEMO_ADDRESS,
    usdcAddress: ARC_TESTNET_USDC_ADDRESS,
    transferData,
    transferCallDataHash: keccak256(transferData),
    memoCallData
  };
}
