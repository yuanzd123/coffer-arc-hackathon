import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, type Address, type Hex } from "viem";
import { ARC_TESTNET_RPC_URL, ARC_TESTNET_USDC_ADDRESS } from "../src/constants";
import {
  type ArcAgentWalletEvidenceVerifier,
  type ArcAgentWalletSettlementEvidence
} from "../src/types";
import { ViemArcEvidenceVerifier, createArcPublicClient } from "../src/verifier";
import {
  CIRCLE_AGENT_WALLET_CLI_NPM_INTEGRITY,
  CIRCLE_AGENT_WALLET_CLI_VERSION
} from "../src/circle-agent-wallet-writer";
import {
  AGENT_WALLET_SCENARIO_ORDER,
  transactionArcScanUrl,
  validateAgentWalletEvidenceDocument,
  type AgentWalletEvidenceDocument,
  type AgentWalletSettlementDocument
} from "./agent-wallet-evidence-schema";

const DEFAULT_EVIDENCE = ".tmp/arc-agent-wallet-proof/agent-wallet-evidence.json";
const MAX_EVIDENCE_BYTES = 256 * 1024;
const PUBLIC_ARC_RPC_URLS = [
  ARC_TESTNET_RPC_URL,
  "https://rpc.drpc.testnet.arc.io"
] as const;

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  const evidencePath = resolveRepositoryPath(repositoryRoot, options.evidence ?? DEFAULT_EVIDENCE, "evidence file");
  const evidence = await readEvidence(evidencePath);
  const requestedRpcUrl = options.rpcUrl ?? process.env.ARC_RPC_URL?.trim();
  const rpcUrls = requestedRpcUrl
    ? [verifiedRpcUrl(requestedRpcUrl)]
    : [...PUBLIC_ARC_RPC_URLS];
  let verified: ArcAgentWalletSettlementEvidence | undefined;
  for (const rpcUrl of rpcUrls) {
    try {
      const verifier = new ViemArcEvidenceVerifier(createArcPublicClient(rpcUrl));
      verified = await verifyAgentWalletEvidenceOnArc(evidence, verifier);
      break;
    } catch {
      // Try only the next fixed credential-free endpoint. Raw diagnostics stay private.
    }
  }
  if (!verified) throw new Error("Fixed public Arc RPCs could not reproduce the Agent Wallet settlement evidence");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    credentialFree: true,
    network: evidence.network,
    chainId: evidence.chainId,
    agentWalletAddress: verified.sender,
    transactionHash: verified.txHash,
    settlementArcScanUrl: evidence.scenarios.allow.settlement.arcScanUrl,
    independentlyVerified: evidence.verificationBoundary.independentlyVerifiable,
    runnerAttestedOnly: evidence.verificationBoundary.runnerAttested,
    explicitlyNotClaimed: evidence.verificationBoundary.explicitlyNotClaimed
  }, null, 2)}\n`);
}

export async function verifyAgentWalletEvidenceOnArc(
  value: unknown,
  verifier: ArcAgentWalletEvidenceVerifier
): Promise<ArcAgentWalletSettlementEvidence> {
  const evidence = validateAgentWalletEvidenceDocument(value);
  const settlement = evidence.scenarios.allow.settlement;
  const verified = await verifier.verifyAgentWalletUsdcTransfer({
    txHash: settlement.transactionHash,
    sender: evidence.proofBoundary.agentWalletAddress,
    recipient: evidence.proofBoundary.fixedRecipient,
    amountMinor: 10_000n
  });
  assertVerifiedSettlementMatches(verified, settlement);
  return verified;
}

function assertVerifiedSettlementMatches(
  verified: ArcAgentWalletSettlementEvidence,
  recorded: AgentWalletSettlementDocument
): void {
  const target = verified.transactionTarget ? getAddress(verified.transactionTarget) : null;
  if (
    normalizeHash(verified.txHash) !== recorded.transactionHash
    || verified.blockNumber.toString() !== recorded.blockNumber
    || normalizeHash(verified.blockHash) !== recorded.blockHash
    || verified.transactionIndex !== recorded.transactionIndex
    || verified.transferLogIndex !== recorded.transferLogIndex
    || getAddress(verified.transactionSender) !== recorded.transactionSender
    || target !== recorded.transactionTarget
    || getAddress(verified.sender) !== recorded.agentWalletAddress
    || normalizeHash(verified.senderCodeHash) !== recorded.claimedSenderContractCodeHash
    || getAddress(verified.recipient) !== recorded.recipient
    || verified.amountMinor.toString() !== recorded.amountMinor
    || getAddress(verified.tokenAddress) !== recorded.tokenAddress
    || normalizeHash(verified.tokenCodeHash) !== recorded.tokenCodeHash
  ) {
    throw new Error("Public Arc RPC evidence does not match the recorded Agent Wallet settlement");
  }
}

async function readEvidence(evidencePath: string): Promise<AgentWalletEvidenceDocument> {
  const stat = await fs.stat(evidencePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_EVIDENCE_BYTES) {
    throw new Error("Agent Wallet evidence file is missing, empty, or oversized");
  }
  const contents = await fs.readFile(evidencePath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("Agent Wallet evidence file is not valid JSON");
  }
  return validateAgentWalletEvidenceDocument(value);
}

function parseOptions(args: readonly string[]): { evidence?: string; rpcUrl?: string } {
  const result: { evidence?: string; rpcUrl?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") continue;
    const next = args[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg ?? "option"} requires a value`);
    if (arg === "--evidence") {
      if (result.evidence !== undefined) throw new Error("--evidence may only be provided once");
      result.evidence = next;
    } else if (arg === "--rpc-url") {
      if (result.rpcUrl !== undefined) throw new Error("--rpc-url may only be provided once");
      result.rpcUrl = next;
    } else {
      throw new Error(`Unsupported option: ${arg}`);
    }
    index += 1;
  }
  return result;
}

