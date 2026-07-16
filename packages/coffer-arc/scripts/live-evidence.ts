import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  parseAbiItem,
  zeroAddress,
  type Address,
  type Hex
} from "viem";
import { arcTestnet } from "viem/chains";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_EXPLORER_URL,
  ARC_TESTNET_MEMO_ADDRESS,
  ARC_TESTNET_RPC_URL,
  ARC_TESTNET_USDC_ADDRESS,
  CircleArcWriter,
  CofferGuardedArcTransfer,
  HostedCofferArcClient,
  ViemArcEvidenceVerifier,
  buildDecisionCommitment,
  parseUsdAmountToUsdcMinor,
  type AnchorDecisionInput,
  type ArcDecisionWriter,
  type ArcWriteResult,
  type CofferArcControlClient,
  type CofferArcDecision,
  type CofferArcDecisionOutcome,
  type CofferArcSpendIntent,
  type GuardedArcTransferResult,
  type MemoUsdcTransferInput
} from "../src/index";

const scenarioOrder = ["block", "approval", "allow", "allow_replay"] as const;
type EvidenceScenarioId = (typeof scenarioOrder)[number];
type PrimaryScenarioId = Exclude<EvidenceScenarioId, "allow_replay">;
type GenerationMode = "fresh" | "recover_allow";
type HostedSettlementObservation =
  | "reported_by_current_execution"
  | "preexisting_reference"
  | "recovered_from_arc_and_reported";

type DeploymentManifest = {
  schemaVersion: 1;
  network: "ARC-TESTNET";
  chainId: number;
  registryAddress: Address;
  operator: Address;
  deploymentTransactionHash: Hex;
  deploymentBlockNumber: string;
  compilerVersion: string;
  optimizer: { enabled: true; runs: number };
  sourceHash: Hex;
  creationBytecodeHash: Hex;
  runtimeBytecodeHash: Hex;
  deployedAt: string;
};

type NonceSnapshot = { blockNumber: string; transactionCount: string };
type WriterCalls = { anchor: number; settlement: number };
type HistoricalNonceWindow = {
  beforeTransactionCount: string;
  afterTransactionCount: string;
  anchorNonce: string;
  settlementNonce: string;
  anchorTransactionIndex: string;
  settlementTransactionIndex: string;
};

type ScenarioRun = {
  id: EvidenceScenarioId;
  expectedOutcome: CofferArcDecisionOutcome;
  result: GuardedArcTransferResult;
  writerCalls: WriterCalls;
  before: NonceSnapshot;
  after: NonceSnapshot;
  historicalNonceWindow?: HistoricalNonceWindow;
  executionObservation?: "fresh_current_execution" | "recovered_historical_execution" | "replay_confirmation";
  hostedSettlementObservation?: HostedSettlementObservation;
};

const scenarios: Record<PrimaryScenarioId, {
  expectedOutcome: CofferArcDecisionOutcome;
  intent: Omit<CofferArcSpendIntent, "recipient" | "idempotencyKey">;
}> = {
  block: {
    expectedOutcome: "block",
    intent: {
      agentId: "external_research_agent",
      agentName: "External Research Agent",
      vendorId: "unknown-arc-vendor",
      vendorName: "Unknown Arc Vendor",
      amount: "0.01",
      businessPurpose: "Attempt a synthetic purchase from an unapproved agent vendor",
      taskId: "arc-research-block",
      taskDescription: "Demonstrate that a blocked destination never reaches the Arc wallet"
    }
  },
  approval: {
    expectedOutcome: "requires_approval",
    intent: {
      agentId: "external_research_agent",
      agentName: "External Research Agent",
      vendorId: "arc-data-agent",
      vendorName: "Arc Data Agent",
      amount: "12.00",
      businessPurpose: "Purchase an expanded synthetic market dataset for the Arc hackathon demo",
      taskId: "arc-research-approval",
      taskDescription: "Demonstrate that an agent cannot bypass Coffer's approval threshold"
    }
  },
  allow: {
    expectedOutcome: "allow",
    intent: {
      agentId: "external_research_agent",
      agentName: "External Research Agent",
      vendorId: "arc-data-agent",
      vendorName: "Arc Data Agent",
      amount: "0.01",
      businessPurpose: "Purchase a synthetic market signal for the Arc hackathon demo",
      taskId: "arc-research-allow",
      taskDescription: "Demonstrate a Coffer-approved agent payment settled in Arc Testnet USDC"
    }
  }
};

