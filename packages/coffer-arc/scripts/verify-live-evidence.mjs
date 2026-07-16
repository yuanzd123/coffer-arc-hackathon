import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbiItem
} from "viem";
import { arcTestnet } from "viem/chains";
import { compileDecisionRegistry, materializeRegistryRuntimeBytecode } from "./contract-artifact.mjs";

const ARC_CHAIN_ID = 5_042_002;
const ARC_RPC_URL = process.env.ARC_RPC_URL?.trim() || "https://rpc.blockdaemon.testnet.arc.io";
const ARC_EXPLORER_URL = "https://testnet.arcscan.app";
const ARC_USDC = getAddress("0x3600000000000000000000000000000000000000");
const ARC_MEMO = getAddress("0x5294E9927c3306DcBaDb03fe70b92e01cCede505");
const scenarioOrder = ["block", "approval", "allow", "allow_replay"];

const registryAbi = [
  { type: "function", name: "operator", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    type: "function", name: "anchorDecision", stateMutability: "nonpayable",
    inputs: [{ name: "commitment", type: "bytes32" }, { name: "outcome", type: "uint8" }], outputs: []
  },
  {
    type: "function", name: "getDecision", stateMutability: "view",
    inputs: [{ name: "commitment", type: "bytes32" }],
    outputs: [{
      name: "", type: "tuple",
      components: [
        { name: "exists", type: "bool" },
        { name: "outcome", type: "uint8" },
        { name: "anchoredAtBlock", type: "uint64" }
      ]
    }]
  },
  {
    type: "event", name: "DecisionAnchored", anonymous: false,
    inputs: [
      { name: "commitment", type: "bytes32", indexed: true },
      { name: "outcome", type: "uint8", indexed: true },
      { name: "operator", type: "address", indexed: true },
      { name: "anchoredAtBlock", type: "uint64", indexed: false }
    ]
  }
];

const memoAbi = [
  {
    type: "function", name: "memo", stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
      { name: "memoId", type: "bytes32" },
      { name: "memoData", type: "bytes" }
    ], outputs: []
  },
  {
    type: "event", name: "Memo", anonymous: false,
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "target", type: "address", indexed: true },
      { name: "callDataHash", type: "bytes32", indexed: false },
      { name: "memoId", type: "bytes32", indexed: true },
      { name: "memo", type: "bytes", indexed: false },
      { name: "memoIndex", type: "uint256", indexed: false }
    ]
  }
];

const usdcAbi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  {
    type: "function", name: "transfer", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "event", name: "Transfer", anonymous: false,
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false }
    ]
  }
];

if (process.argv.includes("--self-test")) {
  runSelfTest();
} else {
  await main().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown verification failure";
    process.stderr.write(`Arc evidence verification failed: ${message.slice(0, 2_000).replace(/[\u0000-\u001f\u007f]/g, " ")}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  const manifestPath = path.resolve(
    repositoryRoot,
    options.manifest ?? process.env.COFFER_ARC_DEPLOYMENT_MANIFEST?.trim() ?? "deployments/arc-testnet.json"
  );
  const evidencePath = path.resolve(
    repositoryRoot,
    options.evidence ?? process.env.COFFER_ARC_EVIDENCE_OUTPUT?.trim() ?? "deployments/arc-testnet-evidence.json"
  );
  const rpcUrl = verifiedRpcUrl(options.rpcUrl ?? process.env.ARC_RPC_URL?.trim() ?? ARC_RPC_URL);
  const [manifestBytes, evidenceBytes] = await Promise.all([fs.readFile(manifestPath), fs.readFile(evidencePath)]);
  const manifest = validateDeploymentManifest(JSON.parse(manifestBytes.toString("utf8")));
  const evidence = validateEvidenceDocument(JSON.parse(evidenceBytes.toString("utf8")), manifest, manifestBytes);
  const client = createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl, { retryCount: 4, retryDelay: 500 })
  });
  await verifyOnchainEvidence(client, manifest, evidence);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    generationMode: evidence.generationMode,
    network: evidence.network,
    chainId: evidence.chainId,
    registryAddress: evidence.contracts.registryAddress,
    verifiedScenarioOrder: evidence.scenarioOrder,
    verifiedTransactions: {
      deployment: evidence.contracts.registryTransactionArcScanUrl,
      anchor: evidence.scenarios.allow.anchor.arcScanUrl,
      settlement: evidence.scenarios.allow.settlement.arcScanUrl
    },
    verificationScope: {
      publicSoliditySource: true,
      deploymentManifest: true,
      arcRpc: true,
      hostedAndWriterObservationsAreRunnerAttested: true,
      secretsRequired: false
    }
  }, null, 2)}\n`);
}

