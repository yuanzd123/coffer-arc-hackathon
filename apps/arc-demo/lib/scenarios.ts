import type { Address } from "viem";
import type { CofferArcSpendIntent } from "@coffer/arc";

export const demoScenarioIds = ["allow", "approval", "block"] as const;
export type DemoScenarioId = (typeof demoScenarioIds)[number];

const ARC_TESTNET_ARCSCAN_URL = "https://testnet.arcscan.app";

export const arcTestnetLiveProof = {
  network: "Arc Testnet",
  chainId: 5_042_002,
  verifiedAt: "2026-07-16T05:19:48.444Z",
  registry: {
    eyebrow: "DEPLOYED REGISTRY",
    label: "Registry contract",
    value: "0x3d1787f00516ed4a30363b3fB3805bC78CC28F9D",
    detail: "The public contract that stores opaque decision anchors.",
    href: `${ARC_TESTNET_ARCSCAN_URL}/address/0x3d1787f00516ed4a30363b3fB3805bC78CC28F9D`
  },
  deploymentTransaction: {
    eyebrow: "CONTRACT CREATION",
    label: "Deployment transaction",
    value: "0xb566327ea6c5685a43acdab6c1e765110352a8dabb0649f21fc9012e7cf6b33d",
    detail: "The verified Arc Testnet transaction that created the Registry.",
    href: `${ARC_TESTNET_ARCSCAN_URL}/tx/0xb566327ea6c5685a43acdab6c1e765110352a8dabb0649f21fc9012e7cf6b33d`
  },
  decisionAnchorTransaction: {
    eyebrow: "CONTROL EVIDENCE",
    label: "Decision anchor transaction",
    value: "0x1425d5a89cbf89e0dd03247f49e188fc62ea1a385db6b6fa409170fa6f2e7d29",
    detail: "The approved decision was committed onchain before settlement.",
    href: `${ARC_TESTNET_ARCSCAN_URL}/tx/0x1425d5a89cbf89e0dd03247f49e188fc62ea1a385db6b6fa409170fa6f2e7d29`
  },
  settlementTransaction: {
    eyebrow: "SETTLEMENT EVIDENCE",
    label: "0.01 USDC settlement",
    value: "0x50d8df5b32b339172b976ceffb43a772a695fa47f7c6cfe24260719a6a1a5abb",
    detail: "The fixed testnet payment settled with its Transaction Memo.",
    href: `${ARC_TESTNET_ARCSCAN_URL}/tx/0x50d8df5b32b339172b976ceffb43a772a695fa47f7c6cfe24260719a6a1a5abb`
  }
} as const;

export const arcTestnetLiveProofItems = [
  arcTestnetLiveProof.registry,
  arcTestnetLiveProof.deploymentTransaction,
  arcTestnetLiveProof.decisionAnchorTransaction,
  arcTestnetLiveProof.settlementTransaction
] as const;

export type PublicDemoScenario = {
  id: DemoScenarioId;
  eyebrow: string;
  title: string;
  amount: string;
  vendorName: string;
  description: string;
  expectedOutcome: "allow" | "requires_approval" | "block";
  intent: Omit<CofferArcSpendIntent, "recipient" | "idempotencyKey">;
};

export const publicDemoScenarios: Record<DemoScenarioId, PublicDemoScenario> = {
  allow: {
    id: "allow",
    eyebrow: "AUTO-APPROVE",
    title: "Buy a market signal",
    amount: "$0.01",
    vendorName: "Arc Data Agent",
    description: "Known agent, allowlisted destination, within the per-transaction and monthly budget.",
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
  },
  approval: {
    id: "approval",
    eyebrow: "HUMAN CHECKPOINT",
    title: "Request a full dataset",
    amount: "$12.00",
    vendorName: "Arc Data Agent",
    description: "Known destination, but the amount crosses the configured approval threshold.",
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
  block: {
    id: "block",
    eyebrow: "BLOCK BEFORE PAYMENT",
    title: "Pay an unknown agent",
    amount: "$0.01",
    vendorName: "Unknown Arc Vendor",
    description: "The destination is not registered or allowlisted, so the wallet is never called.",
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
  }
};

export function scenarioIntent(id: DemoScenarioId, recipient: Address, runId: string): CofferArcSpendIntent {
  const scenario = publicDemoScenarios[id];
  return {
    ...scenario.intent,
    recipient,
    idempotencyKey: `arc:${id}:${runId}`,
    metadata: {
      demoScenario: id,
      syntheticDataOnly: true,
      publicDemoContract: "hackathon-v1"
    }
  };
}
