import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import {
  buildCircleCliEnvironment,
  CircleAgentWalletCliError,
  CircleAgentWalletCliWriter,
  parseCircleAgentWalletFeeEstimateOutput,
  parseCircleAgentWalletListOutput,
  parseCircleAgentWalletTransferOutput,
  resolvePinnedCircleCliEntry,
  type CircleCliRunner
} from "./circle-agent-wallet-writer";
import { ARC_TESTNET_MEMO_ADDRESS, ARC_TESTNET_USDC_ADDRESS } from "./constants";

const sender = "0x1111111111111111111111111111111111111111" as Address;
const recipient = "0x2222222222222222222222222222222222222222" as Address;
const operationId = "9ee025cf-43c3-4f45-86da-9e018c02a144";
const txHash = `0x${"a".repeat(64)}` as Hex;
const pinnedEntry = resolvePinnedCircleCliEntry();
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
});

describe("CircleAgentWalletCliWriter", () => {
  it("preflights identity and the exact estimate-only request, then invokes the transfer exactly once", async () => {
    const runner = vi.fn<CircleCliRunner>(withAgentPreflight(async () => ({
      exitCode: 0,
      stderr: "diagnostic text that must not enter evidence",
      stdout: transferOutput()
    })));
    const writer = createWriter(runner);

    const result = await writer.transferUsdc({ recipient, amountMinor: 10_000n, operationId });

    expect(result).toEqual({
      provider: "circle_agent_wallet_cli",
      providerTransactionId: "circle-tx-001",
      txHash
    });
    expect(runner).toHaveBeenCalledTimes(3);
    const identityInvocation = runner.mock.calls[0]?.[0];
    expect(identityInvocation?.args).toEqual([
      pinnedEntry,
      "wallet",
      "list",
      "--chain",
      "ARC-TESTNET",
      "--type",
      "agent",
      "--output",
      "json"
    ]);
    const estimateInvocation = runner.mock.calls[1]?.[0];
    expect(estimateInvocation?.args).toEqual([
      pinnedEntry,
      "wallet",
      "transfer",
      recipient,
      "--amount",
      "0.01",
      "--token",
      ARC_TESTNET_USDC_ADDRESS,
      "--address",
      sender,
      "--chain",
      "ARC-TESTNET",
      "--estimate",
      "--output",
      "json"
    ]);
    expect(estimateInvocation?.args).not.toContain("--idempotency-key");
    expect(estimateInvocation?.args).not.toContain(operationId);
    const invocation = runner.mock.calls[2]?.[0];
    expect(invocation?.executable).toBe(process.execPath);
    expect(invocation?.args).toEqual([
      pinnedEntry,
      "wallet",
      "transfer",
      recipient,
      "--amount",
      "0.01",
      "--token",
      ARC_TESTNET_USDC_ADDRESS,
      "--address",
      sender,
      "--chain",
      "ARC-TESTNET",
      "--idempotency-key",
      operationId,
      "--output",
      "json"
    ]);
    expect(invocation?.env.CIRCLE_CLI_HOME).toBe(invocation?.cwd);
    expect(invocation?.env.HOME).toBe(devNull);
    expect(invocation?.env.HOME).not.toBe(invocation?.env.CIRCLE_CLI_HOME);
    expect(estimateInvocation?.env).toEqual(invocation?.env);
    expect(identityInvocation?.env).toEqual(invocation?.env);
    expect(invocation?.env.CIRCLE_API_KEY).toBeUndefined();
    expect(invocation?.env.CIRCLE_ENTITY_SECRET).toBeUndefined();
    expect(invocation?.env.CIRCLE_PROXY_URL).toBeUndefined();
  });

  it("supports a standalone read-only identity preflight without a transfer invocation", async () => {
    const runner = vi.fn<CircleCliRunner>(async () => ({
      exitCode: 0,
      stdout: agentWalletListOutput(sender),
      stderr: "private diagnostic that must not be returned"
    }));
    const writer = createWriter(runner);

    await expect(writer.preflightIdentity()).resolves.toEqual({
      provider: "circle_agent_wallet_cli",
      walletType: "agent",
      blockchain: "ARC-TESTNET",
      address: sender
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]?.[0].args).toEqual([
      pinnedEntry,
      "wallet",
      "list",
      "--chain",
      "ARC-TESTNET",
      "--type",
      "agent",
      "--output",
      "json"
    ]);
    expect(runner.mock.calls[0]?.[0].args).not.toContain("transfer");
  });

  it("returns a sanitized attestation for the standalone exact fee estimate", async () => {
    const runner = vi.fn<CircleCliRunner>(async () => ({
      exitCode: 0,
      stdout: feeEstimateOutput(),
      stderr: "private provider diagnostics"
    }));
    const writer = createWriter(runner);

    const attestation = await writer.estimateUsdcTransfer({ recipient, amountMinor: 10_000n });

    expect(attestation).toEqual({
      provider: "circle_agent_wallet_cli",
      mode: "transfer_estimate_only",
      blockchain: "ARC-TESTNET",
      sender,
      recipient,
      tokenAddress: ARC_TESTNET_USDC_ADDRESS,
      amountMinor: "10000",
      idempotencyKeySupplied: false,
      mutationIdentifiersObserved: false,
      feeFieldsObserved: [
        "medium.gasLimit",
        "medium.maxFee",
        "medium.networkFee",
        "callGasLimit",
        "preVerificationGas",
        "verificationGasLimit"
      ]
    });
    expect(JSON.stringify(attestation)).not.toContain("private provider diagnostics");
    expect(JSON.stringify(attestation)).not.toContain("999999999999");
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]?.[0].args).toContain("--estimate");
    expect(runner.mock.calls[0]?.[0].args).not.toContain("--idempotency-key");
  });

  it("never retries an indeterminate timeout", async () => {
    const runner = vi.fn<CircleCliRunner>(withAgentPreflight(async () => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true
    })));
    const writer = createWriter(runner);
    await expect(writer.transferUsdc({ recipient, amountMinor: 10_000n, operationId }))
      .rejects.toMatchObject({
        code: "timeout",
        message: expect.stringContaining("reconcile with the read-only transaction list and public Arc history; never invoke transfer again automatically")
      });
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("treats every nonzero CLI exit as indeterminate after the mutation boundary", async () => {
    const runner = vi.fn<CircleCliRunner>(withAgentPreflight(async () => ({
      exitCode: 1,
      stdout: JSON.stringify({ error: { code: "TIMEOUT" } }),
      stderr: ""
    })));
    const writer = createWriter(runner);
    await expect(writer.transferUsdc({ recipient, amountMinor: 10_000n, operationId }))
      .rejects.toMatchObject({ code: "indeterminate" });
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("treats an unprovable zero-exit response as indeterminate without another invocation", async () => {
    const runner = vi.fn<CircleCliRunner>(withAgentPreflight(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ data: { state: "SENT" } }),
      stderr: ""
    })));
    const writer = createWriter(runner);
    await expect(writer.transferUsdc({ recipient, amountMinor: 10_000n, operationId }))
      .rejects.toMatchObject({ code: "indeterminate" });
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("treats an unavailable runner result as indeterminate", async () => {
    const runner = vi.fn<CircleCliRunner>(withAgentPreflight(async () => {
      throw new Error("bounded capture failed after process launch");
    }));
    const writer = createWriter(runner);
    await expect(writer.transferUsdc({ recipient, amountMinor: 10_000n, operationId }))
      .rejects.toMatchObject({ code: "indeterminate" });
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("refuses mutation when the configured sender is absent from the authenticated Agent Wallet list", async () => {
    const otherAgent = "0x3333333333333333333333333333333333333333" as Address;
    const runner = vi.fn<CircleCliRunner>(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        data: {
          wallets: [
            { type: "agent", address: otherAgent, blockchain: "ARC-TESTNET" }
          ]
        }
      }),
      stderr: ""
    }));
    const writer = createWriter(runner);
    await expect(writer.transferUsdc({ recipient, amountMinor: 10_000n, operationId }))
      .rejects.toThrow("not uniquely present");
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls.some(([invocation]) => invocation.args.includes("transfer"))).toBe(false);
  });

  it("runs the durable mutation hook after identity and fee-estimate preflight and before the transfer process", async () => {
    const transferRunner = vi.fn<CircleCliRunner>(async () => ({
      exitCode: 0,
      stdout: transferOutput(),
      stderr: ""
    }));
    const runner = vi.fn<CircleCliRunner>(withAgentPreflight(transferRunner));
    const beforeTransfer = vi.fn(async () => {
      throw new Error("synthetic journal fsync failure");
    });
    const writer = createWriter(runner, beforeTransfer);

    await expect(writer.transferUsdc({ recipient, amountMinor: 10_000n, operationId }))
      .rejects.toThrow("synthetic journal fsync failure");
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0]?.[0].args).toContain("list");
    expect(runner.mock.calls[1]?.[0].args).toContain("--estimate");
    expect(beforeTransfer).toHaveBeenCalledWith({ sender, recipient, amountMinor: 10_000n, operationId });
    expect(transferRunner).not.toHaveBeenCalled();
  });

  it("refuses the mutation journal when estimate output suggests a transaction or challenge", async () => {
    const runner = vi.fn<CircleCliRunner>(async (invocation) => invocation.args.includes("list")
      ? { exitCode: 0, stdout: agentWalletListOutput(sender), stderr: "" }
      : {
          exitCode: 0,
          stdout: feeEstimateOutput({ challenge: { transactionId: "must-not-exist" } }),
          stderr: "private provider diagnostics"
        });
    const beforeTransfer = vi.fn(async () => undefined);
    const writer = createWriter(runner, beforeTransfer);

    await expect(writer.transferUsdc({ recipient, amountMinor: 10_000n, operationId }))
      .rejects.toThrow("transaction or challenge identifier");
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1]?.[0].args).toContain("--estimate");
    expect(beforeTransfer).not.toHaveBeenCalled();
  });

  it("rejects any non-agent response or duplicate Agent identity", () => {
    const otherAgent = "0x3333333333333333333333333333333333333333" as Address;
    expect(() => parseCircleAgentWalletListOutput(agentWalletListOutput(otherAgent), sender))
      .toThrow("not uniquely present");
    expect(() => parseCircleAgentWalletListOutput(agentWalletListOutput(sender, { type: "local" }), sender))
      .toThrow("Agent-only Wallet identity response");
    expect(() => parseCircleAgentWalletListOutput(JSON.stringify({
      data: {
        wallets: [
          { type: "agent", address: sender, blockchain: "ARC-TESTNET" },
          { type: "agent", address: sender, blockchain: "ARC-TESTNET" }
        ]
      }
    }), sender)).toThrow("not uniquely present");
  });

  it("accepts bounded fee output but never carries fee values into the attestation", () => {
    const attestation = parseCircleAgentWalletFeeEstimateOutput(feeEstimateOutput(), {
      sender,
      recipient,
      amountMinor: 10_000n
    });
    expect(attestation.feeFieldsObserved).toContain("medium.networkFee");
    expect(attestation.mutationIdentifiersObserved).toBe(false);
    expect(JSON.stringify(attestation)).not.toContain("999999999999");
  });

  it.each([
    ["wrong chain", feeEstimateOutput({ blockchain: "BASE-SEPOLIA" })],
    ["missing medium fee", feeEstimateOutput({ medium: {} })],
    ["non-numeric medium fee", feeEstimateOutput({ medium: { networkFee: "unavailable" } })],
    ["error envelope", JSON.stringify({ error: { code: "AUTH_REQUIRED" } })],
    ["transaction id", feeEstimateOutput({ transactionId: "unexpected" })],
    ["tx id", feeEstimateOutput({ tx_id: "unexpected" })],
    ["challenge identifier", feeEstimateOutput({ challenge: "unexpected" })],
    ["nested challenge id", feeEstimateOutput({ detail: { challenge_id: "unexpected" } })]
  ])("rejects unsafe fee-estimate output: %s", (_label, stdout) => {
    expect(() => parseCircleAgentWalletFeeEstimateOutput(stdout, {
      sender,
      recipient,
      amountMinor: 10_000n
    })).toThrow(CircleAgentWalletCliError);
  });

  it("rejects oversized fee-estimate output", () => {
    const stdout = JSON.stringify({
      data: {
        blockchain: "ARC-TESTNET",
        medium: { gasLimit: "1" },
        padding: "x".repeat(128 * 1024)
      }
    });
    expect(() => parseCircleAgentWalletFeeEstimateOutput(stdout, {
      sender,
      recipient,
      amountMinor: 10_000n
    })).toThrow("bounded output size");
  });

  it.each([
    ["wrong state", { state: "FAILED" }],
    ["wrong chain", { blockchain: "BASE-SEPOLIA" }],
    ["wrong source", { sourceAddress: recipient }],
    ["wrong recipient", { destinationAddress: sender }],
    ["wrong amount", { amounts: ["0.02"] }],
    ["wrong operation", { operation: "CONTRACT_EXECUTION" }],
    ["wrong idempotency", { idempotencyKey: "00000000-0000-4000-8000-000000000000" }],
    ["wrong token", { contractAddress: sender }],
    ["wrong direction", { transactionType: "INBOUND" }]
  ])("rejects %s in a zero-exit response", (_label, override) => {
    expect(() => parseCircleAgentWalletTransferOutput(transferOutput(override), {
      sender,
      recipient,
      amountMinor: 10_000n,
      operationId
    })).toThrow(CircleAgentWalletCliError);
  });

  it.each(["", "not json", `${transferOutput()}\n${transferOutput()}`, JSON.stringify({ error: { code: "AUTH_REQUIRED" } })])(
    "rejects malformed or error-envelope output",
    (stdout) => {
      expect(() => parseCircleAgentWalletTransferOutput(stdout, {
        sender,
        recipient,
        amountMinor: 10_000n,
        operationId
      })).toThrow(CircleAgentWalletCliError);
    }
  );

  it("accepts a six-decimal normalization of the exact approved amount", () => {
    expect(parseCircleAgentWalletTransferOutput(transferOutput({ amounts: ["0.010000"] }), {
      sender,
      recipient,
      amountMinor: 10_000n,
      operationId
    })).toEqual({ id: "circle-tx-001", txHash });
    expect(() => parseCircleAgentWalletTransferOutput(transferOutput({ amounts: ["0.010001"] }), {
      sender,
      recipient,
      amountMinor: 10_000n,
      operationId
    })).toThrow("transaction amount mismatch");
  });

  it("fails before spawning on an amount cap or invalid operation id", async () => {
    const runner = vi.fn<CircleCliRunner>();
    const writer = createWriter(runner);
    await expect(writer.transferUsdc({ recipient, amountMinor: 20_000n, operationId }))
      .rejects.toThrow("exceeds the configured hard cap");
    await expect(writer.transferUsdc({ recipient, amountMinor: 10_000n, operationId: "not-a-uuid" }))
      .rejects.toThrow("canonical version-4 UUID");
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([
    "0x0000000000000000000000000000000000000000",
    sender,
    ARC_TESTNET_MEMO_ADDRESS,
    ARC_TESTNET_USDC_ADDRESS
  ] as const)("refuses unsafe recipient %s before spawning", async (unsafeRecipient) => {
    const runner = vi.fn<CircleCliRunner>();
    const writer = createWriter(runner);
    await expect(writer.transferUsdc({
      recipient: unsafeRecipient,
      amountMinor: 10_000n,
      operationId
    })).rejects.toThrow("external fixed payment address");
    expect(runner).not.toHaveBeenCalled();
  });

  it("refuses a CLI home readable by group or other users", async () => {
    const runner = vi.fn<CircleCliRunner>();
    const writer = createWriter(runner);
    const home = homes.at(-1);
    if (!home) throw new Error("Expected temporary home");
    chmodSync(home, 0o755);
    await expect(writer.transferUsdc({ recipient, amountMinor: 10_000n, operationId }))
      .rejects.toThrow("must not grant group or other access");
    expect(runner).not.toHaveBeenCalled();
  });

  it("refuses a CLI home without private owner traversal permissions", async () => {
    const runner = vi.fn<CircleCliRunner>();
    const writer = createWriter(runner);
    const home = homes.at(-1);
    if (!home) throw new Error("Expected temporary home");
    chmodSync(home, 0o600);
    await expect(writer.preflightIdentity()).rejects.toThrow("owner read, write, and execute");
    expect(runner).not.toHaveBeenCalled();
  });

  it("refuses relative or symlinked CLI homes before any CLI process", async () => {
    expect(() => new CircleAgentWalletCliWriter({
      sender,
      cliHome: "relative-circle-home",
      maxAmountMinor: 10_000n,
      runner: vi.fn<CircleCliRunner>()
    })).toThrow("absolute private directory path");

    const target = mkdtempSync(join(tmpdir(), "coffer-circle-agent-wallet-real-"));
    chmodSync(target, 0o700);
    const link = `${target}-link`;
    symlinkSync(target, link, "dir");
    homes.push(link, target);
    const runner = vi.fn<CircleCliRunner>();
    const writer = new CircleAgentWalletCliWriter({
      sender,
      cliHome: link,
      maxAmountMinor: 10_000n,
      runner
    });

    await expect(writer.preflightIdentity()).rejects.toThrow("not a symlink");
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("buildCircleCliEnvironment", () => {
  it("copies only the session/runtime allowlist", () => {
    const env = buildCircleCliEnvironment("/tmp/private-circle", {
      PATH: "/usr/bin",
      HOME: "/ambient-home-with-local-wallets",
      XDG_CONFIG_HOME: "/ambient-xdg-config",
      XDG_DATA_HOME: "/ambient-xdg-data",
      XDG_CACHE_HOME: "/ambient-xdg-cache",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      CIRCLE_API_KEY: "secret",
      CIRCLE_ENTITY_SECRET: "secret",
      CIRCLE_PROXY_URL: "https://evil.example",
      NODE_OPTIONS: "--require malicious"
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: devNull,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      CIRCLE_CLI_HOME: "/tmp/private-circle",
      CIRCLE_VERSION_CHECK: "off",
      DO_NOT_TRACK: "1",
      NO_COLOR: "1"
    });
  });

  it("keeps the pinned OWS local-wallet vault fail-closed behind the OS non-directory HOME", () => {
    const requireFromCircle = createRequire(pinnedEntry);
    const owsEntry = requireFromCircle.resolve("@open-wallet-standard/core");
    const output = execFileSync(process.execPath, [
      "-e",
      `const ows = require(process.argv[1]);
try {
  ows.listWallets();
  process.exit(9);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!/not a directory|os error 20|enotdir/i.test(message)) process.exit(8);
  process.stdout.write("ows-local-fallback-fail-closed");
}`,
      owsEntry
    ], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: devNull }
    });
    expect(output).toBe("ows-local-fallback-fail-closed");
  });
});

function createWriter(
  runner: CircleCliRunner,
  beforeTransfer?: (input: {
    sender: Address;
    recipient: Address;
    amountMinor: bigint;
    operationId: string;
  }) => Promise<void>
): CircleAgentWalletCliWriter {
  const cliHome = mkdtempSync(join(tmpdir(), "coffer-circle-agent-wallet-test-"));
  chmodSync(cliHome, 0o700);
  homes.push(cliHome);
  return new CircleAgentWalletCliWriter({
    sender,
    cliHome,
    maxAmountMinor: 10_000n,
    runner,
    ...(beforeTransfer ? { beforeTransfer } : {})
  });
}

function withAgentPreflight(transferRunner: CircleCliRunner): CircleCliRunner {
  return async (invocation) => {
    if (invocation.args.includes("list")) {
      return { exitCode: 0, stdout: agentWalletListOutput(sender), stderr: "" };
    }
    if (invocation.args.includes("--estimate")) {
      return { exitCode: 0, stdout: feeEstimateOutput(), stderr: "" };
    }
    return transferRunner(invocation);
  };
}

function agentWalletListOutput(
  address: Address,
  override: { type?: string; blockchain?: string } = {}
): string {
  return JSON.stringify({
    data: {
      wallets: [{
        type: override.type ?? "agent",
        address,
        blockchain: override.blockchain ?? "ARC-TESTNET",
        createDate: "2026-07-16T12:00:00Z"
      }]
    }
  });
}

function transferOutput(override: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data: {
      idempotencyKey: operationId,
      id: "circle-tx-001",
      state: "CONFIRMED",
      blockchain: "ARC-TESTNET",
      txHash,
      sourceAddress: sender,
      destinationAddress: recipient,
      amounts: ["0.01"],
      operation: "TRANSFER",
      transactionType: "OUTBOUND",
      contractAddress: ARC_TESTNET_USDC_ADDRESS,
      ...override
    }
  });
}

function feeEstimateOutput(override: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data: {
      blockchain: "ARC-TESTNET",
      medium: {
        gasLimit: "21000",
        maxFee: "0.000000001",
        networkFee: "999999999999"
      },
      callGasLimit: "50000",
      verificationGasLimit: "75000",
      preVerificationGas: "25000",
      ...override
    }
  });
}