export function validateDeploymentManifest(value) {
  requireObject(value, "deployment manifest");
  assertExactKeys(value, [
    "schemaVersion", "network", "chainId", "registryAddress", "operator", "deploymentTransactionHash",
    "deploymentBlockNumber", "compilerVersion", "optimizer", "sourceHash", "creationBytecodeHash",
    "runtimeBytecodeHash", "deployedAt"
  ], "deployment manifest");
  if (value.schemaVersion !== 1 || value.network !== "ARC-TESTNET" || value.chainId !== ARC_CHAIN_ID) {
    fail("deployment manifest does not describe the supported Arc Testnet schema");
  }
  requireCanonicalAddress(value.registryAddress, "manifest registryAddress");
  requireCanonicalAddress(value.operator, "manifest operator");
  requireManifestHash(value.deploymentTransactionHash, "manifest deploymentTransactionHash");
  requireDecimal(value.deploymentBlockNumber, "manifest deploymentBlockNumber");
  requireBoundedString(value.compilerVersion, "manifest compilerVersion", 120);
  requireObject(value.optimizer, "manifest optimizer");
  assertExactKeys(value.optimizer, ["enabled", "runs"], "manifest optimizer");
  if (value.optimizer.enabled !== true || !Number.isSafeInteger(value.optimizer.runs) || value.optimizer.runs <= 0) {
    fail("manifest optimizer configuration is invalid");
  }
  requireManifestHash(value.sourceHash, "manifest sourceHash");
  requireManifestHash(value.creationBytecodeHash, "manifest creationBytecodeHash");
  requireManifestHash(value.runtimeBytecodeHash, "manifest runtimeBytecodeHash");
  requireIsoDate(value.deployedAt, "manifest deployedAt");
  return value;
}

export function validateEvidenceDocument(value, manifest, manifestBytes) {
  requireObject(value, "evidence");
  assertExactKeys(value, [
    "schemaVersion", "artifact", "network", "chainId", "generationMode", "generatedAt",
    "deploymentManifestSha256", "verificationScope", "contracts", "scenarioOrder", "scenarios", "invariants"
  ], "evidence");
  if (
    value.schemaVersion !== 2 || value.artifact !== "coffer-arc-live-evidence" ||
    value.network !== "ARC-TESTNET" || value.chainId !== ARC_CHAIN_ID ||
    (value.generationMode !== "fresh" && value.generationMode !== "recover_allow")
  ) fail("evidence does not use the supported Arc Testnet schema");
  requireIsoDate(value.generatedAt, "evidence generatedAt");
  if (new Date(value.generatedAt).getTime() < new Date(manifest.deployedAt).getTime()) fail("evidence predates the Registry deployment");
  const expectedManifestHash = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
  if (value.deploymentManifestSha256 !== expectedManifestHash) fail("evidence is not bound to the supplied deployment manifest bytes");

  requireObject(value.verificationScope, "verificationScope");
  assertExactKeys(value.verificationScope, ["hostedAndWriterObservations", "onchainEvidence"], "verificationScope");
  if (
    value.verificationScope.hostedAndWriterObservations !== "attested_by_secret_backed_runner" ||
    value.verificationScope.onchainEvidence !== "independently_verified_from_public_source_manifest_and_arc_rpc"
  ) fail("evidence verification scope is invalid");

  validateContracts(value.contracts, manifest);
  if (!Array.isArray(value.scenarioOrder) || value.scenarioOrder.length !== scenarioOrder.length || value.scenarioOrder.some((item, index) => item !== scenarioOrder[index])) {
    fail("scenarioOrder must be block -> approval -> allow -> allow_replay");
  }
  requireObject(value.scenarios, "scenarios");
  assertExactKeys(value.scenarios, ["block", "approval", "allow", "allowReplay"], "scenarios");
  validateNotExecutedScenario(value.scenarios.block, "block", "block");
  validateNotExecutedScenario(value.scenarios.approval, "approval", "requires_approval");
  validateSettledScenario(value.scenarios.allow, "allow", false, value.contracts, value.generationMode);
  validateSettledScenario(value.scenarios.allowReplay, "allow replay", true, value.contracts, value.generationMode);
  validateCrossScenarioInvariants(value.scenarios, value.generationMode);

  requireObject(value.invariants, "invariants");
  assertExactKeys(value.invariants, [
    "blockedBeforeWallet", "approvalPausedBeforeWallet", "allowAnchoredThenSettled",
    "replayUsedOriginalEvidence", "independentVerificationCommand"
  ], "invariants");
  for (const key of ["blockedBeforeWallet", "approvalPausedBeforeWallet", "allowAnchoredThenSettled", "replayUsedOriginalEvidence"]) {
    if (value.invariants[key] !== true) fail(`invariant ${key} is not true`);
  }
  if (value.invariants.independentVerificationCommand !== "pnpm --filter @coffer/arc evidence:verify") {
    fail("independent verification command is invalid");
  }
  return value;
}

function validateContracts(value, manifest) {
  requireObject(value, "contracts");
  assertExactKeys(value, [
    "registryAddress", "registryOperator", "registryDeploymentBlock", "registryRuntimeBytecodeHash",
    "registryTransactionHash", "registryArcScanUrl", "registryTransactionArcScanUrl", "memoAddress",
    "usdcAddress", "fixedRecipient", "fixedRecipientArcScanUrl"
  ], "contracts");
  for (const [key, label] of [
    ["registryAddress", "registry address"], ["registryOperator", "registry operator"],
    ["memoAddress", "Memo address"], ["usdcAddress", "USDC address"], ["fixedRecipient", "fixed recipient"]
  ]) requireCanonicalAddress(value[key], label);
  requireDecimal(value.registryDeploymentBlock, "registry deployment block");
  requireHash(value.registryRuntimeBytecodeHash, "registry runtime bytecode hash");
  requireHash(value.registryTransactionHash, "registry transaction hash");
  if (
    value.registryAddress !== manifest.registryAddress || value.registryOperator !== manifest.operator ||
    value.registryDeploymentBlock !== manifest.deploymentBlockNumber ||
    lower(value.registryRuntimeBytecodeHash) !== lower(manifest.runtimeBytecodeHash) ||
    lower(value.registryTransactionHash) !== lower(manifest.deploymentTransactionHash)
  ) fail("evidence contracts do not match the deployment manifest");
  if (value.memoAddress !== ARC_MEMO || value.usdcAddress !== ARC_USDC) fail("evidence uses unexpected Arc system contracts");
  const forbidden = new Set([
    "0x0000000000000000000000000000000000000000", value.registryAddress, value.registryOperator,
    value.memoAddress, value.usdcAddress
  ].map(lower));
  if (forbidden.has(lower(value.fixedRecipient))) fail("fixed recipient is a forbidden address");
  if (value.registryArcScanUrl !== addressUrl(value.registryAddress)) fail("registry ArcScan URL is invalid");
  if (value.registryTransactionArcScanUrl !== transactionUrl(value.registryTransactionHash)) fail("deployment ArcScan URL is invalid");
  if (value.fixedRecipientArcScanUrl !== addressUrl(value.fixedRecipient)) fail("recipient ArcScan URL is invalid");
}

