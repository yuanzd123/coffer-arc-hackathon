import { getAddress, type Address, type Hex } from "viem";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_EXPLORER_URL,
  ARC_TESTNET_MEMO_ADDRESS,
  ARC_TESTNET_USDC_ADDRESS
} from "../src/constants";
import {
  CIRCLE_AGENT_WALLET_CLI_NPM_INTEGRITY,
  CIRCLE_AGENT_WALLET_CLI_VERSION
} from "../src/circle-agent-wallet-writer";

export const AGENT_WALLET_AMOUNT_USD = "0.01";
export const AGENT_WALLET_AMOUNT_MINOR = 10_000n;
export const AGENT_WALLET_SCENARIO_ORDER = ["block", "approval", "allow", "allow_replay"] as const;

export type AgentWalletScenarioId = (typeof AGENT_WALLET_SCENARIO_ORDER)[number];

export type AgentWalletSettlementDocument = {
  transactionHash: Hex;
  blockNumber: string;
  blockHash: Hex;
  transactionIndex: number;
  transferLogIndex: number;
  transactionSender: Address;
  transactionTarget: Address | null;
  agentWalletAddress: Address;
  claimedSenderContractCodeHash: Hex;
  recipient: Address;
  amountMinor: "10000";
  tokenAddress: Address;
  tokenCodeHash: Hex;
  arcScanUrl: string;
};

type NotExecutedScenarioDocument = {
  expectedOutcome: "block" | "requires_approval";
  observedOutcome: "block" | "requires_approval";
  executionState: "not_executed";
  walletTransferCalls: 0;
  settlementReportCalls: 0;
  settlementReference: null;
};

type SettledScenarioDocument = {
  expectedOutcome: "allow";
  observedOutcome: "allow";
  executionState: "settled";
  replayed: boolean;
  walletTransferCalls: number;
  settlementReportCalls: number;
  circleWriteProvenance: "runner_attested_pinned_circle_cli" | "preexisting_hosted_settlement_reference";
  circleProviderReferenceSha256: Hex;
  decisionCommitment: Hex;
  recordHash: Hex;
  commitmentBinding: "offchain_correlation_only_no_arc_memo_or_registry";
  settlement: AgentWalletSettlementDocument;
};

export type AgentWalletEvidenceDocument = {
  schemaVersion: 1;
  evidenceType: "coffer_arc_agent_wallet_sca_compatibility";
  generatedAt: string;
  network: "ARC-TESTNET";
  chainId: 5_042_002;
  proofBoundary: {
    lane: "direct_usdc_sca_compatibility";
    amountUsd: "0.01";
    amountMinor: "10000";
    tokenAddress: Address;
    agentWalletAddress: Address;
    fixedRecipient: Address;
    memoBound: false;
    registryAnchored: false;
    decisionCorrelation: "offchain_commitment_only";
    circleProvenance: "runner_attested_pinned_circle_cli";
    onchainVerification: "independent_public_arc_rpc";
  };
  toolchain: {
    circleCliPackage: "@circle-fin/cli";
    circleCliVersion: string;
    circleCliNpmIntegrity: string;
    executionProvider: "circle_agent_wallet_cli";
  };
  scenarioOrder: readonly AgentWalletScenarioId[];
  scenarios: {
    block: NotExecutedScenarioDocument;
    approval: NotExecutedScenarioDocument;
    allow: SettledScenarioDocument;
    allow_replay: SettledScenarioDocument;
  };
  verificationBoundary: {
    independentlyVerifiable: readonly string[];
    runnerAttested: readonly string[];
    explicitlyNotClaimed: readonly string[];
  };
};

const independentlyVerifiable = [
  "Arc Testnet chain ID",
  "deployed contract bytecode at the claimed Agent Wallet address at the settlement block",
  "Arc USDC contract code and 6 decimals",
  "one exact 0.01 USDC debit from the claimed sender contract to the fixed recipient",
  "transaction, receipt, and indexed log inclusion"
] as const;

const runnerAttested = [
  "Coffer decision outcomes",
  "Circle CLI provenance and mutating transfer invocation counts",
  "SHA-256 correlation of the private Circle provider reference",
  "Coffer logical settlement-report call count (transport retries are not counted)",
  "off-chain decision commitment correlation"
] as const;

const explicitlyNotClaimed = [
  "Arc Memo binding",
  "CofferDecisionRegistry binding",
  "independent proof of Circle API or session identity",
  "independent proof that the sender contract is a Circle Agent Wallet or ERC-4337 account",
  "independent proof that the sender contract initiated the debit rather than an allowance-based transferFrom",
  "independent proof of zero mutating Circle transfer invocations"
] as const;

