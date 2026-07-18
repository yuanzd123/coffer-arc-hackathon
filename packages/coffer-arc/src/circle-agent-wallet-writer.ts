import { execFile } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { devNull } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { formatUsdcMinorAsUsd } from "./commitment";
import { ARC_TESTNET_MEMO_ADDRESS, ARC_TESTNET_USDC_ADDRESS } from "./constants";
import type { ArcAgentWalletWriter, ArcAgentWalletWriteResult, DirectUsdcTransferInput } from "./types";

const ARC_TESTNET_BLOCKCHAIN = "ARC-TESTNET";
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_CAPTURE_BYTES = 128 * 1024;
const FEE_ESTIMATE_MAX_DEPTH = 8;
const FEE_ESTIMATE_MAX_NODES = 512;
const EXACT_AGENT_WALLET_PROOF_AMOUNT_MINOR = 10_000n;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TX_HASH_PATTERN = /^0x[0-9a-f]{64}$/i;
const MUTATION_IDENTIFIER_KEYS = new Set([
  "blockhash",
  "challenge",
  "challengeid",
  "correlationid",
  "hash",
  "id",
  "idempotencykey",
  "providertransactionid",
  "transactionhash",
  "transaction",
  "transactionid",
  "txid",
  "txhash"
]);
const MEDIUM_FEE_FIELDS = [
  "baseFee",
  "gasLimit",
  "l1Fee",
  "maxFee",
  "networkFee",
  "networkFeeRaw",
  "priorityFee"
] as const;
const ACCOUNT_ABSTRACTION_FEE_FIELDS = [
  "callGasLimit",
  "preVerificationGas",
  "verificationGasLimit"
] as const;
export const CIRCLE_AGENT_WALLET_CLI_VERSION = "0.0.6";
export const CIRCLE_AGENT_WALLET_CLI_NPM_INTEGRITY = "sha512-9QBShJ99xm/2j0xvdqdKhDaQRjZ3ZyQucJrgEW+8YZEHspU02ZYo1f8LP6AkElglHoSlNGQoiAYvRyHWkXH/OQ==";

export type CircleAgentWalletIdentity = {
  provider: "circle_agent_wallet_cli";
  walletType: "agent";
  blockchain: "ARC-TESTNET";
  address: Address;
};

export type CircleAgentWalletFeeEstimateAttestation = {
  provider: "circle_agent_wallet_cli";
  mode: "transfer_estimate_only";
  blockchain: "ARC-TESTNET";
  sender: Address;
  recipient: Address;
  tokenAddress: Address;
  amountMinor: "10000";
  idempotencyKeySupplied: false;
  mutationIdentifiersObserved: false;
  feeFieldsObserved: string[];
};

export type CircleCliInvocation = {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
};

export type CircleCliRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

export type CircleCliRunner = (invocation: CircleCliInvocation) => Promise<CircleCliRunResult>;

export type CircleAgentWalletCliWriterOptions = {
  sender: Address;
  cliHome: string;
  maxAmountMinor: bigint;
  timeoutMs?: number;
  runner?: CircleCliRunner;
  environment?: NodeJS.ProcessEnv;
  beforeTransfer?: (input: DirectUsdcTransferInput & { sender: Address }) => Promise<void>;
};

export class CircleAgentWalletCliError extends Error {
  constructor(readonly code: "invalid_output" | "indeterminate" | "timeout", message: string) {
    super(`Circle Agent Wallet CLI ${code}: ${message}`);
    this.name = "CircleAgentWalletCliError";
  }
}

/**
 * Narrow Circle Agent Wallet compatibility lane for Arc Testnet.
 *
 * The writer never invokes a shell, never retries a mutating command, always
 * supplies a deterministic idempotency key for the mutating call, and forces
 * Arc's ERC-20 USDC interface so the settlement can be verified from an exact
 * Transfer log. Before the durable mutation hook it also runs the pinned
 * CLI's estimate-only branch with no idempotency key or challenge submission.
 */
export class CircleAgentWalletCliWriter implements ArcAgentWalletWriter {
  readonly sender: Address;
  readonly maxAmountMinor: bigint;
  private readonly cliHome: string;
  private readonly cliEntryPath: string;
  private readonly cliEnvironment: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly runner: CircleCliRunner;
  private readonly beforeTransfer?: (input: DirectUsdcTransferInput & { sender: Address }) => Promise<void>;