function validateNotExecutedScenario(value, label, expectedOutcome) {
  requireObject(value, `${label} scenario`);
  assertExactKeys(value, [
    "expectedOutcome", "observedOutcome", "executionState", "writerCalls",
    "currentOperatorNonceWindow", "arcTransactions"
  ], `${label} scenario`);
  if (value.expectedOutcome !== expectedOutcome || value.observedOutcome !== expectedOutcome || value.executionState !== "not_executed") {
    fail(`${label} scenario outcome/state mismatch`);
  }
  validateWriterCalls(value.writerCalls, 0, 0, label);
  validateNonceWindow(value.currentOperatorNonceWindow, `${label} current`);
  if (!Array.isArray(value.arcTransactions) || value.arcTransactions.length !== 0) fail(`${label} must have no Arc transactions`);
  if (value.currentOperatorNonceWindow.before.transactionCount !== value.currentOperatorNonceWindow.after.transactionCount) {
    fail(`${label} changed the operator transaction count`);
  }
}

function validateSettledScenario(value, label, isReplay, contracts, generationMode) {
  requireObject(value, `${label} scenario`);
  assertExactKeys(value, [
    "expectedOutcome", "observedOutcome", "executionState", "replayed", "executionObservation",
    "hostedSettlementObservation", "recordHash", "decisionCommitment", "writerCalls",
    "currentOperatorNonceWindow", "historicalOperatorNonceWindow", "anchor", "settlement"
  ], `${label} scenario`);
  const expectedReplay = isReplay || generationMode === "recover_allow";
  if (
    value.expectedOutcome !== "allow" || value.observedOutcome !== "allow" ||
    value.executionState !== "settled" || value.replayed !== expectedReplay
  ) fail(`${label} outcome/state/replay mismatch`);
  const expectedObservation = isReplay
    ? "replay_confirmation"
    : generationMode === "fresh" ? "fresh_current_execution" : "recovered_historical_execution";
  if (value.executionObservation !== expectedObservation) fail(`${label} execution observation is dishonest or invalid`);
  if (isReplay) {
    if (value.hostedSettlementObservation !== "preexisting_reference") fail("allow replay must observe a preexisting hosted reference");
  } else if (generationMode === "fresh") {
    if (value.hostedSettlementObservation !== "reported_by_current_execution") fail("fresh allow hosted observation is invalid");
  } else if (!new Set(["preexisting_reference", "recovered_from_arc_and_reported"]).has(value.hostedSettlementObservation)) {
    fail("recovered allow hosted observation is invalid");
  }
  requireHash(value.recordHash, `${label} recordHash`);
  requireHash(value.decisionCommitment, `${label} decisionCommitment`);
  validateWriterCalls(value.writerCalls, !isReplay && generationMode === "fresh" ? 1 : 0, !isReplay && generationMode === "fresh" ? 1 : 0, label);
  validateNonceWindow(value.currentOperatorNonceWindow, `${label} current`);
  validateHistoricalNonceWindow(value.historicalOperatorNonceWindow, label);

  requireObject(value.anchor, `${label} anchor`);
  assertExactKeys(value.anchor, ["transactionHash", "blockNumber", "arcScanUrl"], `${label} anchor`);
  requireHash(value.anchor.transactionHash, `${label} anchor transactionHash`);
  requireDecimal(value.anchor.blockNumber, `${label} anchor blockNumber`);
  if (value.anchor.arcScanUrl !== transactionUrl(value.anchor.transactionHash)) fail(`${label} anchor ArcScan URL is invalid`);

  requireObject(value.settlement, `${label} settlement`);
  assertExactKeys(value.settlement, [
    "transactionHash", "blockNumber", "sender", "recipient", "amountMinor", "memoId",
    "memoData", "callDataHash", "arcScanUrl"
  ], `${label} settlement`);
  requireHash(value.settlement.transactionHash, `${label} settlement transactionHash`);
  requireDecimal(value.settlement.blockNumber, `${label} settlement blockNumber`);
  requireCanonicalAddress(value.settlement.sender, `${label} settlement sender`);
  requireCanonicalAddress(value.settlement.recipient, `${label} settlement recipient`);
  requireDecimal(value.settlement.amountMinor, `${label} settlement amountMinor`);
  requireHash(value.settlement.memoId, `${label} settlement memoId`);
  requireHash(value.settlement.memoData, `${label} settlement memoData`);
  requireHash(value.settlement.callDataHash, `${label} settlement callDataHash`);
  if (value.settlement.arcScanUrl !== transactionUrl(value.settlement.transactionHash)) fail(`${label} settlement ArcScan URL is invalid`);
  if (
    value.settlement.sender !== contracts.registryOperator || value.settlement.recipient !== contracts.fixedRecipient ||
    value.settlement.amountMinor !== "10000"
  ) fail(`${label} settlement escaped the fixed boundary`);
  if (lower(value.recordHash) !== lower(value.settlement.memoData) || lower(value.decisionCommitment) !== lower(value.settlement.memoId)) {
    fail(`${label} commitment/record hashes are not bound to Memo evidence`);
  }
  if (BigInt(value.anchor.blockNumber) > BigInt(value.settlement.blockNumber)) fail(`${label} settlement predates its anchor`);

  const before = BigInt(value.currentOperatorNonceWindow.before.transactionCount);
  const after = BigInt(value.currentOperatorNonceWindow.after.transactionCount);
  if (!isReplay && generationMode === "fresh") {
    if (after - before !== 2n) fail("fresh allow did not add exactly two operator transactions");
    if (
      value.historicalOperatorNonceWindow.beforeTransactionCount !== value.currentOperatorNonceWindow.before.transactionCount ||
      value.historicalOperatorNonceWindow.afterTransactionCount !== value.currentOperatorNonceWindow.after.transactionCount
    ) fail("fresh current and historical nonce windows differ");
  } else if (after !== before) fail(`${label} changed the operator nonce during a replay/recovery observation`);
}