async function runLiveEvidence(): Promise<void> {
  requireExplicitTestnetWriteConfirmation();
  const options = parseOptions(process.argv.slice(2));
  const mode: GenerationMode = options.recoverAllow ? "recover_allow" : "fresh";
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  const manifestPath = path.resolve(
    repositoryRoot,
    options.manifest ?? process.env.COFFER_ARC_DEPLOYMENT_MANIFEST?.trim() ?? "deployments/arc-testnet.json"
  );
  const outputPath = path.resolve(
    repositoryRoot,
    options.output ?? process.env.COFFER_ARC_EVIDENCE_OUTPUT?.trim() ?? "deployments/arc-testnet-evidence.json"
  );
  const outputRelativePath = repositoryRelativePath(repositoryRoot, outputPath, "evidence output");
  await requireAbsentOutput(outputPath, outputRelativePath);
  const rpcUrl = verifiedRpcUrl(options.rpcUrl ?? process.env.ARC_RPC_URL?.trim() ?? ARC_TESTNET_RPC_URL);
  const manifestBytes = await fs.readFile(manifestPath);
  const manifest = parseDeploymentManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  const manifestSha256 = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;

  const cofferApiKey = requiredSecret("COFFER_API_KEY");
  const walletAddress = envAddress("CIRCLE_ARC_WALLET_ADDRESS");
  const registryAddress = envAddress("COFFER_ARC_REGISTRY_ADDRESS");
  const recipient = envAddress("COFFER_ARC_FIXED_RECIPIENT");
  const cofferBaseUrl = requiredTextEnv("COFFER_API_BASE_URL", 2_000);
  const runIds = {
    block: requiredUuidV4("ARC_DEMO_RUN_ID_BLOCK"),
    approval: requiredUuidV4("ARC_DEMO_RUN_ID_APPROVAL"),
    allow: requiredUuidV4("ARC_DEMO_RUN_ID_ALLOW")
  };
  const privateValues = [cofferApiKey, ...Object.values(runIds)];

  if (manifest.registryAddress !== registryAddress || manifest.operator !== walletAddress) {
    throw new Error("Deployment manifest, registry, and Circle EOA configuration do not match");
  }
  const configuredDeploymentBlock = process.env.COFFER_ARC_REGISTRY_DEPLOYMENT_BLOCK?.trim();
  if (configuredDeploymentBlock && configuredDeploymentBlock !== manifest.deploymentBlockNumber) {
    throw new Error("Configured registry deployment block does not match the manifest");
  }
  assertSafeRecipient(recipient, walletAddress, registryAddress);

  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl, { retryCount: 4, retryDelay: 500 })
  });
  const verifier = new ViemArcEvidenceVerifier(publicClient);
  await verifier.verifyNetwork(registryAddress);
  await verifyManifestDeployment(publicClient, manifest);

  let baseWriter: ArcDecisionWriter;
  if (mode === "fresh") {
    const apiKey = requiredSecret("CIRCLE_API_KEY");
    const entitySecret = requiredSecret("CIRCLE_ENTITY_SECRET");
    const walletId = requiredTextEnv("CIRCLE_ARC_WALLET_ID", 160);
    privateValues.push(apiKey, entitySecret, walletId);
    baseWriter = new CircleArcWriter({ apiKey, entitySecret, walletId, walletAddress });
  } else {
    baseWriter = new NoWriteRecoveryWriter(walletAddress);
  }
  const hostedClient = new HostedCofferArcClient({
    apiKey: cofferApiKey,
    baseUrl: cofferBaseUrl,
    registryAddress,
    senderAddress: walletAddress
  });
  const common = {
    recipient,
    registryAddress,
    registryDeploymentBlock: BigInt(manifest.deploymentBlockNumber),
    operator: walletAddress,
    hostedClient,
    baseWriter,
    verifier,
    publicClient
  };

  const runs: ScenarioRun[] = [];
  runs.push(await executeStandardScenario({ ...common, id: "block", runId: runIds.block, mode }));
  runs.push(await executeStandardScenario({ ...common, id: "approval", runId: runIds.approval, mode }));
  runs.push(mode === "recover_allow"
    ? await executeRecoveredAllow({ ...common, runId: runIds.allow })
    : await executeStandardScenario({ ...common, id: "allow", runId: runIds.allow, mode }));
  runs.push(await executeStandardScenario({ ...common, id: "allow_replay", runId: runIds.allow, mode }));

  assertOrderedRunInvariants(runs, mode);
  const evidence = buildEvidence({ manifest, manifestSha256, recipient, runs, mode });
  assertSecretFreeEvidence(evidence, privateValues);
  await writeEvidenceAtomically(
    outputPath,
    outputRelativePath,
    `${JSON.stringify(evidence, null, 2)}\n`
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    generationMode: mode,
    evidencePath: outputRelativePath,
    scenarioOrder,
    registryArcScanUrl: evidence.contracts.registryArcScanUrl,
    anchorArcScanUrl: evidence.scenarios.allow.anchor.arcScanUrl,
    settlementArcScanUrl: evidence.scenarios.allow.settlement.arcScanUrl,
    next: "pnpm --filter @coffer/arc evidence:verify"
  }, null, 2)}\n`);
}

type CommonExecutionInput = {
  recipient: Address;
  registryAddress: Address;
  registryDeploymentBlock: bigint;
  operator: Address;
  hostedClient: HostedCofferArcClient;
  baseWriter: ArcDecisionWriter;
  verifier: ViemArcEvidenceVerifier;
  publicClient: ReturnType<typeof createPublicClient>;
};

async function executeStandardScenario(input: CommonExecutionInput & {
  id: EvidenceScenarioId;
  runId: string;
  mode: GenerationMode;
}): Promise<ScenarioRun> {
  const primaryId = input.id === "allow_replay" ? "allow" : input.id;
  const scenario = scenarios[primaryId];
  const intent = buildScenarioIntent(primaryId, input.recipient, input.runId);
  const before = await captureNonceSnapshot(input.publicClient, input.operator);
  const writer = new EvidenceBoundWriter(
    input.baseWriter,
    input.id,
    input.registryAddress,
    input.recipient,
    input.mode === "fresh"
  );
  const guard = new CofferGuardedArcTransfer({
    controlClient: expectedOutcomeClient(input.hostedClient, scenario.expectedOutcome),
    writer,
    verifier: input.verifier,
    registryAddress: input.registryAddress,
    registryDeploymentBlock: input.registryDeploymentBlock
  });
  const result = await guard.execute(intent);
  const after = await captureNonceSnapshot(input.publicClient, input.operator);
  const historicalNonceWindow = result.state === "settled"
    ? await reconstructHistoricalNonceWindow(input.publicClient, input.operator, result)
    : undefined;
  const run: ScenarioRun = {
    id: input.id,
    expectedOutcome: scenario.expectedOutcome,
    result,
    writerCalls: { ...writer.calls },
    before,
    after,
    historicalNonceWindow,
    executionObservation: input.id === "allow"
      ? "fresh_current_execution"
      : input.id === "allow_replay" ? "replay_confirmation" : undefined,
    hostedSettlementObservation: input.id === "allow"
      ? "reported_by_current_execution"
      : input.id === "allow_replay" ? "preexisting_reference" : undefined
  };
  assertSingleRunInvariant(run, input.mode);
  return run;
}

async function executeRecoveredAllow(input: CommonExecutionInput & { runId: string }): Promise<ScenarioRun> {
  const intent = buildScenarioIntent("allow", input.recipient, input.runId);
  const before = await captureNonceSnapshot(input.publicClient, input.operator);
  const originalDecision = await input.hostedClient.requestDecision(intent);
  if (originalDecision.outcome !== "allow") {
    throw new Error(`Recovery expected allow, received ${originalDecision.outcome}; all Arc writes refused`);
  }
  const commitment = buildDecisionCommitment({
    spendRequestId: originalDecision.spendRequestId,
    decisionId: originalDecision.decisionId,
    spendDecisionRecordId: originalDecision.spendDecisionRecordId,
    outcome: originalDecision.outcome,
    agentId: intent.agentId,
    recipient: input.recipient,
    amountMinor: parseUsdAmountToUsdcMinor(intent.amount),
    idempotencyKey: intent.idempotencyKey
  });
  await input.verifier.verifyRegistryState({
    registryAddress: input.registryAddress,
    operator: input.operator,
    commitment,
    outcome: "allow",
    fromBlock: input.registryDeploymentBlock
  });
  const settlementTxHash = await findHistoricalSettlementHash(
    input.publicClient,
    input.operator,
    commitment,
    input.registryDeploymentBlock
  );
  if (originalDecision.settlementTxHash && normalizeHash(originalDecision.settlementTxHash) !== settlementTxHash) {
    throw new Error("Hosted settlement reference does not match the unique historical Arc Memo transaction");
  }
  const recoveredDecision: CofferArcDecision = { ...originalDecision, settlementTxHash };
  const recoveryControlClient = preloadedDecisionClient(recoveredDecision);
  const writer = new EvidenceBoundWriter(
    input.baseWriter,
    "allow",
    input.registryAddress,
    input.recipient,
    false
  );
  const guard = new CofferGuardedArcTransfer({
    controlClient: recoveryControlClient,
    writer,
    verifier: input.verifier,
    registryAddress: input.registryAddress,
    registryDeploymentBlock: input.registryDeploymentBlock
  });
  const result = await guard.execute(intent);
  if (result.state !== "settled") throw new Error("Recovered allow did not produce verified historical settlement evidence");

  let hostedSettlementObservation: HostedSettlementObservation = "preexisting_reference";
  if (!originalDecision.settlementTxHash) {
    const settlementBlock = await input.publicClient.getBlock({ blockNumber: result.settlement.blockNumber });
    await input.hostedClient.reportSettlement({
      spendRequestId: originalDecision.spendRequestId,
      amount: intent.amount,
      txHash: result.settlement.txHash,
      settledAt: new Date(Number(settlementBlock.timestamp) * 1_000).toISOString(),
      metadata: {
        chain: "Arc Testnet",
        network: "ARC-TESTNET",
        asset: "USDC",
        sender: input.operator,
        recipient: input.recipient,
        decisionCommitment: result.decisionCommitment,
        recordHash: result.recordHash,
        registryAddress: input.registryAddress,
        anchorTxHash: result.anchor.txHash,
        anchorBlockNumber: result.anchor.blockNumber.toString(),
        settlementBlockNumber: result.settlement.blockNumber.toString(),
        recoveryMode: "historical_arc_evidence"
      }
    });
    hostedSettlementObservation = "recovered_from_arc_and_reported";
  }
  const after = await captureNonceSnapshot(input.publicClient, input.operator);
  const historicalNonceWindow = await reconstructHistoricalNonceWindow(input.publicClient, input.operator, result);
  const run: ScenarioRun = {
    id: "allow",
    expectedOutcome: "allow",
    result,
    writerCalls: { ...writer.calls },
    before,
    after,
    historicalNonceWindow,
    executionObservation: "recovered_historical_execution",
    hostedSettlementObservation
  };
  assertSingleRunInvariant(run, "recover_allow");
  return run;
}

class NoWriteRecoveryWriter implements ArcDecisionWriter {
  constructor(readonly sender: Address) {}
  async anchorDecision(): Promise<ArcWriteResult> {
    throw new Error("Recovery mode forbids all Arc anchor writes");
  }
  async transferUsdcWithMemo(): Promise<ArcWriteResult> {
    throw new Error("Recovery mode forbids all Arc settlement writes");
  }
}

class EvidenceBoundWriter implements ArcDecisionWriter {
  readonly sender: Address;
  readonly calls: WriterCalls = { anchor: 0, settlement: 0 };

  constructor(
    private readonly inner: ArcDecisionWriter,
    private readonly scenarioId: EvidenceScenarioId,
    private readonly registryAddress: Address,
    private readonly recipient: Address,
    private readonly freshWritesEnabled: boolean
  ) {
    this.sender = getAddress(inner.sender);
  }

  async anchorDecision(input: AnchorDecisionInput): Promise<ArcWriteResult> {
    this.calls.anchor += 1;
    if (!this.freshWritesEnabled || this.scenarioId !== "allow") {
      throw new Error(`${this.scenarioId} is not permitted to call the Arc anchor writer`);
    }
    if (getAddress(input.registryAddress) !== this.registryAddress || input.outcome !== "allow") {
      throw new Error("Allow evidence anchor does not match the fixed Registry boundary");
    }
    return this.inner.anchorDecision(input);
  }

  async transferUsdcWithMemo(input: MemoUsdcTransferInput): Promise<ArcWriteResult> {
    this.calls.settlement += 1;
    if (!this.freshWritesEnabled || this.scenarioId !== "allow") {
      throw new Error(`${this.scenarioId} is not permitted to call the Arc settlement writer`);
    }
    if (getAddress(input.recipient) !== this.recipient || input.amountMinor !== 10_000n) {
      throw new Error("Allow evidence settlement does not match the fixed $0.01 recipient boundary");
    }
    return this.inner.transferUsdcWithMemo(input);
  }
}

function expectedOutcomeClient(
  inner: CofferArcControlClient,
  expectedOutcome: CofferArcDecisionOutcome
): CofferArcControlClient {
  return {
    async requestDecision(intent) {
      const decision = await inner.requestDecision(intent);
      if (decision.outcome !== expectedOutcome) {
        throw new Error(`Coffer returned ${decision.outcome}; expected ${expectedOutcome}; all Arc writes refused`);
      }
      return decision;
    },
    reportSettlement: (report) => inner.reportSettlement(report)
  };
}

function preloadedDecisionClient(decision: CofferArcDecision): CofferArcControlClient {
  let served = false;
  return {
    async requestDecision() {
      if (served) throw new Error("Recovery decision may only be consumed once");
      served = true;
      return decision;
    },
    async reportSettlement() {
      throw new Error("Recovery guard must not report an injected replay as a new settlement");
    }
  };
}

async function findHistoricalSettlementHash(
  client: ReturnType<typeof createPublicClient>,
  operator: Address,
  commitment: Hex,
  fromBlock: bigint
): Promise<Hex> {
  const memoEvent = parseAbiItem(
    "event Memo(address indexed sender,address indexed target,bytes32 callDataHash,bytes32 indexed memoId,bytes memo,uint256 memoIndex)"
  );
  const logs = await client.getLogs({
    address: ARC_TESTNET_MEMO_ADDRESS,
    event: memoEvent,
    args: { sender: operator, target: ARC_TESTNET_USDC_ADDRESS, memoId: commitment },
    fromBlock,
    toBlock: "latest"
  });
  const hashes = [...new Set(logs.map((log) => log.transactionHash?.toLowerCase()).filter(Boolean))];
  if (logs.length !== 1 || hashes.length !== 1 || !hashes[0] || !/^0x[a-f0-9]{64}$/.test(hashes[0])) {
    throw new Error(`Recovery expected one historical Memo settlement for the commitment, found ${logs.length}`);
  }
  return hashes[0] as Hex;
}

async function reconstructHistoricalNonceWindow(
  client: ReturnType<typeof createPublicClient>,
  operator: Address,
  result: Extract<GuardedArcTransferResult, { state: "settled" }>
): Promise<HistoricalNonceWindow> {
  const [anchorTx, anchorReceipt, settlementTx, settlementReceipt] = await Promise.all([
    client.getTransaction({ hash: result.anchor.txHash }),
    client.getTransactionReceipt({ hash: result.anchor.txHash }),
    client.getTransaction({ hash: result.settlement.txHash }),
    client.getTransactionReceipt({ hash: result.settlement.txHash })
  ]);
  if (
    anchorReceipt.status !== "success" || settlementReceipt.status !== "success" ||
    getAddress(anchorTx.from) !== operator || getAddress(settlementTx.from) !== operator ||
    anchorTx.blockNumber !== anchorReceipt.blockNumber || settlementTx.blockNumber !== settlementReceipt.blockNumber ||
    anchorReceipt.blockNumber !== result.anchor.blockNumber || settlementReceipt.blockNumber !== result.settlement.blockNumber
  ) {
    throw new Error("Historical allow transactions or receipts do not match the verified result");
  }
  const anchorNonce = BigInt(anchorTx.nonce);
  const settlementNonce = BigInt(settlementTx.nonce);
  if (settlementNonce !== anchorNonce + 1n) throw new Error("Historical allow transactions do not use consecutive operator nonces");
  if (
    anchorReceipt.blockNumber > settlementReceipt.blockNumber ||
    (anchorReceipt.blockNumber === settlementReceipt.blockNumber && anchorReceipt.transactionIndex >= settlementReceipt.transactionIndex)
  ) {
    throw new Error("Historical settlement was not ordered after its Registry anchor");
  }
  return {
    beforeTransactionCount: anchorNonce.toString(),
    afterTransactionCount: (settlementNonce + 1n).toString(),
    anchorNonce: anchorNonce.toString(),
    settlementNonce: settlementNonce.toString(),
    anchorTransactionIndex: anchorReceipt.transactionIndex.toString(),
    settlementTransactionIndex: settlementReceipt.transactionIndex.toString()
  };
}

function buildScenarioIntent(id: PrimaryScenarioId, recipient: Address, runId: string): CofferArcSpendIntent {
  return {
    ...scenarios[id].intent,
    recipient,
    idempotencyKey: `arc:${id}:${requireUuidV4Value(runId, "scenario run ID")}`,
    metadata: { demoScenario: id, syntheticDataOnly: true, publicDemoContract: "hackathon-v1" }
  };
}

async function captureNonceSnapshot(
  client: ReturnType<typeof createPublicClient>,
  operator: Address
): Promise<NonceSnapshot> {
  const blockNumber = await client.getBlockNumber();
  const transactionCount = await client.getTransactionCount({ address: operator, blockNumber });
  return { blockNumber: blockNumber.toString(), transactionCount: transactionCount.toString() };
}

function assertSingleRunInvariant(run: ScenarioRun, mode: GenerationMode): void {
  if (run.result.decision.outcome !== run.expectedOutcome) throw new Error(`${run.id} returned an unexpected outcome`);
  if (BigInt(run.after.blockNumber) < BigInt(run.before.blockNumber)) throw new Error(`${run.id} nonce window moved backwards`);
  if (run.id === "block" || run.id === "approval") {
    if (run.result.state !== "not_executed") throw new Error(`${run.id} unexpectedly reached settlement`);
    if (run.writerCalls.anchor !== 0 || run.writerCalls.settlement !== 0) throw new Error(`${run.id} touched the Arc writer`);
    if (run.before.transactionCount !== run.after.transactionCount) throw new Error(`${run.id} changed the operator transaction count`);
    return;
  }
  if (run.result.state !== "settled" || !run.historicalNonceWindow) throw new Error(`${run.id} lacks verified settlement history`);
  if (run.id === "allow_replay") {
    if (!run.result.replayed || run.writerCalls.anchor !== 0 || run.writerCalls.settlement !== 0) {
      throw new Error("Allow replay was not a writer-free replay confirmation");
    }
    if (run.before.transactionCount !== run.after.transactionCount) throw new Error("Allow replay changed the operator transaction count");
    return;
  }
  const currentDelta = BigInt(run.after.transactionCount) - BigInt(run.before.transactionCount);
  if (mode === "fresh") {
    if (run.result.replayed) {
      throw new Error("Allow run ID was already settled; use a fresh UUIDv4 or explicitly rerun with --recover-allow");
    }
    if (run.writerCalls.anchor !== 1 || run.writerCalls.settlement !== 1 || currentDelta !== 2n) {
      throw new Error("Fresh allow must add exactly one Registry transaction and one Memo transaction; recovery requires --recover-allow");
    }
    if (
      run.historicalNonceWindow.beforeTransactionCount !== run.before.transactionCount ||
      run.historicalNonceWindow.afterTransactionCount !== run.after.transactionCount ||
      BigInt(run.result.anchor.blockNumber) <= BigInt(run.before.blockNumber)
    ) throw new Error("Fresh allow historical transaction window does not match the current execution window");
    return;
  }
  if (!run.result.replayed || run.writerCalls.anchor !== 0 || run.writerCalls.settlement !== 0 || currentDelta !== 0n) {
    throw new Error("Recovery must use historical transactions and create no current operator transaction");
  }
  if (
    BigInt(run.result.anchor.blockNumber) > BigInt(run.before.blockNumber) ||
    BigInt(run.result.settlement.blockNumber) > BigInt(run.before.blockNumber) ||
    BigInt(run.before.transactionCount) < BigInt(run.historicalNonceWindow.afterTransactionCount)
  ) throw new Error("Recovery transactions were not fully mined before the current recovery observation");
}

function assertOrderedRunInvariants(runs: ScenarioRun[], mode: GenerationMode): void {
  if (runs.length !== scenarioOrder.length || runs.some((run, index) => run.id !== scenarioOrder[index])) {
    throw new Error("Evidence scenarios did not execute in block -> approval -> allow -> allow replay order");
  }
  const [block, approval, allow, replay] = runs;
  if (!block || !approval || !allow || !replay || allow.result.state !== "settled" || replay.result.state !== "settled") {
    throw new Error("Evidence run is incomplete");
  }
  if (
    block.after.transactionCount !== approval.before.transactionCount ||
    approval.after.transactionCount !== allow.before.transactionCount ||
    allow.after.transactionCount !== replay.before.transactionCount
  ) throw new Error("Unexpected operator transaction occurred between evidence scenarios");
  if (mode === "recover_allow") {
    const counts = runs.flatMap((run) => [run.before.transactionCount, run.after.transactionCount]);
    if (counts.some((count) => count !== counts[0])) throw new Error("Recovery observation contains a current operator transaction");
  }
  for (const field of ["decisionCommitment", "recordHash"] as const) {
    if (normalizeHash(allow.result[field]) !== normalizeHash(replay.result[field])) throw new Error(`Replay ${field} mismatch`);
  }
  if (
    normalizeHash(allow.result.anchor.txHash) !== normalizeHash(replay.result.anchor.txHash) ||
    allow.result.anchor.blockNumber !== replay.result.anchor.blockNumber ||
    normalizeHash(allow.result.settlement.txHash) !== normalizeHash(replay.result.settlement.txHash) ||
    allow.result.settlement.blockNumber !== replay.result.settlement.blockNumber ||
    getAddress(allow.result.settlement.sender) !== getAddress(replay.result.settlement.sender) ||
    getAddress(allow.result.settlement.recipient) !== getAddress(replay.result.settlement.recipient) ||
    allow.result.settlement.amountMinor !== replay.result.settlement.amountMinor ||
    normalizeHash(allow.result.settlement.memoId) !== normalizeHash(replay.result.settlement.memoId) ||
    normalizeHash(allow.result.settlement.memoData) !== normalizeHash(replay.result.settlement.memoData) ||
    normalizeHash(allow.result.settlement.callDataHash) !== normalizeHash(replay.result.settlement.callDataHash) ||
    JSON.stringify(allow.historicalNonceWindow) !== JSON.stringify(replay.historicalNonceWindow)
  ) throw new Error("Replay onchain evidence is not fully identical to the original allow evidence");
}

function buildEvidence(input: {
  manifest: DeploymentManifest;
  manifestSha256: string;
  recipient: Address;
  runs: ScenarioRun[];
  mode: GenerationMode;
}) {
  const byId = Object.fromEntries(input.runs.map((run) => [run.id, run])) as Record<EvidenceScenarioId, ScenarioRun>;
  const block = requireNotExecuted(byId.block);
  const approval = requireNotExecuted(byId.approval);
  const allow = requireSettled(byId.allow);
  const replay = requireSettled(byId.allow_replay);
  const notExecuted = (run: typeof block) => ({
    expectedOutcome: run.expectedOutcome,
    observedOutcome: run.result.decision.outcome,
    executionState: run.result.state,
    writerCalls: run.writerCalls,
    currentOperatorNonceWindow: { before: run.before, after: run.after },
    arcTransactions: [] as never[]
  });
  const settled = (run: typeof allow) => ({
    expectedOutcome: run.expectedOutcome,
    observedOutcome: run.result.decision.outcome,
    executionState: run.result.state,
    replayed: run.result.replayed,
    executionObservation: run.executionObservation,
    hostedSettlementObservation: run.hostedSettlementObservation,
    recordHash: normalizeHash(run.result.recordHash),
    decisionCommitment: normalizeHash(run.result.decisionCommitment),
    writerCalls: run.writerCalls,
    currentOperatorNonceWindow: { before: run.before, after: run.after },
    historicalOperatorNonceWindow: run.historicalNonceWindow,
    anchor: {
      transactionHash: normalizeHash(run.result.anchor.txHash),
      blockNumber: run.result.anchor.blockNumber.toString(),
      arcScanUrl: transactionExplorerUrl(run.result.anchor.txHash)
    },
    settlement: {
      transactionHash: normalizeHash(run.result.settlement.txHash),
      blockNumber: run.result.settlement.blockNumber.toString(),
      sender: getAddress(run.result.settlement.sender),
      recipient: getAddress(run.result.settlement.recipient),
      amountMinor: run.result.settlement.amountMinor.toString(),
      memoId: normalizeHash(run.result.settlement.memoId),
      memoData: normalizeHash(run.result.settlement.memoData),
      callDataHash: normalizeHash(run.result.settlement.callDataHash),
      arcScanUrl: transactionExplorerUrl(run.result.settlement.txHash)
    }
  });
  return {
    schemaVersion: 2,
    artifact: "coffer-arc-live-evidence",
    network: "ARC-TESTNET",
    chainId: ARC_TESTNET_CHAIN_ID,
    generationMode: input.mode,
    generatedAt: new Date().toISOString(),
    deploymentManifestSha256: input.manifestSha256,
    verificationScope: {
      hostedAndWriterObservations: "attested_by_secret_backed_runner",
      onchainEvidence: "independently_verified_from_public_source_manifest_and_arc_rpc"
    },
    contracts: {
      registryAddress: input.manifest.registryAddress,
      registryOperator: input.manifest.operator,
      registryDeploymentBlock: input.manifest.deploymentBlockNumber,
      registryRuntimeBytecodeHash: normalizeHash(input.manifest.runtimeBytecodeHash),
      registryTransactionHash: normalizeHash(input.manifest.deploymentTransactionHash),
      registryArcScanUrl: addressExplorerUrl(input.manifest.registryAddress),
      registryTransactionArcScanUrl: transactionExplorerUrl(input.manifest.deploymentTransactionHash),
      memoAddress: getAddress(ARC_TESTNET_MEMO_ADDRESS),
      usdcAddress: getAddress(ARC_TESTNET_USDC_ADDRESS),
      fixedRecipient: input.recipient,
      fixedRecipientArcScanUrl: addressExplorerUrl(input.recipient)
    },
    scenarioOrder,
    scenarios: {
      block: notExecuted(block),
      approval: notExecuted(approval),
      allow: settled(allow),
      allowReplay: settled(replay)
    },
    invariants: {
      blockedBeforeWallet: true,
      approvalPausedBeforeWallet: true,
      allowAnchoredThenSettled: true,
      replayUsedOriginalEvidence: true,
      independentVerificationCommand: "pnpm --filter @coffer/arc evidence:verify"
    }
  } as const;
}

function requireNotExecuted(run: ScenarioRun | undefined) {
  if (!run || run.result.state !== "not_executed") throw new Error("Expected non-executed evidence run");
  return run as ScenarioRun & { result: Extract<GuardedArcTransferResult, { state: "not_executed" }> };
}

function requireSettled(run: ScenarioRun | undefined) {
  if (!run || run.result.state !== "settled" || !run.historicalNonceWindow || !run.executionObservation || !run.hostedSettlementObservation) {
    throw new Error("Expected complete settled evidence run");
  }
  return run as ScenarioRun & {
    result: Extract<GuardedArcTransferResult, { state: "settled" }>;
    historicalNonceWindow: HistoricalNonceWindow;
    executionObservation: NonNullable<ScenarioRun["executionObservation"]>;
    hostedSettlementObservation: HostedSettlementObservation;
  };
}

async function verifyManifestDeployment(client: ReturnType<typeof createPublicClient>, manifest: DeploymentManifest): Promise<void> {
  const runtimeCode = await client.getCode({ address: manifest.registryAddress });
  if (!runtimeCode || runtimeCode === "0x" || keccak256(runtimeCode).toLowerCase() !== manifest.runtimeBytecodeHash.toLowerCase()) {
    throw new Error("Registry runtime bytecode does not match the deployment manifest");
  }
  const receipt = await client.getTransactionReceipt({ hash: manifest.deploymentTransactionHash });
  if (
    receipt.status !== "success" || !receipt.contractAddress ||
    getAddress(receipt.contractAddress) !== manifest.registryAddress || getAddress(receipt.from) !== manifest.operator ||
    receipt.blockNumber.toString() !== manifest.deploymentBlockNumber
  ) throw new Error("Registry deployment receipt does not match the deployment manifest");
}

function parseDeploymentManifest(value: unknown): DeploymentManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Deployment manifest must be an object");
  const manifest = value as Record<string, unknown>;
  assertExactKeys(manifest, [
    "schemaVersion", "network", "chainId", "registryAddress", "operator", "deploymentTransactionHash",
    "deploymentBlockNumber", "compilerVersion", "optimizer", "sourceHash", "creationBytecodeHash",
    "runtimeBytecodeHash", "deployedAt"
  ], "deployment manifest");
  if (manifest.schemaVersion !== 1 || manifest.network !== "ARC-TESTNET" || manifest.chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error("Deployment manifest is not the supported Arc Testnet schema");
  }
  if (typeof manifest.compilerVersion !== "string" || !manifest.compilerVersion.trim()) throw new Error("Manifest compilerVersion is invalid");
  if (!manifest.optimizer || typeof manifest.optimizer !== "object" || Array.isArray(manifest.optimizer)) throw new Error("Manifest optimizer is invalid");
  const optimizer = manifest.optimizer as Record<string, unknown>;
  assertExactKeys(optimizer, ["enabled", "runs"], "manifest optimizer");
  if (optimizer.enabled !== true || !Number.isSafeInteger(optimizer.runs) || Number(optimizer.runs) <= 0) throw new Error("Manifest optimizer is invalid");
  if (typeof manifest.deployedAt !== "string" || new Date(manifest.deployedAt).toISOString() !== manifest.deployedAt) throw new Error("Manifest deployedAt is invalid");
  return {
    schemaVersion: 1,
    network: "ARC-TESTNET",
    chainId: ARC_TESTNET_CHAIN_ID,
    registryAddress: canonicalAddress(manifest.registryAddress, "registry address"),
    operator: canonicalAddress(manifest.operator, "registry operator"),
    deploymentTransactionHash: bytes32(manifest.deploymentTransactionHash, "deployment transaction hash"),
    deploymentBlockNumber: decimalString(manifest.deploymentBlockNumber, "deployment block number"),
    compilerVersion: manifest.compilerVersion,
    optimizer: { enabled: true, runs: Number(optimizer.runs) },
    sourceHash: bytes32(manifest.sourceHash, "source hash"),
    creationBytecodeHash: bytes32(manifest.creationBytecodeHash, "creation bytecode hash"),
    runtimeBytecodeHash: bytes32(manifest.runtimeBytecodeHash, "runtime bytecode hash"),
    deployedAt: manifest.deployedAt
  };
}

function assertSafeRecipient(recipient: Address, operator: Address, registry: Address): void {
  const forbidden = new Set([
    zeroAddress, operator, registry, getAddress(ARC_TESTNET_MEMO_ADDRESS), getAddress(ARC_TESTNET_USDC_ADDRESS)
  ].map((value) => value.toLowerCase()));
  if (forbidden.has(recipient.toLowerCase())) throw new Error("Fixed recipient is unsafe or points at a system address");
}

function assertSecretFreeEvidence(value: unknown, secretValues: string[]): void {
  const forbiddenKey = /(api.?key|secret|authorization|wallet.?id|run.?id|idempotency|spend.?request.?id|decision.?id|spend.?decision.?record.?id|circle.?transaction.?id)/i;
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) return current.forEach(visit);
    if (!current || typeof current !== "object") return;
    for (const [key, nested] of Object.entries(current)) {
      if (forbiddenKey.test(key)) throw new Error(`Evidence contains forbidden private field: ${key}`);
      visit(nested);
    }
  };
  visit(value);
  const serialized = JSON.stringify(value);
  for (const secret of secretValues.filter((item) => item.length >= 8)) {
    if (serialized.includes(secret)) throw new Error("Evidence contains a configured private value");
  }
  if (/(?:Bearer\s+|CIRCLE_API_KEY|COFFER_API_KEY|CIRCLE_ENTITY_SECRET)/i.test(serialized)) throw new Error("Evidence contains a credential marker");
}

function parseOptions(args: string[]): { manifest?: string; output?: string; rpcUrl?: string; recoverAllow: boolean } {
  const result: { manifest?: string; output?: string; rpcUrl?: string; recoverAllow: boolean } = { recoverAllow: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") continue;
    if (arg === "--recover-allow") {
      if (result.recoverAllow) throw new Error("--recover-allow may only be provided once");
      result.recoverAllow = true;
      continue;
    }
    const next = args[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg ?? "option"} requires a value`);
    if (arg === "--manifest") result.manifest = next;
    else if (arg === "--output") result.output = next;
    else if (arg === "--rpc-url") result.rpcUrl = next;
    else throw new Error(`Unsupported option: ${arg}`);
    index += 1;
  }
  return result;
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} keys are invalid`);
}

async function requireAbsentOutput(outputPath: string, displayPath: string): Promise<void> {
  try {
    await fs.lstat(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Evidence output already exists; refusing all live calls: ${displayPath}`);
}