export function agentWalletVerificationBoundary(): AgentWalletEvidenceDocument["verificationBoundary"] {
  return {
    independentlyVerifiable: [...independentlyVerifiable],
    runnerAttested: [...runnerAttested],
    explicitlyNotClaimed: [...explicitlyNotClaimed]
  };
}

export function validateAgentWalletEvidenceDocument(value: unknown): AgentWalletEvidenceDocument {
  const root = requireObject(value, "Agent Wallet evidence");
  assertExactKeys(root, [
    "schemaVersion",
    "evidenceType",
    "generatedAt",
    "network",
    "chainId",
    "proofBoundary",
    "toolchain",
    "scenarioOrder",
    "scenarios",
    "verificationBoundary"
  ], "Agent Wallet evidence");
  assertNoPrivateAgentWalletEvidenceFields(root);

  if (
    root.schemaVersion !== 1
    || root.evidenceType !== "coffer_arc_agent_wallet_sca_compatibility"
    || root.network !== "ARC-TESTNET"
    || root.chainId !== ARC_TESTNET_CHAIN_ID
  ) {
    fail("evidence does not describe the supported Arc Testnet Agent Wallet schema");
  }
  requireIsoTimestamp(root.generatedAt, "generatedAt");

  const proofBoundary = requireObject(root.proofBoundary, "proofBoundary");
  assertExactKeys(proofBoundary, [
    "lane",
    "amountUsd",
    "amountMinor",
    "tokenAddress",
    "agentWalletAddress",
    "fixedRecipient",
    "memoBound",
    "registryAnchored",
    "decisionCorrelation",
    "circleProvenance",
    "onchainVerification"
  ], "proofBoundary");
  if (
    proofBoundary.lane !== "direct_usdc_sca_compatibility"
    || proofBoundary.amountUsd !== AGENT_WALLET_AMOUNT_USD
    || proofBoundary.amountMinor !== AGENT_WALLET_AMOUNT_MINOR.toString()
    || proofBoundary.tokenAddress !== getAddress(ARC_TESTNET_USDC_ADDRESS)
    || proofBoundary.memoBound !== false
    || proofBoundary.registryAnchored !== false
    || proofBoundary.decisionCorrelation !== "offchain_commitment_only"
    || proofBoundary.circleProvenance !== "runner_attested_pinned_circle_cli"
    || proofBoundary.onchainVerification !== "independent_public_arc_rpc"
  ) {
    fail("proofBoundary escaped the direct 0.01 USDC SCA compatibility lane");
  }
  const agentWalletAddress = requireCanonicalAddress(proofBoundary.agentWalletAddress, "proofBoundary agentWalletAddress");
  const fixedRecipient = requireCanonicalAddress(proofBoundary.fixedRecipient, "proofBoundary fixedRecipient");
  const forbiddenAddresses = new Set([
    "0x0000000000000000000000000000000000000000",
    ARC_TESTNET_USDC_ADDRESS,
    ARC_TESTNET_MEMO_ADDRESS,
    agentWalletAddress
  ].map((item) => item.toLowerCase()));
  if (forbiddenAddresses.has(fixedRecipient.toLowerCase())) fail("fixed recipient is a forbidden or self address");

  const toolchain = requireObject(root.toolchain, "toolchain");
  assertExactKeys(toolchain, [
    "circleCliPackage",
    "circleCliVersion",
    "circleCliNpmIntegrity",
    "executionProvider"
  ], "toolchain");
  if (
    toolchain.circleCliPackage !== "@circle-fin/cli"
    || toolchain.circleCliVersion !== CIRCLE_AGENT_WALLET_CLI_VERSION
    || toolchain.circleCliNpmIntegrity !== CIRCLE_AGENT_WALLET_CLI_NPM_INTEGRITY
    || toolchain.executionProvider !== "circle_agent_wallet_cli"
  ) {
    fail("toolchain does not match the pinned Circle Agent Wallet CLI contract");
  }

  requireExactStringArray(root.scenarioOrder, AGENT_WALLET_SCENARIO_ORDER, "scenarioOrder");
  const scenarios = requireObject(root.scenarios, "scenarios");
  assertExactKeys(scenarios, [...AGENT_WALLET_SCENARIO_ORDER], "scenarios");
  validateNotExecutedScenario(scenarios.block, "block", "block");
  validateNotExecutedScenario(scenarios.approval, "approval", "requires_approval");
  const allow = validateSettledScenario(scenarios.allow, "allow", false, 1, 1, proofBoundary);
  const replay = validateSettledScenario(scenarios.allow_replay, "allow_replay", true, 0, 0, proofBoundary);
  if (
    replay.decisionCommitment !== allow.decisionCommitment
    || replay.recordHash !== allow.recordHash
    || replay.circleProviderReferenceSha256 !== allow.circleProviderReferenceSha256
    || !sameSettlement(replay.settlement, allow.settlement)
  ) {
    fail("allow replay does not reference the exact original verified settlement");
  }

  const verificationBoundary = requireObject(root.verificationBoundary, "verificationBoundary");
  assertExactKeys(verificationBoundary, [
    "independentlyVerifiable",
    "runnerAttested",
    "explicitlyNotClaimed"
  ], "verificationBoundary");
  requireExactStringArray(verificationBoundary.independentlyVerifiable, independentlyVerifiable, "independentlyVerifiable");
  requireExactStringArray(verificationBoundary.runnerAttested, runnerAttested, "runnerAttested");
  requireExactStringArray(verificationBoundary.explicitlyNotClaimed, explicitlyNotClaimed, "explicitlyNotClaimed");

  return root as unknown as AgentWalletEvidenceDocument;
}