function validateHistoricalNonceWindow(value, label) {
  requireObject(value, `${label} historicalOperatorNonceWindow`);
  assertExactKeys(value, [
    "beforeTransactionCount", "afterTransactionCount", "anchorNonce", "settlementNonce",
    "anchorTransactionIndex", "settlementTransactionIndex"
  ], `${label} historicalOperatorNonceWindow`);
  for (const key of Object.keys(value)) requireDecimal(value[key], `${label} historical ${key}`);
  const before = BigInt(value.beforeTransactionCount);
  const after = BigInt(value.afterTransactionCount);
  const anchor = BigInt(value.anchorNonce);
  const settlement = BigInt(value.settlementNonce);
  if (anchor !== before || settlement !== anchor + 1n || after !== settlement + 1n) {
    fail(`${label} historical nonce window is not exactly two consecutive transactions`);
  }
}

function validateWriterCalls(value, anchor, settlement, label) {
  requireObject(value, `${label} writerCalls`);
  assertExactKeys(value, ["anchor", "settlement"], `${label} writerCalls`);
  if (value.anchor !== anchor || value.settlement !== settlement) fail(`${label} writer call counts are invalid`);
}

function validateNonceWindow(value, label) {
  requireObject(value, `${label}OperatorNonceWindow`);
  assertExactKeys(value, ["before", "after"], `${label}OperatorNonceWindow`);
  for (const side of ["before", "after"]) {
    requireObject(value[side], `${label} ${side} nonce snapshot`);
    assertExactKeys(value[side], ["blockNumber", "transactionCount"], `${label} ${side} nonce snapshot`);
    requireDecimal(value[side].blockNumber, `${label} ${side} blockNumber`);
    requireDecimal(value[side].transactionCount, `${label} ${side} transactionCount`);
  }
  if (BigInt(value.after.blockNumber) < BigInt(value.before.blockNumber)) fail(`${label} nonce window moved backwards`);
}

function validateCrossScenarioInvariants(scenarios, generationMode) {
  const { block, approval, allow, allowReplay: replay } = scenarios;
  if (
    block.currentOperatorNonceWindow.after.transactionCount !== approval.currentOperatorNonceWindow.before.transactionCount ||
    approval.currentOperatorNonceWindow.after.transactionCount !== allow.currentOperatorNonceWindow.before.transactionCount ||
    allow.currentOperatorNonceWindow.after.transactionCount !== replay.currentOperatorNonceWindow.before.transactionCount
  ) fail("operator transaction count has unexplained gaps between scenarios");
  const currentBlocks = [
    block.currentOperatorNonceWindow.before.blockNumber, block.currentOperatorNonceWindow.after.blockNumber,
    approval.currentOperatorNonceWindow.before.blockNumber, approval.currentOperatorNonceWindow.after.blockNumber,
    allow.currentOperatorNonceWindow.before.blockNumber, allow.currentOperatorNonceWindow.after.blockNumber,
    replay.currentOperatorNonceWindow.before.blockNumber, replay.currentOperatorNonceWindow.after.blockNumber
  ].map(BigInt);
  for (let index = 1; index < currentBlocks.length; index += 1) {
    if (currentBlocks[index] < currentBlocks[index - 1]) fail("current scenario block sequence moved backwards");
  }
  if (generationMode === "fresh") {
    if (
      BigInt(allow.anchor.blockNumber) <= BigInt(allow.currentOperatorNonceWindow.before.blockNumber) ||
      BigInt(allow.settlement.blockNumber) > BigInt(allow.currentOperatorNonceWindow.after.blockNumber)
    ) fail("fresh transactions are outside the current allow observation window");
  } else {
    const counts = [block, approval, allow, replay]
      .flatMap((scenario) => [scenario.currentOperatorNonceWindow.before.transactionCount, scenario.currentOperatorNonceWindow.after.transactionCount]);
    if (counts.some((count) => count !== counts[0])) fail("recovery created a current operator transaction");
    if (
      BigInt(allow.anchor.blockNumber) > BigInt(allow.currentOperatorNonceWindow.before.blockNumber) ||
      BigInt(allow.settlement.blockNumber) > BigInt(allow.currentOperatorNonceWindow.before.blockNumber) ||
      BigInt(allow.currentOperatorNonceWindow.before.transactionCount) < BigInt(allow.historicalOperatorNonceWindow.afterTransactionCount)
    ) fail("recovered transactions were not fully historical at recovery start");
  }
  for (const field of ["recordHash", "decisionCommitment", "historicalOperatorNonceWindow", "anchor", "settlement"]) {
    if (JSON.stringify(allow[field]) !== JSON.stringify(replay[field])) fail(`replay ${field} is not fully identical to allow evidence`);
  }
}