  constructor(options: CircleAgentWalletCliWriterOptions) {
    this.sender = getAddress(options.sender);
    const requestedCliHome = requireSafeText(options.cliHome, "Circle CLI home", 4_096);
    if (!isAbsolute(requestedCliHome)) throw new Error("Circle CLI home must be an absolute private directory path");
    this.cliHome = resolve(requestedCliHome);
    this.maxAmountMinor = requireWholeCentAmount(options.maxAmountMinor, "maximum Agent Wallet amount");
    this.cliEntryPath = resolvePinnedCircleCliEntry();
    this.cliEnvironment = Object.freeze(buildCircleCliEnvironment(
      this.cliHome,
      options.environment ?? process.env
    ));
    this.timeoutMs = requireInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "Circle CLI timeout", 1_000, 600_000);
    this.runner = options.runner ?? runCircleCli;
    this.beforeTransfer = options.beforeTransfer;
  }

  async transferUsdc(input: DirectUsdcTransferInput): Promise<ArcAgentWalletWriteResult> {
    const recipient = requireSafeAgentWalletRecipient(input.recipient, this.sender);
    const amountMinor = requireWholeCentAmount(input.amountMinor, "Agent Wallet transfer amount");
    if (amountMinor > this.maxAmountMinor) {
      throw new Error("Agent Wallet transfer amount exceeds the configured hard cap");
    }
    const operationId = input.operationId.trim();
    if (!UUID_PATTERN.test(operationId)) {
      throw new Error("Agent Wallet operation id must be a canonical version-4 UUID");
    }
    await this.preflightIdentity();
    await this.estimateUsdcTransfer({ recipient, amountMinor });
    await this.beforeTransfer?.({
      recipient,
      amountMinor,
      operationId,
      sender: this.sender
    });
    assertPrivateCliHome(this.cliHome);
    assertLocalWalletFallbackBlocked();

    const args = [
      "wallet",
      "transfer",
      recipient,
      "--amount",
      formatUsdcMinorAsUsd(amountMinor),
      "--token",
      ARC_TESTNET_USDC_ADDRESS,
      "--address",
      this.sender,
      "--chain",
      ARC_TESTNET_BLOCKCHAIN,
      "--idempotency-key",
      operationId,
      "--output",
      "json"
    ] as const;

    let result: CircleCliRunResult;
    try {
      result = await this.runner({
        executable: process.execPath,
        args: [this.cliEntryPath, ...args],
        cwd: this.cliHome,
        env: { ...this.cliEnvironment },
        timeoutMs: this.timeoutMs
      });
    } catch {
      throw new CircleAgentWalletCliError(
        "indeterminate",
        "CLI process state could not be observed after the mutation boundary; do not retry automatically"
      );
    }

    if (result.timedOut) {
      throw new CircleAgentWalletCliError(
        "timeout",
        "command outcome is unknown; reconcile with the read-only transaction list and public Arc history; never invoke transfer again automatically"
      );
    }
    if (result.exitCode !== 0) {
      throw new CircleAgentWalletCliError(
        "indeterminate",
        "command exited without a validated terminal result; do not retry automatically"
      );
    }

    let parsed: { id: string; txHash: Hex };
    try {
      parsed = parseCircleAgentWalletTransferOutput(result.stdout, {
        sender: this.sender,
        recipient,
        amountMinor,
        operationId
      });
    } catch {
      throw new CircleAgentWalletCliError(
        "indeterminate",
        "CLI output could not prove a terminal matching transfer; do not retry automatically"
      );
    }
    return {
      provider: "circle_agent_wallet_cli",
      providerTransactionId: parsed.id,
      txHash: parsed.txHash
    };
  }

  /**
   * Read-only identity probe. Live transfers always call this again immediately
   * before the durable mutation hook and transfer process.
   */
  async preflightIdentity(): Promise<CircleAgentWalletIdentity> {
    assertPrivateCliHome(this.cliHome);
    const args = [
      "wallet",
      "list",
      "--chain",
      ARC_TESTNET_BLOCKCHAIN,
      "--type",
      "agent",
      "--output",
      "json"
    ] as const;
    let result: CircleCliRunResult;
    try {
      result = await this.runner({
        executable: process.execPath,
        args: [this.cliEntryPath, ...args],
        cwd: this.cliHome,
        env: { ...this.cliEnvironment },
        timeoutMs: this.timeoutMs
      });
    } catch {
      throw new Error("Agent Wallet identity preflight could not run; wallet mutation refused");
    }
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error("Agent Wallet identity preflight did not complete; wallet mutation refused");
    }
    return parseCircleAgentWalletListOutput(result.stdout, this.sender);
  }

  /**
   * Non-broadcast compatibility probe for the one permitted Arc proof payment.
   * The pinned CLI's --estimate branch returns before challenge submission.
   */
  async estimateUsdcTransfer(input: {
    recipient: Address;
    amountMinor: bigint;
  }): Promise<CircleAgentWalletFeeEstimateAttestation> {
    const recipient = requireSafeAgentWalletRecipient(input.recipient, this.sender);
    const amountMinor = requireWholeCentAmount(input.amountMinor, "Agent Wallet fee-estimate amount");
    if (amountMinor !== EXACT_AGENT_WALLET_PROOF_AMOUNT_MINOR || amountMinor > this.maxAmountMinor) {
      throw new Error("Agent Wallet fee estimate is fixed to the capped 0.01 USDC proof amount");
    }
    assertPrivateCliHome(this.cliHome);
    assertLocalWalletFallbackBlocked();
    const args = [
      "wallet",
      "transfer",
      recipient,
      "--amount",
      formatUsdcMinorAsUsd(amountMinor),
      "--token",
      ARC_TESTNET_USDC_ADDRESS,
      "--address",
      this.sender,
      "--chain",
      ARC_TESTNET_BLOCKCHAIN,
      "--estimate",
      "--output",
      "json"
    ] as const;

    let result: CircleCliRunResult;
    try {
      result = await this.runner({
        executable: process.execPath,
        args: [this.cliEntryPath, ...args],
        cwd: this.cliHome,
        env: { ...this.cliEnvironment },
        timeoutMs: this.timeoutMs
      });
    } catch {
      throw new Error("Agent Wallet fee-estimate preflight could not run; wallet mutation refused");
    }
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error("Agent Wallet fee-estimate preflight did not complete; wallet mutation refused");
    }
    return parseCircleAgentWalletFeeEstimateOutput(result.stdout, {
      sender: this.sender,
      recipient,
      amountMinor
    });
  }
}