function repositoryRelativePath(root: string, target: string, label: string): string {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} must be inside the repository`);
  return relative.split(path.sep).join("/");
}

function requireExplicitTestnetWriteConfirmation(): void {
  if (process.env.ARC_WRITE_ENABLED !== "true" || process.env.CONFIRM_ARC_TESTNET_ONLY !== "ARC_TESTNET") {
    throw new Error("Live evidence requires ARC_WRITE_ENABLED=true and CONFIRM_ARC_TESTNET_ONLY=ARC_TESTNET");
  }
}

function requiredTextEnv(name: string, maxLength: number): string {
  const value = process.env[name]?.trim();
  if (!value || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${name} is missing or invalid`);
  return value;
}

function requiredSecret(name: string): string {
  const value = requiredTextEnv(name, 2_000);
  if (value.length < 16) throw new Error(`${name} is invalid`);
  return value;
}

function requiredUuidV4(name: string): string {
  return requireUuidV4Value(requiredTextEnv(name, 64), name);
}

function requireUuidV4Value(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) throw new Error(`${label} must be a UUIDv4`);
  return normalized;
}

function envAddress(name: string): Address {
  return canonicalAddress(requiredTextEnv(name, 64), name);
}

function canonicalAddress(value: unknown, label: string): Address {
  if (typeof value !== "string") throw new Error(`${label} must be an EVM address`);
  try { return getAddress(value); } catch { throw new Error(`${label} must be an EVM address`); }
}

