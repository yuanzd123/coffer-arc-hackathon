import { getAddress, type Address } from "viem";
import { CircleAgentWalletCliWriter } from "./circle-agent-wallet-writer";
import { HostedCofferArcClient, type HostedCofferArcClientOptions } from "./coffer-client";
import { CofferGuardedAgentWalletTransfer } from "./guarded-agent-wallet-transfer";
import type {
  CofferArcSpendIntent,
  ArcAgentWalletEvidenceVerifier,
  ArcAgentWalletWriter,
  GuardedAgentWalletTransferResult,
  InternalGuardedAgentWalletTransferResult
} from "./types";
import { createArcPublicClient, ViemArcEvidenceVerifier } from "./verifier";

export type CircleGuardedAgentWalletTransferFactoryOptions = Omit<
  HostedCofferArcClientOptions,
  "registryAddress" | "senderAddress" | "walletMode"
> & {
  senderAddress: Address;
  cliHome: string;
  maxAmountMinor: bigint;
  cliTimeoutMs?: number;
  rpcUrl?: string;
  now?: () => Date;
};

export type CircleGuardedAgentWalletTransferResult = GuardedAgentWalletTransferResult;

export type CircleGuardedAgentWalletExecutor = {
  execute(intent: CofferArcSpendIntent): Promise<CircleGuardedAgentWalletTransferResult>;
};

type CircleGuardedAgentWalletDependencies = {
  writer: ArcAgentWalletWriter;
  verifier: ArcAgentWalletEvidenceVerifier;
};

/**
 * Builds the only public Circle Agent Wallet execution path with one sender
 * bound across Coffer metadata, the fixed CLI writer, and Arc verification.
 */
export function createCircleGuardedAgentWalletTransfer(
  options: CircleGuardedAgentWalletTransferFactoryOptions
): CircleGuardedAgentWalletExecutor {
  return createCircleGuardedAgentWalletTransferWithDependencies(options, {
    writer: new CircleAgentWalletCliWriter({
      sender: options.senderAddress,
      cliHome: options.cliHome,
      maxAmountMinor: options.maxAmountMinor,
      ...(options.cliTimeoutMs === undefined ? {} : { timeoutMs: options.cliTimeoutMs })
    }),
    verifier: new ViemArcEvidenceVerifier(createArcPublicClient(options.rpcUrl))
  });
}

/** Internal module seam used to prove the public privacy boundary in tests. */
export function createCircleGuardedAgentWalletTransferWithDependencies(
  options: CircleGuardedAgentWalletTransferFactoryOptions,
  dependencies: CircleGuardedAgentWalletDependencies
): CircleGuardedAgentWalletExecutor {
  if (getAddress(dependencies.writer.sender) !== getAddress(options.senderAddress)) {
    throw new Error("Agent Wallet factory writer sender does not match the hosted Coffer sender");
  }
  const controlClient = new HostedCofferArcClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    senderAddress: options.senderAddress,
    walletMode: "agent_wallet_sca",
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs })
  });
  const internalExecutor = new CofferGuardedAgentWalletTransfer({
    controlClient,
    writer: dependencies.writer,
    verifier: dependencies.verifier,
    ...(options.now ? { now: options.now } : {})
  });
  return {
    async execute(intent) {
      return sanitizeAgentWalletTransferResult(await internalExecutor.execute(intent));
    }
  };
}

/** Internal module helper; intentionally not exported from the package root. */
export function sanitizeAgentWalletTransferResult(
  result: InternalGuardedAgentWalletTransferResult
): CircleGuardedAgentWalletTransferResult {
  if (result.state !== "settled") return result;
  const { providerTransactionId: _privateProviderReference, ...sanitized } = result;
  void _privateProviderReference;
  return sanitized;
}