export function parseCircleAgentWalletListOutput(
  stdout: string,
  expectedSender: Address
): CircleAgentWalletIdentity {
  if (stdout.length > MAX_CAPTURE_BYTES) throw new Error("Agent Wallet identity response exceeded the bounded output size");
  let root: unknown;
  try {
    root = JSON.parse(stdout);
  } catch {
    throw new Error("Agent Wallet identity response was not JSON");
  }
  if (!isRecord(root) || !isRecord(root.data) || !Array.isArray(root.data.wallets)) {
    throw new Error("Agent Wallet identity response is missing the wallets list");
  }
  const expected = getAddress(expectedSender);
  let agentMatches = 0;
  for (const wallet of root.data.wallets) {
    if (
      !isRecord(wallet)
      || wallet.type !== "agent"
      || wallet.blockchain !== ARC_TESTNET_BLOCKCHAIN
    ) {
      throw new Error("Agent-only Wallet identity response contains an unknown wallet type or wrong network");
    }
    const address = requireOutputAddress(wallet.address, "Agent Wallet list address");
    if (address === expected) agentMatches += 1;
  }
  if (agentMatches !== 1) {
    throw new Error("Configured sender was not uniquely present in the authenticated Arc Testnet Agent Wallet list");
  }
  return {
    provider: "circle_agent_wallet_cli",
    walletType: "agent",
    blockchain: ARC_TESTNET_BLOCKCHAIN,
    address: expected
  };
}