export function assertNoPrivateAgentWalletEvidenceFields(value: unknown, privateValues: readonly string[] = []): void {
  const forbiddenKey = /(?:api.?key|secret|authorization|wallet.?id|run.?id|idempotency|spend.?request.?id|decision.?id|spend.?decision.?record.?id|circle.?transaction.?id|provider.?transaction.?id|email|otp|one.?time|session|stdout|stderr)/i;
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, nested] of Object.entries(current)) {
      if (forbiddenKey.test(key)) fail(`evidence contains forbidden private field: ${key}`);
      visit(nested);
    }
  };
  visit(value);
  const serialized = JSON.stringify(value);
  for (const privateValue of privateValues) {
    if (privateValue.length >= 8 && serialized.includes(privateValue)) fail("evidence contains a configured private value");
  }
  if (/\bBearer\s+[^\s,;]+/i.test(serialized) || /(?:CIRCLE|COFFER)_(?:API_KEY|ENTITY_SECRET|OTP|SESSION)/i.test(serialized)) {
    fail("evidence contains a credential marker");
  }
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(serialized)) fail("evidence contains an email address");
}

export function transactionArcScanUrl(txHash: Hex): string {
  return `${ARC_TESTNET_EXPLORER_URL}/tx/${txHash.toLowerCase()}`;
}

function validateNotExecutedScenario(
  value: unknown,
  label: string,
  expectedOutcome: "block" | "requires_approval"
): void {
  const scenario = requireObject(value, `${label} scenario`);
  assertExactKeys(scenario, [
    "expectedOutcome",
    "observedOutcome",
    "executionState",
    "walletTransferCalls",
    "settlementReportCalls",
    "settlementReference"
  ], `${label} scenario`);
  if (
    scenario.expectedOutcome !== expectedOutcome
    || scenario.observedOutcome !== expectedOutcome
    || scenario.executionState !== "not_executed"
    || scenario.walletTransferCalls !== 0
    || scenario.settlementReportCalls !== 0
    || scenario.settlementReference !== null
  ) {
    fail(`${label} scenario did not preserve the zero-write boundary`);
  }
}

function validateSettledScenario(
  value: unknown,
  label: string,
  replayed: boolean,
  walletTransferCalls: number,
  settlementReportCalls: number,
  proofBoundary: Record<string, unknown>
): SettledScenarioDocument {
  const scenario = requireObject(value, `${label} scenario`);
  assertExactKeys(scenario, [
    "expectedOutcome",
    "observedOutcome",
    "executionState",
    "replayed",
    "walletTransferCalls",
    "settlementReportCalls",
    "circleWriteProvenance",
    "circleProviderReferenceSha256",
    "decisionCommitment",
    "recordHash",
    "commitmentBinding",
    "settlement"
  ], `${label} scenario`);
  const expectedProvenance = replayed
    ? "preexisting_hosted_settlement_reference"
    : "runner_attested_pinned_circle_cli";
  if (
    scenario.expectedOutcome !== "allow"
    || scenario.observedOutcome !== "allow"
    || scenario.executionState !== "settled"
    || scenario.replayed !== replayed
    || scenario.walletTransferCalls !== walletTransferCalls
    || scenario.settlementReportCalls !== settlementReportCalls
    || scenario.circleWriteProvenance !== expectedProvenance
    || scenario.commitmentBinding !== "offchain_correlation_only_no_arc_memo_or_registry"
  ) {
    fail(`${label} scenario call counts, replay state, or proof boundary are invalid`);
  }
  requireLowerHex32(scenario.decisionCommitment, `${label} decisionCommitment`);
  requireLowerHex32(scenario.recordHash, `${label} recordHash`);
  requireLowerHex32(scenario.circleProviderReferenceSha256, `${label} circleProviderReferenceSha256`);
  validateSettlement(scenario.settlement, `${label} settlement`, proofBoundary);
  return scenario as unknown as SettledScenarioDocument;
}