async function verifyOnchainEvidence(client, manifest, evidence) {
  const chainId = await client.getChainId();
  if (chainId !== ARC_CHAIN_ID) fail(`expected Arc Testnet chain ${ARC_CHAIN_ID}, received ${chainId}`);
  const artifact = await compileDecisionRegistry();
  if (
    artifact.compilerVersion !== manifest.compilerVersion ||
    JSON.stringify(artifact.optimizer) !== JSON.stringify(manifest.optimizer) ||
    lower(artifact.sourceHash) !== lower(manifest.sourceHash) ||
    lower(keccak256(artifact.bytecode)) !== lower(manifest.creationBytecodeHash)
  ) fail("public Solidity source/compiler settings do not match the deployment manifest");
  const expectedRuntimeCode = materializeRegistryRuntimeBytecode(artifact, manifest.operator);
  if (lower(keccak256(expectedRuntimeCode)) !== lower(manifest.runtimeBytecodeHash)) {
    fail("compiled public source runtime does not match the deployment manifest");
  }
  for (const address of [ARC_USDC, ARC_MEMO, evidence.contracts.registryAddress]) {
    const code = await client.getCode({ address });
    if (!code || code === "0x") fail(`required Arc contract is missing at ${address}`);
    if (address === evidence.contracts.registryAddress && lower(code) !== lower(expectedRuntimeCode)) {
      fail("deployed Registry bytecode does not exactly match the compiled public source and immutable operator");
    }
  }
  const decimals = Number(await client.readContract({ address: ARC_USDC, abi: usdcAbi, functionName: "decimals" }));
  if (decimals !== 6) fail(`expected Arc USDC to use 6 decimals, received ${decimals}`);
  const operator = getAddress(await client.readContract({
    address: evidence.contracts.registryAddress, abi: registryAbi, functionName: "operator"
  }));
  if (operator !== evidence.contracts.registryOperator) fail("Registry operator does not match evidence");
  const deploymentReceipt = await client.getTransactionReceipt({ hash: evidence.contracts.registryTransactionHash });
  if (
    deploymentReceipt.status !== "success" || getAddress(deploymentReceipt.from) !== operator ||
    !deploymentReceipt.contractAddress || getAddress(deploymentReceipt.contractAddress) !== evidence.contracts.registryAddress ||
    deploymentReceipt.blockNumber.toString() !== evidence.contracts.registryDeploymentBlock
  ) fail("Registry deployment receipt does not match manifest/evidence");
  await verifyNonceSnapshots(client, operator, evidence.scenarios);
  await verifyAllowTransactions(client, operator, evidence.contracts, evidence.scenarios.allow);
}

async function verifyNonceSnapshots(client, operator, scenarios) {
  for (const [label, scenario] of [
    ["block", scenarios.block], ["approval", scenarios.approval],
    ["allow", scenarios.allow], ["allow replay", scenarios.allowReplay]
  ]) {
    for (const side of ["before", "after"]) {
      const snapshot = scenario.currentOperatorNonceWindow[side];
      const actual = await client.getTransactionCount({ address: operator, blockNumber: BigInt(snapshot.blockNumber) });
      if (actual.toString() !== snapshot.transactionCount) fail(`${label} ${side} historical operator nonce does not match Arc state`);
    }
  }
}