export function parseCircleAgentWalletFeeEstimateOutput(stdout: string, expected: {
  sender: Address;
  recipient: Address;
  amountMinor: bigint;
}): CircleAgentWalletFeeEstimateAttestation {
  if (stdout.length > MAX_CAPTURE_BYTES) {
    throw new CircleAgentWalletCliError("invalid_output", "fee-estimate JSON exceeded the bounded output size");
  }
  let root: unknown;
  try {
    root = JSON.parse(stdout);
  } catch {
    throw new CircleAgentWalletCliError("invalid_output", "fee-estimate response was not JSON");
  }
  if (!isRecord(root) || !isRecord(root.data)) {
    throw new CircleAgentWalletCliError("invalid_output", "fee-estimate response is missing the data object");
  }
  assertNoMutationIdentifiers(root);
  const data = root.data;
  if (data.blockchain !== ARC_TESTNET_BLOCKCHAIN || !isRecord(data.medium)) {
    throw new CircleAgentWalletCliError("invalid_output", "fee-estimate response does not match Arc Testnet medium-fee output");
  }

  const feeFieldsObserved: string[] = [];
  for (const field of MEDIUM_FEE_FIELDS) {
    if (isBoundedFeeScalar(data.medium[field])) feeFieldsObserved.push(`medium.${field}`);
  }
  const mediumFeeFieldCount = feeFieldsObserved.length;
  for (const field of ACCOUNT_ABSTRACTION_FEE_FIELDS) {
    if (isBoundedFeeScalar(data[field])) feeFieldsObserved.push(field);
  }
  if (mediumFeeFieldCount === 0) {
    throw new CircleAgentWalletCliError("invalid_output", "fee-estimate response contains no recognized bounded medium-fee field");
  }

  const sender = getAddress(expected.sender);
  const recipient = requireSafeAgentWalletRecipient(expected.recipient, sender);
  if (expected.amountMinor !== EXACT_AGENT_WALLET_PROOF_AMOUNT_MINOR) {
    throw new CircleAgentWalletCliError("invalid_output", "fee-estimate attestation amount escaped the fixed proof boundary");
  }
  return {
    provider: "circle_agent_wallet_cli",
    mode: "transfer_estimate_only",
    blockchain: ARC_TESTNET_BLOCKCHAIN,
    sender,
    recipient,
    tokenAddress: getAddress(ARC_TESTNET_USDC_ADDRESS),
    amountMinor: "10000",
    idempotencyKeySupplied: false,
    mutationIdentifiersObserved: false,
    feeFieldsObserved
  };
}

export function parseCircleAgentWalletTransferOutput(stdout: string, expected: {
  sender: Address;
  recipient: Address;
  amountMinor: bigint;
  operationId: string;
}): { id: string; txHash: Hex } {
  if (stdout.length > MAX_CAPTURE_BYTES) {
    throw new CircleAgentWalletCliError("invalid_output", "JSON response exceeded the bounded output size");
  }
  let root: unknown;
  try {
    root = JSON.parse(stdout);
  } catch {
    throw new CircleAgentWalletCliError("invalid_output", "response was not JSON");
  }
  if (!isRecord(root) || !isRecord(root.data)) {
    throw new CircleAgentWalletCliError("invalid_output", "response is missing the data object");
  }
  const data = root.data;
  const id = requireOutputText(data.id, "transaction id", 240);
  const state = requireOutputText(data.state, "transaction state", 32);
  if (state !== "CONFIRMED" && state !== "COMPLETE") {
    throw new CircleAgentWalletCliError("invalid_output", "transaction did not reach a successful terminal state");
  }
  if (data.blockchain !== ARC_TESTNET_BLOCKCHAIN || data.operation !== "TRANSFER") {
    throw new CircleAgentWalletCliError("invalid_output", "transaction rail does not match Arc Testnet USDC transfer");
  }
  if (data.idempotencyKey !== expected.operationId) {
    throw new CircleAgentWalletCliError("invalid_output", "transaction idempotency key mismatch");
  }
  const txHashText = requireOutputText(data.txHash, "transaction hash", 66);
  if (!TX_HASH_PATTERN.test(txHashText)) {
    throw new CircleAgentWalletCliError("invalid_output", "transaction hash is malformed");
  }
  const sourceAddress = requireOutputAddress(data.sourceAddress, "source address");
  const destinationAddress = requireOutputAddress(data.destinationAddress, "destination address");
  if (sourceAddress !== getAddress(expected.sender) || destinationAddress !== getAddress(expected.recipient)) {
    throw new CircleAgentWalletCliError("invalid_output", "transaction address mismatch");
  }
  if (!Array.isArray(data.amounts) || data.amounts.length !== 1 || typeof data.amounts[0] !== "string") {
    throw new CircleAgentWalletCliError("invalid_output", "transaction amount list is malformed");
  }
  let actualAmountMinor: bigint;
  try {
    actualAmountMinor = parseCircleUsdcAmount(data.amounts[0]);
  } catch {
    throw new CircleAgentWalletCliError("invalid_output", "transaction amount is malformed");
  }
  if (actualAmountMinor !== expected.amountMinor) {
    throw new CircleAgentWalletCliError("invalid_output", "transaction amount mismatch");
  }
  if (data.transactionType !== undefined && data.transactionType !== "OUTBOUND") {
    throw new CircleAgentWalletCliError("invalid_output", "transaction direction mismatch");
  }
  if (data.contractAddress !== undefined) {
    const contractAddress = requireOutputAddress(data.contractAddress, "contract address");
    if (contractAddress !== getAddress(ARC_TESTNET_USDC_ADDRESS)) {
      throw new CircleAgentWalletCliError("invalid_output", "transaction token contract mismatch");
    }
  }
  return { id, txHash: txHashText as Hex };
}

