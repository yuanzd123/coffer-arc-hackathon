import {
  encodeAbiParameters,
  getAddress,
  hexToBytes,
  keccak256,
  stringToHex,
  toHex,
  type Address,
  type Hex
} from "viem";
import { ARC_TESTNET_CHAIN_ID, COFFER_ARC_COMMITMENT_DOMAIN } from "./constants";
import type { CofferArcDecisionOutcome } from "./types";

const outcomeCodes: Record<CofferArcDecisionOutcome, number> = {
  block: 0,
  requires_approval: 1,
  allow: 2
};

export function decisionOutcomeCode(outcome: CofferArcDecisionOutcome): number {
  return outcomeCodes[outcome];
}

export function decisionOutcomeFromCode(value: number): CofferArcDecisionOutcome {
  if (value === 0) return "block";
  if (value === 1) return "requires_approval";
  if (value === 2) return "allow";
  throw new Error(`Unsupported decision outcome code: ${value}`);
}

export function parseUsdAmountToUsdcMinor(amount: string): bigint {
  const normalized = amount.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Coffer Arc amount must be a non-negative USD decimal with at most two fraction digits");
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(2, "0")) * 10_000n;
}

export function formatUsdcMinorAsUsd(amountMinor: bigint): string {
  if (amountMinor < 0n || amountMinor % 10_000n !== 0n) {
    throw new Error("Coffer amounts must resolve to whole cents");
  }
  const cents = amountMinor / 10_000n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export function hashPublicRecordId(value: string): Hex {
  const normalized = requireBoundedText(value, "record id", 240);
  return keccak256(stringToHex(normalized));
}

export function buildDecisionCommitment(input: {
  spendRequestId: string;
  decisionId: string;
  spendDecisionRecordId: string;
  outcome: CofferArcDecisionOutcome;
  agentId: string;
  recipient: Address;
  amountMinor: bigint;
  idempotencyKey: string;
}): Hex {
  if (input.amountMinor <= 0n) {
    throw new Error("Arc settlement amount must be greater than zero");
  }
  const encoded = encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint8" },
      { type: "bytes32" },
      { type: "address" },
      { type: "uint256" },
      { type: "bytes32" }
    ],
    [
      keccak256(stringToHex(COFFER_ARC_COMMITMENT_DOMAIN)),
      BigInt(ARC_TESTNET_CHAIN_ID),
      hashBoundedText(input.spendRequestId, "spend request id", 240),
      hashBoundedText(input.decisionId, "decision id", 240),
      hashBoundedText(input.spendDecisionRecordId, "spend decision record id", 240),
      decisionOutcomeCode(input.outcome),
      hashBoundedText(input.agentId, "agent id", 80),
      getAddress(input.recipient),
      input.amountMinor,
      hashBoundedText(input.idempotencyKey, "idempotency key", 240)
    ]
  );
  return keccak256(encoded);
}

export function deterministicCircleOperationId(commitment: Hex, operation: "anchor" | "settle"): string {
  const digest = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [commitment, keccak256(stringToHex(`coffer.arc.${operation}.v1`))]
    )
  );
  const bytes = hexToBytes(digest).slice(0, 16);
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error("Unable to derive Circle idempotency key");
  }
  bytes[6] = (versionByte & 0x0f) | 0x40;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = toHex(bytes).slice(2);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hashBoundedText(value: string, label: string, maxLength: number): Hex {
  return keccak256(stringToHex(requireBoundedText(value, label, maxLength)));
}

function requireBoundedText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must be non-empty, bounded text without control characters`);
  }
  return normalized;
}