async function verifyAllowTransactions(client, operator, contracts, allow) {
  const commitment = allow.decisionCommitment;
  const recordHash = allow.recordHash;
  const anchorHash = allow.anchor.transactionHash;
  const settlementHash = allow.settlement.transactionHash;
  const [anchorTx, anchorReceipt, settlementTx, settlementReceipt] = await Promise.all([
    client.getTransaction({ hash: anchorHash }), client.getTransactionReceipt({ hash: anchorHash }),
    client.getTransaction({ hash: settlementHash }), client.getTransactionReceipt({ hash: settlementHash })
  ]);
  if (
    anchorReceipt.status !== "success" || getAddress(anchorReceipt.from) !== operator ||
    !anchorReceipt.to || getAddress(anchorReceipt.to) !== contracts.registryAddress ||
    anchorReceipt.blockNumber.toString() !== allow.anchor.blockNumber ||
    getAddress(anchorTx.from) !== operator || !anchorTx.to || getAddress(anchorTx.to) !== contracts.registryAddress ||
    anchorTx.blockNumber !== anchorReceipt.blockNumber
  ) fail("Registry anchor transaction/receipt does not match evidence");
  const expectedAnchorInput = encodeFunctionData({ abi: registryAbi, functionName: "anchorDecision", args: [commitment, 2] });
  if (lower(anchorTx.input) !== lower(expectedAnchorInput)) fail("Registry anchor calldata does not match commitment");
  const registryEvents = anchorReceipt.logs
    .filter((log) => getAddress(log.address) === contracts.registryAddress)
    .flatMap((log) => {
      try {
        const decoded = decodeEventLog({ abi: registryAbi, data: log.data, topics: log.topics });
        return decoded.eventName === "DecisionAnchored" ? [{ decoded, log }] : [];
      } catch { return []; }
    });
  if (registryEvents.length !== 1) fail(`expected one DecisionAnchored event, found ${registryEvents.length}`);
  const registryArgs = registryEvents[0].decoded.args;
  if (
    lower(registryArgs.commitment) !== lower(commitment) || Number(registryArgs.outcome) !== 2 ||
    getAddress(registryArgs.operator) !== operator || BigInt(registryArgs.anchoredAtBlock) !== anchorReceipt.blockNumber
  ) fail("DecisionAnchored event does not match evidence");
  const stored = parseRegistryDecision(await client.readContract({
    address: contracts.registryAddress, abi: registryAbi, functionName: "getDecision", args: [commitment]
  }));
  if (!stored.exists || stored.outcome !== 2 || stored.anchoredAtBlock !== anchorReceipt.blockNumber) {
    fail("Registry stored decision does not match anchor evidence");
  }
  const registryEvent = parseAbiItem(
    "event DecisionAnchored(bytes32 indexed commitment,uint8 indexed outcome,address indexed operator,uint64 anchoredAtBlock)"
  );
  const registryMatches = await client.getLogs({
    address: contracts.registryAddress, event: registryEvent,
    args: { commitment, outcome: 2, operator },
    fromBlock: BigInt(contracts.registryDeploymentBlock), toBlock: anchorReceipt.blockNumber
  });
  const exactRegistry = registryMatches.filter((log) =>
    lower(log.transactionHash ?? "") === lower(anchorHash) && log.logIndex === registryEvents[0].log.logIndex &&
    log.blockNumber === anchorReceipt.blockNumber
  );
  if (exactRegistry.length !== 1) fail("indexed Registry lookup did not return the exact anchor event");

  if (
    settlementReceipt.status !== "success" || getAddress(settlementReceipt.from) !== operator ||
    !settlementReceipt.to || getAddress(settlementReceipt.to) !== ARC_MEMO ||
    settlementReceipt.blockNumber.toString() !== allow.settlement.blockNumber ||
    getAddress(settlementTx.from) !== operator || !settlementTx.to || getAddress(settlementTx.to) !== ARC_MEMO ||
    settlementTx.blockNumber !== settlementReceipt.blockNumber
  ) fail("Memo settlement transaction/receipt does not match evidence");
  const transferData = encodeFunctionData({ abi: usdcAbi, functionName: "transfer", args: [contracts.fixedRecipient, 10_000n] });
  const expectedMemoInput = encodeFunctionData({
    abi: memoAbi, functionName: "memo", args: [ARC_USDC, transferData, commitment, recordHash]
  });
  if (lower(settlementTx.input) !== lower(expectedMemoInput)) fail("Memo calldata does not match fixed USDC settlement");
  if (lower(allow.settlement.callDataHash) !== lower(keccak256(transferData))) fail("callDataHash mismatch");
  const memoEvents = settlementReceipt.logs
    .filter((log) => getAddress(log.address) === ARC_MEMO)
    .flatMap((log) => {
      try {
        const decoded = decodeEventLog({ abi: memoAbi, data: log.data, topics: log.topics });
        return decoded.eventName === "Memo" ? [{ decoded, log }] : [];
      } catch { return []; }
    });
  if (memoEvents.length !== 1) fail(`expected one Memo event, found ${memoEvents.length}`);
  const memoArgs = memoEvents[0].decoded.args;
  if (
    getAddress(memoArgs.sender) !== operator || getAddress(memoArgs.target) !== ARC_USDC ||
    lower(memoArgs.callDataHash) !== lower(keccak256(transferData)) || lower(memoArgs.memoId) !== lower(commitment) ||
    lower(memoArgs.memo) !== lower(recordHash)
  ) fail("Memo event does not match settlement evidence");
  const transfers = settlementReceipt.logs
    .filter((log) => getAddress(log.address) === ARC_USDC)
    .flatMap((log) => {
      try {
        const decoded = decodeEventLog({ abi: usdcAbi, data: log.data, topics: log.topics });
        return decoded.eventName === "Transfer" ? [decoded] : [];
      } catch { return []; }
    })
    .filter((event) =>
      getAddress(event.args.from) === operator && getAddress(event.args.to) === contracts.fixedRecipient &&
      BigInt(event.args.value) === 10_000n
    );
  if (transfers.length !== 1) fail(`expected one matching USDC Transfer event, found ${transfers.length}`);
  const memoEvent = parseAbiItem(
    "event Memo(address indexed sender,address indexed target,bytes32 callDataHash,bytes32 indexed memoId,bytes memo,uint256 memoIndex)"
  );
  const memoMatches = await client.getLogs({
    address: ARC_MEMO, event: memoEvent,
    args: { sender: operator, target: ARC_USDC, memoId: commitment },
    fromBlock: settlementReceipt.blockNumber, toBlock: settlementReceipt.blockNumber
  });
  const exactMemo = memoMatches.filter((log) =>
    lower(log.transactionHash ?? "") === lower(settlementHash) && log.logIndex === memoEvents[0].log.logIndex
  );
  if (exactMemo.length !== 1) fail("indexed Memo lookup did not return the exact settlement event");

  const historical = allow.historicalOperatorNonceWindow;
  if (
    BigInt(anchorTx.nonce) !== BigInt(historical.anchorNonce) ||
    BigInt(settlementTx.nonce) !== BigInt(historical.settlementNonce) ||
    anchorReceipt.transactionIndex.toString() !== historical.anchorTransactionIndex ||
    settlementReceipt.transactionIndex.toString() !== historical.settlementTransactionIndex ||
    BigInt(settlementTx.nonce) !== BigInt(anchorTx.nonce) + 1n ||
    anchorReceipt.blockNumber > settlementReceipt.blockNumber ||
    (anchorReceipt.blockNumber === settlementReceipt.blockNumber && anchorReceipt.transactionIndex >= settlementReceipt.transactionIndex)
  ) fail("historical two-transaction nonce/order proof does not match Arc transactions");
}