function parseCircleUsdcAmount(value: string): bigint {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized)) {
    throw new Error("Circle USDC amount must be a decimal with at most six fraction digits");
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export function resolvePinnedCircleCliEntry(): string {
  const require = createRequire(import.meta.url);
  const entryPath = require.resolve("@circle-fin/cli");
  const packagePath = resolve(dirname(entryPath), "..", "package.json");
  let packageData: unknown;
  try {
    packageData = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch {
    throw new Error("Unable to read the pinned Circle CLI package metadata");
  }
  if (!isRecord(packageData) || packageData.name !== "@circle-fin/cli" || packageData.version !== CIRCLE_AGENT_WALLET_CLI_VERSION) {
    throw new Error(`Circle CLI must be pinned to @circle-fin/cli@${CIRCLE_AGENT_WALLET_CLI_VERSION}`);
  }
  return entryPath;
}

export function buildCircleCliEnvironment(cliHome: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  assertLocalWalletFallbackBlocked();
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "GNOME_KEYRING_CONTROL"
  ]) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  const privateHome = resolve(cliHome);
  // Circle state honors CIRCLE_CLI_HOME. OWS local wallets honor HOME, so the
  // proof lane gives them an OS-owned non-directory: agent lookup failure then
  // reaches ENOTDIR instead of a local signing fallback. This is Linux-only and
  // pinned to the audited Circle CLI / OWS dependency versions.
  env.HOME = devNull;
  env.CIRCLE_CLI_HOME = privateHome;
  env.CIRCLE_VERSION_CHECK = "off";
  env.DO_NOT_TRACK = "1";
  env.NO_COLOR = "1";
  return env;
}

export async function runCircleCli(invocation: CircleCliInvocation): Promise<CircleCliRunResult> {
  return new Promise((resolveResult, reject) => {
    const childEnvironment = { ...invocation.env } as NodeJS.ProcessEnv;
    const child = execFile(
      invocation.executable,
      [...invocation.args],
      {
        cwd: invocation.cwd,
        env: childEnvironment,
        encoding: "utf8",
        maxBuffer: MAX_CAPTURE_BYTES,
        timeout: invocation.timeoutMs,
        windowsHide: true,
        shell: false
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolveResult({ exitCode: 0, stdout, stderr });
          return;
        }
        const errorWithDetails = error as Error & { code?: number | string; killed?: boolean; signal?: string };
        if (errorWithDetails.killed || errorWithDetails.signal === "SIGTERM") {
          resolveResult({ exitCode: null, stdout, stderr, timedOut: true });
          return;
        }
        if (typeof errorWithDetails.code === "number") {
          resolveResult({ exitCode: errorWithDetails.code, stdout, stderr });
          return;
        }
        reject(new Error("Circle CLI process could not be started"));
      }
    );
    child.stdin?.end();
  });
}