function bytes32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error(`${label} must be 32-byte hex`);
  return normalizeHash(value as Hex);
}

function decimalString(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`${label} must be an unsigned decimal string`);
  return value;
}

function verifiedRpcUrl(value: string): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") ||
    parsed.username || parsed.password || parsed.hash || parsed.search
  ) {
    throw new Error("Arc RPC URL must be credential-free HTTPS except on localhost");
  }
  return parsed.toString();
}

function normalizeHash(value: Hex): Hex { return value.toLowerCase() as Hex; }
function transactionExplorerUrl(hash: Hex): string { return `${ARC_TESTNET_EXPLORER_URL}/tx/${normalizeHash(hash)}`; }
function addressExplorerUrl(address: Address): string { return `${ARC_TESTNET_EXPLORER_URL}/address/${getAddress(address)}`; }

function sanitizeError(error: unknown): string {
  let message = error instanceof Error ? error.message : "unknown failure";
  for (const name of [
    "CIRCLE_API_KEY",
    "CIRCLE_ENTITY_SECRET",
    "CIRCLE_ARC_WALLET_ID",
    "COFFER_API_KEY",
    "ARC_DEMO_RUN_ID_BLOCK",
    "ARC_DEMO_RUN_ID_APPROVAL",
    "ARC_DEMO_RUN_ID_ALLOW",
    "ARC_RPC_URL"
  ]) {
    const value = process.env[name];
    if (value) message = message.replaceAll(value, `[${name} redacted]`);
  }
  message = message
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(
      /(["']?(?:api[-_ ]?key|entity[-_ ]?secret(?:[-_ ]?ciphertext)?|authorization|wallet[-_ ]?id|provider[-_ ]?transaction[-_ ]?id|transaction[-_ ]?id|idempotency[-_ ]?key|run[-_ ]?id)["']?\s*[:=]\s*["']?)([^"',}\]\s]+)/gi,
      "$1[redacted]"
    )
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[identifier redacted]");
  return message.slice(0, 2_000).replace(/[\u0000-\u001f\u007f]/g, " ");
}

async function withConsoleSuppressed<T>(operation: () => Promise<T>): Promise<T> {
  const methods = ["debug", "dir", "dirxml", "error", "info", "log", "table", "trace", "warn"] as const;
  const mutableConsole = console as unknown as Record<(typeof methods)[number], (...args: unknown[]) => void>;
  const originals = new Map<(typeof methods)[number], (...args: unknown[]) => void>();
  for (const method of methods) {
    originals.set(method, mutableConsole[method]);
    mutableConsole[method] = () => undefined;
  }
  try {
    return await operation();
  } finally {
    for (const method of methods) {
      const original = originals.get(method);
      if (original) mutableConsole[method] = original;
    }
  }
}

async function writeEvidenceAtomically(outputPath: string, displayPath: string, contents: string): Promise<void> {
  const directory = path.dirname(outputPath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(outputPath)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let temporaryExists = false;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await fs.link(temporaryPath, outputPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Evidence output already exists; refusing to overwrite: ${displayPath}`);
      }
      throw error;
    }
    await syncDirectory(directory);
    await fs.unlink(temporaryPath);
    temporaryExists = false;
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    if (temporaryExists) await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function runSelfTest(): Promise<void> {
  const uuid = "11111111-1111-4111-8111-111111111111";
  if (requireUuidV4Value(uuid, "self-test") !== uuid) throw new Error("UUIDv4 self-test failed");
  const options = parseOptions(["--recover-allow", "--output", "deployments/test.json"]);
  if (!options.recoverAllow || options.output !== "deployments/test.json") throw new Error("Recovery option self-test failed");
  let rejected = false;
  try { assertSecretFreeEvidence({ apiKey: "not-public" }, []); } catch { rejected = true; }
  if (!rejected) throw new Error("Secret field self-test failed");
  if (scenarioOrder.join(",") !== "block,approval,allow,allow_replay") throw new Error("Scenario order self-test failed");

  const testDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coffer-arc-evidence-"));
  try {
    const testOutput = path.join(testDirectory, "evidence.json");
    await writeEvidenceAtomically(testOutput, "evidence.json", "first\n");
    if (await fs.readFile(testOutput, "utf8") !== "first\n") throw new Error("Atomic evidence write self-test failed");
    rejected = false;
    try { await writeEvidenceAtomically(testOutput, "evidence.json", "second\n"); } catch { rejected = true; }
    if (!rejected || await fs.readFile(testOutput, "utf8") !== "first\n") {
      throw new Error("Evidence no-overwrite self-test failed");
    }
    if ((await fs.readdir(testDirectory)).length !== 1) throw new Error("Atomic evidence write left a temporary file");
  } finally {
    await fs.rm(testDirectory, { recursive: true, force: true });
  }

  let leakedConsoleCalls = 0;
  const originalConsoleError = console.error;
  console.error = () => { leakedConsoleCalls += 1; };
  try {
    await withConsoleSuppressed(async () => { console.error("private SDK diagnostic"); });
  } finally {
    console.error = originalConsoleError;
  }
  if (leakedConsoleCalls !== 0) throw new Error("Console suppression self-test failed");

  const priorWalletId = process.env.CIRCLE_ARC_WALLET_ID;
  process.env.CIRCLE_ARC_WALLET_ID = uuid;
  try {
    const sanitized = sanitizeError(new Error(`walletId=${uuid} providerTransactionId=${randomUUID()}`));
    if (sanitized.includes(uuid) || /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}/i.test(sanitized)) {
      throw new Error("Identifier sanitization self-test failed");
    }
  } finally {
    if (priorWalletId === undefined) delete process.env.CIRCLE_ARC_WALLET_ID;
    else process.env.CIRCLE_ARC_WALLET_ID = priorWalletId;
  }
  process.stdout.write("Arc live evidence generator self-test passed.\n");
}

// Run only after every class declaration has been initialized. Top-level await
// above the writer classes would otherwise trigger their temporal dead zone.
if (process.argv.includes("--self-test")) {
  await runSelfTest();
} else {
  await withConsoleSuppressed(runLiveEvidence).catch((error: unknown) => {
    process.stderr.write(`Arc evidence generation failed: ${sanitizeError(error)}\n`);
    process.exitCode = 1;
  });
}