function parseRegistryDecision(value) {
  if (Array.isArray(value)) return { exists: value[0] === true, outcome: Number(value[1]), anchoredAtBlock: BigInt(String(value[2])) };
  return { exists: value?.exists === true, outcome: Number(value?.outcome), anchoredAtBlock: BigInt(String(value?.anchoredAtBlock)) };
}

function parseOptions(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") continue;
    const next = args[index + 1];
    if (!next || next.startsWith("--")) fail(`${arg ?? "option"} requires a value`);
    if (arg === "--manifest") result.manifest = next;
    else if (arg === "--evidence") result.evidence = next;
    else if (arg === "--rpc-url") result.rpcUrl = next;
    else fail(`unsupported option: ${arg}`);
    index += 1;
  }
  return result;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}

function requireBoundedString(value, label, maxLength) {
  if (typeof value !== "string" || !value || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${label} must be bounded text without control characters`);
  }
}

function requireCanonicalAddress(value, label) {
  if (typeof value !== "string") fail(`${label} must be an EVM address`);
  let canonical;
  try { canonical = getAddress(value); } catch { fail(`${label} must be an EVM address`); }
  if (value !== canonical) fail(`${label} must use its canonical checksum representation`);
}

function requireHash(value, label) {
  if (typeof value !== "string" || !/^0x[a-f0-9]{64}$/.test(value)) fail(`${label} must be lowercase 32-byte hex`);
}

function requireManifestHash(value, label) {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(value)) fail(`${label} must be 32-byte hex`);
}

function requireDecimal(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) fail(`${label} must be an unsigned decimal string`);
}

function requireIsoDate(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) fail(`${label} must be an ISO timestamp`);
}

function verifiedRpcUrl(value) {
  const parsed = new URL(value);
  if ((parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") || parsed.username || parsed.password || parsed.hash) {
    fail("Arc RPC URL must be credential-free HTTPS except on localhost");
  }
  return parsed.toString();
}

function lower(value) { return String(value).toLowerCase(); }
function transactionUrl(hash) { return `${ARC_EXPLORER_URL}/tx/${lower(hash)}`; }
function addressUrl(address) { return `${ARC_EXPLORER_URL}/address/${getAddress(address)}`; }
function fail(message) { throw new Error(message); }

function runSelfTest() {
  const { manifest, manifestBytes, evidence: fresh } = sampleDocuments("fresh");
  validateDeploymentManifest(manifest);
  validateEvidenceDocument(fresh, manifest, manifestBytes);
  const recoveredSample = sampleDocuments("recover_allow");
  validateDeploymentManifest(recoveredSample.manifest);
  validateEvidenceDocument(recoveredSample.evidence, recoveredSample.manifest, recoveredSample.manifestBytes);

  const replayTamper = structuredClone(fresh);
  replayTamper.scenarios.allowReplay.settlement.callDataHash = `0x${"9".repeat(64)}`;
  expectRejected(() => validateEvidenceDocument(replayTamper, manifest, manifestBytes), "tampered replay evidence");
  const recoveryTamper = structuredClone(recoveredSample.evidence);
  recoveryTamper.scenarios.allow.currentOperatorNonceWindow.after.transactionCount = "8";
  expectRejected(
    () => validateEvidenceDocument(recoveryTamper, recoveredSample.manifest, recoveredSample.manifestBytes),
    "recovery nonce mutation"
  );
  const internalIdManifest = { ...manifest, circleContractId: "forbidden" };
  expectRejected(() => validateDeploymentManifest(internalIdManifest), "Circle internal manifest field");
  process.stdout.write("Arc independent evidence verifier self-test passed.\n");
}

function expectRejected(action, label) {
  let rejected = false;
  try { action(); } catch { rejected = true; }
  if (!rejected) fail(`${label} was not rejected`);
}

function sampleDocuments(generationMode) {
  const manifest = {
    schemaVersion: 1,
    network: "ARC-TESTNET",
    chainId: ARC_CHAIN_ID,
    registryAddress: "0x3333333333333333333333333333333333333333",
    operator: "0x1111111111111111111111111111111111111111",
    deploymentTransactionHash: `0x${"d".repeat(64)}`,
    deploymentBlockNumber: "8",
    compilerVersion: "0.8.28+self-test",
    optimizer: { enabled: true, runs: 200 },
    sourceHash: `0x${"1".repeat(64)}`,
    creationBytecodeHash: `0x${"2".repeat(64)}`,
    runtimeBytecodeHash: `0x${"3".repeat(64)}`,
    deployedAt: "2026-07-15T12:00:00.000Z"
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const registry = manifest.registryAddress;
  const operator = manifest.operator;
  const recipient = "0x2222222222222222222222222222222222222222";
  const anchorHash = `0x${"a".repeat(64)}`;
  const settlementHash = `0x${"b".repeat(64)}`;
  const commitment = `0x${"c".repeat(64)}`;
  const recordHash = `0x${"e".repeat(64)}`;
  const callDataHash = `0x${"4".repeat(64)}`;
  const snapshot = (beforeBlock, afterBlock, beforeCount, afterCount) => ({
    before: { blockNumber: beforeBlock, transactionCount: beforeCount },
    after: { blockNumber: afterBlock, transactionCount: afterCount }
  });
  const historical = {
    beforeTransactionCount: "5",
    afterTransactionCount: "7",
    anchorNonce: "5",
    settlementNonce: "6",
    anchorTransactionIndex: "0",
    settlementTransactionIndex: "0"
  };
  const anchor = { transactionHash: anchorHash, blockNumber: "13", arcScanUrl: transactionUrl(anchorHash) };
  const settlement = {
    transactionHash: settlementHash,
    blockNumber: "14",
    sender: operator,
    recipient,
    amountMinor: "10000",
    memoId: commitment,
    memoData: recordHash,
    callDataHash,
    arcScanUrl: transactionUrl(settlementHash)
  };
  const currentCountBefore = generationMode === "fresh" ? "5" : "7";
  const currentCountAfter = generationMode === "fresh" ? "7" : "7";
  const allowCurrent = generationMode === "fresh"
    ? snapshot("12", "14", currentCountBefore, currentCountAfter)
    : snapshot("22", "23", currentCountBefore, currentCountAfter);
  const settled = (isReplay, currentWindow) => ({
    expectedOutcome: "allow",
    observedOutcome: "allow",
    executionState: "settled",
    replayed: isReplay || generationMode === "recover_allow",
    executionObservation: isReplay
      ? "replay_confirmation"
      : generationMode === "fresh" ? "fresh_current_execution" : "recovered_historical_execution",
    hostedSettlementObservation: isReplay
      ? "preexisting_reference"
      : generationMode === "fresh" ? "reported_by_current_execution" : "preexisting_reference",
    recordHash,
    decisionCommitment: commitment,
    writerCalls: { anchor: !isReplay && generationMode === "fresh" ? 1 : 0, settlement: !isReplay && generationMode === "fresh" ? 1 : 0 },
    currentOperatorNonceWindow: currentWindow,
    historicalOperatorNonceWindow: structuredClone(historical),
    anchor: structuredClone(anchor),
    settlement: structuredClone(settlement)
  });
  const blockCurrent = generationMode === "fresh" ? snapshot("10", "11", "5", "5") : snapshot("20", "21", "7", "7");
  const approvalCurrent = generationMode === "fresh" ? snapshot("11", "12", "5", "5") : snapshot("21", "22", "7", "7");
  const replayCurrent = generationMode === "fresh" ? snapshot("14", "15", "7", "7") : snapshot("23", "24", "7", "7");
  const evidence = {
    schemaVersion: 2,
    artifact: "coffer-arc-live-evidence",
    network: "ARC-TESTNET",
    chainId: ARC_CHAIN_ID,
    generationMode,
    generatedAt: "2026-07-15T12:01:00.000Z",
    deploymentManifestSha256: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
    verificationScope: {
      hostedAndWriterObservations: "attested_by_secret_backed_runner",
      onchainEvidence: "independently_verified_from_public_source_manifest_and_arc_rpc"
    },
    contracts: {
      registryAddress: registry,
      registryOperator: operator,
      registryDeploymentBlock: "8",
      registryRuntimeBytecodeHash: manifest.runtimeBytecodeHash,
      registryTransactionHash: manifest.deploymentTransactionHash,
      registryArcScanUrl: addressUrl(registry),
      registryTransactionArcScanUrl: transactionUrl(manifest.deploymentTransactionHash),
      memoAddress: ARC_MEMO,
      usdcAddress: ARC_USDC,
      fixedRecipient: recipient,
      fixedRecipientArcScanUrl: addressUrl(recipient)
    },
    scenarioOrder,
    scenarios: {
      block: {
        expectedOutcome: "block", observedOutcome: "block", executionState: "not_executed",
        writerCalls: { anchor: 0, settlement: 0 }, currentOperatorNonceWindow: blockCurrent, arcTransactions: []
      },
      approval: {
        expectedOutcome: "requires_approval", observedOutcome: "requires_approval", executionState: "not_executed",
        writerCalls: { anchor: 0, settlement: 0 }, currentOperatorNonceWindow: approvalCurrent, arcTransactions: []
      },
      allow: settled(false, allowCurrent),
      allowReplay: settled(true, replayCurrent)
    },
    invariants: {
      blockedBeforeWallet: true,
      approvalPausedBeforeWallet: true,
      allowAnchoredThenSettled: true,
      replayUsedOriginalEvidence: true,
      independentVerificationCommand: "pnpm --filter @coffer/arc evidence:verify"
    }
  };
  return { manifest, manifestBytes, evidence };
}