function resolveRepositoryPath(repositoryRoot: string, requestedPath: string, label: string): string {
  const target = path.resolve(repositoryRoot, requestedPath);
  const relative = path.relative(repositoryRoot, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} must be inside the repository`);
  return target;
}

function verifiedRpcUrl(value: string): string {
  const parsed = new URL(value);
  const official = PUBLIC_ARC_RPC_URLS.map((rpcUrl) => new URL(rpcUrl)).find((candidate) => candidate.href === parsed.href);
  if (!official) {
    throw new Error("Agent Wallet proof requires the fixed credential-free official Arc Testnet RPC URL");
  }
  return official.href;
}

function normalizeHash(value: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("Arc evidence hash must be 32-byte hex");
  return value.toLowerCase() as Hex;
}

function sanitizeError(error: unknown): string {
  return (error instanceof Error ? error.message : "unknown verification failure")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email redacted]")
    .replace(/\b(?:si|pd|sdr|sr|dec)[_-][A-Za-z0-9_-]{3,240}\b/gi, "[Coffer record id redacted]")
    .slice(0, 2_000)
    .replace(/[\u0000-\u001f\u007f]/g, " ");
}

async function runSelfTest(): Promise<void> {
  if (verifiedRpcUrl(ARC_TESTNET_RPC_URL) !== new URL(ARC_TESTNET_RPC_URL).href) {
    throw new Error("Fixed Arc RPC self-test failed");
  }
  if (verifiedRpcUrl(PUBLIC_ARC_RPC_URLS[1]) !== new URL(PUBLIC_ARC_RPC_URLS[1]).href) {
    throw new Error("Fixed Arc fallback RPC self-test failed");
  }
  let credentialPathRefused = false;
  try {
    verifiedRpcUrl("https://rpc.blockdaemon.testnet.arc.io/v2/private-key");
  } catch {
    credentialPathRefused = true;
  }
  if (!credentialPathRefused) throw new Error("Credential-bearing Arc RPC path self-test failed");
  const fixture = selfTestEvidence();
  validateAgentWalletEvidenceDocument(fixture);
  const verifier = new SelfTestVerifier(fixture.scenarios.allow.settlement);
  await verifyAgentWalletEvidenceOnArc(fixture, verifier);
  if (verifier.calls !== 1) throw new Error("Credential-free verifier self-test did not make exactly one verifier call");

  const callCountTamper = structuredClone(fixture) as unknown as Record<string, unknown>;
  const scenarios = callCountTamper.scenarios as Record<string, Record<string, unknown>>;
  const block = scenarios.block;
  if (!block) throw new Error("Self-test fixture is missing block");
  block.walletTransferCalls = 1;
  assertRejected(callCountTamper, "zero-write tamper");

  const memoTamper = structuredClone(fixture) as unknown as Record<string, unknown>;
  const proofBoundary = memoTamper.proofBoundary as Record<string, unknown>;
  proofBoundary.memoBound = true;
  assertRejected(memoTamper, "Memo overclaim tamper");

  const privateFieldTamper = structuredClone(fixture) as unknown as Record<string, unknown>;
  privateFieldTamper.circleTransactionId = "private-id";
  assertRejected(privateFieldTamper, "private Circle identifier tamper");

  const replayTamper = structuredClone(fixture) as AgentWalletEvidenceDocument;
  replayTamper.scenarios.allow_replay.settlement.transactionHash = `0x${"e".repeat(64)}` as Hex;
  replayTamper.scenarios.allow_replay.settlement.arcScanUrl = transactionArcScanUrl(
    replayTamper.scenarios.allow_replay.settlement.transactionHash
  );
  assertRejected(replayTamper, "replay mismatch tamper");

  process.stdout.write("Agent Wallet evidence verifier self-test passed (credential-free and offline).\n");
}

function assertRejected(value: unknown, label: string): void {
  let rejected = false;
  try {
    validateAgentWalletEvidenceDocument(value);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`${label} was not rejected`);
}

function selfTestEvidence(): AgentWalletEvidenceDocument {
  const agentWalletAddress = getAddress("0x1111111111111111111111111111111111111111");
  const recipient = getAddress("0x2222222222222222222222222222222222222222");
  const transactionHash = `0x${"a".repeat(64)}` as Hex;
  const settlement: AgentWalletSettlementDocument = {
    transactionHash,
    blockNumber: "123",
    blockHash: `0x${"b".repeat(64)}` as Hex,
    transactionIndex: 4,
    transferLogIndex: 9,
    transactionSender: getAddress("0x3333333333333333333333333333333333333333"),
    transactionTarget: getAddress("0x4444444444444444444444444444444444444444"),
    agentWalletAddress,
    claimedSenderContractCodeHash: `0x${"c".repeat(64)}` as Hex,
    recipient,
    amountMinor: "10000",
    tokenAddress: getAddress(ARC_TESTNET_USDC_ADDRESS),
    tokenCodeHash: `0x${"d".repeat(64)}` as Hex,
    arcScanUrl: transactionArcScanUrl(transactionHash)
  };
  return {
    schemaVersion: 1,
    evidenceType: "coffer_arc_agent_wallet_sca_compatibility",
    generatedAt: "2026-07-16T12:00:00.000Z",
    network: "ARC-TESTNET",
    chainId: 5_042_002,
    proofBoundary: {
      lane: "direct_usdc_sca_compatibility",
      amountUsd: "0.01",
      amountMinor: "10000",
      tokenAddress: getAddress(ARC_TESTNET_USDC_ADDRESS),
      agentWalletAddress,
      fixedRecipient: recipient,
      memoBound: false,
      registryAnchored: false,
      decisionCorrelation: "offchain_commitment_only",
      circleProvenance: "runner_attested_pinned_circle_cli",
      onchainVerification: "independent_public_arc_rpc"
    },
    toolchain: {
      circleCliPackage: "@circle-fin/cli",
      circleCliVersion: CIRCLE_AGENT_WALLET_CLI_VERSION,
      circleCliNpmIntegrity: CIRCLE_AGENT_WALLET_CLI_NPM_INTEGRITY,
      executionProvider: "circle_agent_wallet_cli"
    },
    scenarioOrder: [...AGENT_WALLET_SCENARIO_ORDER],
    scenarios: {
      block: {
        expectedOutcome: "block",
        observedOutcome: "block",
        executionState: "not_executed",
        walletTransferCalls: 0,
        settlementReportCalls: 0,
        settlementReference: null
      },
      approval: {
        expectedOutcome: "requires_approval",
        observedOutcome: "requires_approval",
        executionState: "not_executed",
        walletTransferCalls: 0,
        settlementReportCalls: 0,
        settlementReference: null
      },
      allow: {
        expectedOutcome: "allow",
        observedOutcome: "allow",
        executionState: "settled",
        replayed: false,
        walletTransferCalls: 1,
        settlementReportCalls: 1,
        circleWriteProvenance: "runner_attested_pinned_circle_cli",
        circleProviderReferenceSha256: `0x${"3".repeat(64)}` as Hex,
        decisionCommitment: `0x${"1".repeat(64)}` as Hex,
        recordHash: `0x${"2".repeat(64)}` as Hex,
        commitmentBinding: "offchain_correlation_only_no_arc_memo_or_registry",
        settlement: { ...settlement }
      },
      allow_replay: {
        expectedOutcome: "allow",
        observedOutcome: "allow",
        executionState: "settled",
        replayed: true,
        walletTransferCalls: 0,
        settlementReportCalls: 0,
        circleWriteProvenance: "preexisting_hosted_settlement_reference",
        circleProviderReferenceSha256: `0x${"3".repeat(64)}` as Hex,
        decisionCommitment: `0x${"1".repeat(64)}` as Hex,
        recordHash: `0x${"2".repeat(64)}` as Hex,
        commitmentBinding: "offchain_correlation_only_no_arc_memo_or_registry",
        settlement: { ...settlement }
      }
    },
    verificationBoundary: {
      independentlyVerifiable: [
        "Arc Testnet chain ID",
        "deployed contract bytecode at the claimed Agent Wallet address at the settlement block",
        "Arc USDC contract code and 6 decimals",
        "one exact 0.01 USDC debit from the claimed sender contract to the fixed recipient",
        "transaction, receipt, and indexed log inclusion"
      ],
      runnerAttested: [
        "Coffer decision outcomes",
        "Circle CLI provenance and mutating transfer invocation counts",
        "SHA-256 correlation of the private Circle provider reference",
        "Coffer logical settlement-report call count (transport retries are not counted)",
        "off-chain decision commitment correlation"
      ],
      explicitlyNotClaimed: [
        "Arc Memo binding",
        "CofferDecisionRegistry binding",
        "independent proof of Circle API or session identity",
        "independent proof that the sender contract is a Circle Agent Wallet or ERC-4337 account",
        "independent proof that the sender contract initiated the debit rather than an allowance-based transferFrom",
        "independent proof of zero mutating Circle transfer invocations"
      ]
    }
  };
}

class SelfTestVerifier implements ArcAgentWalletEvidenceVerifier {
  calls = 0;

  constructor(private readonly settlement: AgentWalletSettlementDocument) {}

  async verifyAgentWalletUsdcTransfer(input: {
    txHash: Hex;
    sender: Address;
    recipient: Address;
    amountMinor: bigint;
  }): Promise<ArcAgentWalletSettlementEvidence> {
    this.calls += 1;
    if (
      input.txHash !== this.settlement.transactionHash
      || getAddress(input.sender) !== this.settlement.agentWalletAddress
      || getAddress(input.recipient) !== this.settlement.recipient
      || input.amountMinor !== 10_000n
    ) {
      throw new Error("Self-test verifier input mismatch");
    }
    return {
      txHash: this.settlement.transactionHash,
      blockNumber: BigInt(this.settlement.blockNumber),
      blockHash: this.settlement.blockHash,
      transactionIndex: this.settlement.transactionIndex,
      transferLogIndex: this.settlement.transferLogIndex,
      transactionSender: this.settlement.transactionSender,
      ...(this.settlement.transactionTarget ? { transactionTarget: this.settlement.transactionTarget } : {}),
      sender: this.settlement.agentWalletAddress,
      senderCodeHash: this.settlement.claimedSenderContractCodeHash,
      recipient: this.settlement.recipient,
      amountMinor: BigInt(this.settlement.amountMinor),
      tokenAddress: this.settlement.tokenAddress,
      tokenCodeHash: this.settlement.tokenCodeHash
    };
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && path.resolve(entry as string) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const operation = process.argv.includes("--self-test") ? runSelfTest : main;
  await operation().catch((error) => {
    process.stderr.write(`Agent Wallet evidence verification failed: ${sanitizeError(error)}\n`);
    process.exitCode = 1;
  });
}
