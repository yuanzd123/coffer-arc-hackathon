import {
  CofferGuardedArcTransfer,
  CircleArcWriter,
  HostedCofferArcClient,
  ViemArcEvidenceVerifier,
  createArcPublicClient
} from "@coffer/arc";
import { getAddress, type Address } from "viem";
import { mockArcDependencies } from "./mock";
import { toPublicDemoOutput } from "./public-result";
import { publicDemoScenarios, scenarioIntent, type DemoScenarioId } from "./scenarios";
import { ScenarioBoundControlClient, ScenarioBoundWriter } from "./scenario-boundary";

export async function runArcDemo(input: { scenarioId: DemoScenarioId; runId: string; live: boolean }) {
  const scenario = publicDemoScenarios[input.scenarioId];
  const execution = input.live
    ? await liveDependencies()
    : mockDependencies();
  const controlClient = new ScenarioBoundControlClient(execution.controlClient, scenario);
  const writer = new ScenarioBoundWriter(
    execution.writer,
    input.scenarioId,
    execution.registryAddress,
    execution.recipient
  );
  const guard = new CofferGuardedArcTransfer({
    controlClient,
    writer,
    verifier: execution.verifier,
    registryAddress: execution.registryAddress,
    registryDeploymentBlock: execution.registryDeploymentBlock
  });
  const result = await guard.execute(scenarioIntent(input.scenarioId, execution.recipient, input.runId));
  return toPublicDemoOutput({
    mode: input.live ? "live" : "mock",
    scenarioId: input.scenarioId,
    expectedOutcome: scenario.expectedOutcome,
    result
  });
}

async function liveDependencies() {
  const registryAddress = envAddress("COFFER_ARC_REGISTRY_ADDRESS");
  const recipient = envAddress("COFFER_ARC_FIXED_RECIPIENT");
  const writer = new CircleArcWriter({
    apiKey: requiredEnv("CIRCLE_API_KEY"),
    entitySecret: requiredEnv("CIRCLE_ENTITY_SECRET"),
    walletId: requiredEnv("CIRCLE_ARC_WALLET_ID"),
    walletAddress: envAddress("CIRCLE_ARC_WALLET_ADDRESS")
  });
  const verifier = new ViemArcEvidenceVerifier(createArcPublicClient(process.env.ARC_RPC_URL));
  await verifier.verifyNetwork(registryAddress);
  const controlClient = new HostedCofferArcClient({
    apiKey: requiredEnv("COFFER_API_KEY"),
    baseUrl: requiredEnv("COFFER_API_BASE_URL"),
    registryAddress,
    senderAddress: writer.sender
  });
  const registryDeploymentBlock = requiredBlockEnv("COFFER_ARC_REGISTRY_DEPLOYMENT_BLOCK");
  return { registryAddress, registryDeploymentBlock, recipient, writer, verifier, controlClient };
}

function mockDependencies() {
  const registryAddress = "0x3333333333333333333333333333333333333333" as Address;
  const recipient = "0x2222222222222222222222222222222222222222" as Address;
  const writerAddress = "0x1111111111111111111111111111111111111111" as Address;
  return { registryAddress, registryDeploymentBlock: 0n, recipient, ...mockArcDependencies(writerAddress) };
}

function envAddress(name: string): Address {
  return getAddress(requiredEnv(name));
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for live mode`);
  return value;
}

function requiredBlockEnv(name: string): bigint {
  const value = requiredEnv(name);
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an unsigned block number`);
  return BigInt(value);
}