function validateSettlement(value: unknown, label: string, proofBoundary: Record<string, unknown>): void {
  const settlement = requireObject(value, label);
  assertExactKeys(settlement, [
    "transactionHash",
    "blockNumber",
    "blockHash",
    "transactionIndex",
    "transferLogIndex",
    "transactionSender",
    "transactionTarget",
    "agentWalletAddress",
    "claimedSenderContractCodeHash",
    "recipient",
    "amountMinor",
    "tokenAddress",
    "tokenCodeHash",
    "arcScanUrl"
  ], label);
  const transactionHash = requireLowerHex32(settlement.transactionHash, `${label} transactionHash`);
  requireUnsignedDecimal(settlement.blockNumber, `${label} blockNumber`, false);
  requireLowerHex32(settlement.blockHash, `${label} blockHash`);
  requireBoundedInteger(settlement.transactionIndex, `${label} transactionIndex`);
  requireBoundedInteger(settlement.transferLogIndex, `${label} transferLogIndex`);
  requireCanonicalAddress(settlement.transactionSender, `${label} transactionSender`);
  if (settlement.transactionTarget !== null) requireCanonicalAddress(settlement.transactionTarget, `${label} transactionTarget`);
  const sender = requireCanonicalAddress(settlement.agentWalletAddress, `${label} agentWalletAddress`);
  requireLowerHex32(settlement.claimedSenderContractCodeHash, `${label} claimedSenderContractCodeHash`);
  const recipient = requireCanonicalAddress(settlement.recipient, `${label} recipient`);
  const tokenAddress = requireCanonicalAddress(settlement.tokenAddress, `${label} tokenAddress`);
  requireLowerHex32(settlement.tokenCodeHash, `${label} tokenCodeHash`);
  if (
    sender !== proofBoundary.agentWalletAddress
    || recipient !== proofBoundary.fixedRecipient
    || settlement.amountMinor !== AGENT_WALLET_AMOUNT_MINOR.toString()
    || tokenAddress !== getAddress(ARC_TESTNET_USDC_ADDRESS)
    || tokenAddress !== proofBoundary.tokenAddress
    || settlement.arcScanUrl !== transactionArcScanUrl(transactionHash)
  ) {
    fail(`${label} escaped the fixed Arc USDC transfer boundary`);
  }
}

function sameSettlement(left: AgentWalletSettlementDocument, right: AgentWalletSettlementDocument): boolean {
  return left.transactionHash === right.transactionHash
    && left.blockNumber === right.blockNumber
    && left.blockHash === right.blockHash
    && left.transactionIndex === right.transactionIndex
    && left.transferLogIndex === right.transferLogIndex
    && left.transactionSender === right.transactionSender
    && left.transactionTarget === right.transactionTarget
    && left.agentWalletAddress === right.agentWalletAddress
    && left.claimedSenderContractCodeHash === right.claimedSenderContractCodeHash
    && left.recipient === right.recipient
    && left.amountMinor === right.amountMinor
    && left.tokenAddress === right.tokenAddress
    && left.tokenCodeHash === right.tokenCodeHash
    && left.arcScanUrl === right.arcScanUrl;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((item, index) => item !== wanted[index])) {
    fail(`${label} keys are invalid`);
  }
}

function requireExactStringArray(value: unknown, expected: readonly string[], label: string): void {
  if (!Array.isArray(value) || value.length !== expected.length) fail(`${label} is invalid`);
  for (let index = 0; index < expected.length; index += 1) {
    if (value[index] !== expected[index]) fail(`${label} is invalid`);
  }
}

function requireCanonicalAddress(value: unknown, label: string): Address {
  if (typeof value !== "string") fail(`${label} must be a canonical EVM address`);
  let normalized: Address;
  try {
    normalized = getAddress(value as string);
  } catch {
    fail(`${label} must be a canonical EVM address`);
  }
  if (normalized !== value) fail(`${label} must use canonical checksum casing`);
  return normalized;
}

function requireLowerHex32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) fail(`${label} must be lowercase 32-byte hex`);
  return value as Hex;
}

function requireUnsignedDecimal(value: unknown, label: string, allowZero: boolean): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) fail(`${label} must be an unsigned decimal string`);
  if (!allowZero && value === "0") fail(`${label} must be greater than zero`);
  return value;
}

function requireBoundedInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`);
  return value;
}

function requireIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 40) fail(`${label} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) fail(`${label} must be an ISO timestamp`);
  return value;
}

function fail(message: string): never {
  throw new Error(message);
}