function assertPrivateCliHome(cliHome: string): void {
  let stat;
  try {
    stat = lstatSync(cliHome);
  } catch {
    throw new Error("Circle CLI home must already exist as a private directory");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Circle CLI home must be a real directory, not a symlink");
  }
  if (realpathSync(cliHome) !== cliHome) {
    throw new Error("Circle CLI home path must not traverse symlinked directories");
  }
  if ((stat.mode & 0o700) !== 0o700) {
    throw new Error("Circle CLI home permissions must grant its owner read, write, and execute access");
  }
  if ((stat.mode & 0o077) !== 0) throw new Error("Circle CLI home permissions must not grant group or other access");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("Circle CLI home must be owned by the current user");
  }
}

function assertLocalWalletFallbackBlocked(): void {
  if (process.platform !== "linux" || devNull !== "/dev/null") {
    throw new Error("The Agent Wallet proof operator only permits the audited Linux /dev/null OWS fallback blocker");
  }
  let stat;
  try {
    stat = lstatSync(devNull);
  } catch {
    throw new Error("The OS-owned local-wallet fallback blocker is unavailable");
  }
  if (!stat.isCharacterDevice() || realpathSync(devNull) !== devNull) {
    throw new Error("The OS-owned local-wallet fallback blocker is not a real character device");
  }
}

function requireSafeAgentWalletRecipient(value: Address, sender: Address): Address {
  let recipient: Address;
  try {
    recipient = getAddress(value);
  } catch {
    throw new Error("Agent Wallet recipient must be a valid external fixed payment address");
  }
  const forbiddenRecipients = new Set([
    zeroAddress.toLowerCase(),
    getAddress(sender).toLowerCase(),
    ARC_TESTNET_MEMO_ADDRESS.toLowerCase(),
    ARC_TESTNET_USDC_ADDRESS.toLowerCase()
  ]);
  if (forbiddenRecipients.has(recipient.toLowerCase())) {
    throw new Error("Agent Wallet recipient must be an external fixed payment address");
  }
  return recipient;
}

function assertNoMutationIdentifiers(value: unknown): void {
  let visited = 0;
  const visit = (current: unknown, depth: number): void => {
    visited += 1;
    if (visited > FEE_ESTIMATE_MAX_NODES || depth > FEE_ESTIMATE_MAX_DEPTH) {
      throw new CircleAgentWalletCliError("invalid_output", "fee-estimate response exceeded the bounded JSON structure");
    }
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry, depth + 1);
      return;
    }
    if (!isRecord(current)) return;
    for (const [key, nested] of Object.entries(current)) {
      if (!key || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key)) {
        throw new CircleAgentWalletCliError("invalid_output", "fee-estimate response contains an invalid field name");
      }
      const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (
        MUTATION_IDENTIFIER_KEYS.has(normalizedKey)
        || normalizedKey.includes("challenge")
        || normalizedKey.includes("transactionid")
      ) {
        throw new CircleAgentWalletCliError(
          "invalid_output",
          "fee-estimate response unexpectedly contained a transaction or challenge identifier"
        );
      }
      visit(nested, depth + 1);
    }
  };
  visit(value, 0);
}

function isBoundedFeeScalar(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 128) return false;
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)
    || /^0x[0-9a-f]{1,64}$/i.test(normalized);
}

function requireWholeCentAmount(value: bigint, label: string): bigint {
  if (value <= 0n || value % 10_000n !== 0n) {
    throw new Error(`${label} must be positive and resolve to whole cents`);
  }
  return value;
}

function requireInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function requireSafeText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must be non-empty bounded text without control characters`);
  }
  return normalized;
}

function requireOutputText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new CircleAgentWalletCliError("invalid_output", `${label} is missing`);
  }
  try {
    return requireSafeText(value, label, maxLength);
  } catch {
    throw new CircleAgentWalletCliError("invalid_output", `${label} is malformed`);
  }
}

function requireOutputAddress(value: unknown, label: string): Address {
  const text = requireOutputText(value, label, 42);
  try {
    return getAddress(text);
  } catch {
    throw new CircleAgentWalletCliError("invalid_output", `${label} is malformed`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
