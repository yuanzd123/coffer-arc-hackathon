import type { Address, Hex } from "viem";
import type {
  ArcDecisionWriter,
  ArcEvidenceVerifier,
  CofferArcControlClient,
  CofferArcDecision
} from "@coffer/arc";

export function mockArcDependencies(sender: Address): {
  controlClient: CofferArcControlClient;
  writer: ArcDecisionWriter;
  verifier: ArcEvidenceVerifier;
} {
  const controlClient: CofferArcControlClient = {
    async requestDecision(intent) {
      const scenario = String(intent.metadata?.demoScenario ?? "allow");
      const outcome: CofferArcDecision["outcome"] = scenario === "block"
        ? "block"
        : scenario === "approval"
          ? "requires_approval"
          : "allow";
      return {
        outcome,
        spendRequestId: `si_mock_${scenario}`,
        decisionId: `pd_mock_${scenario}`,
        spendDecisionRecordId: `sdr_mock_${scenario}`,
        reasonCode: outcome === "allow" ? "within_budget" : outcome === "block" ? "blocked_unknown_vendor" : "requires_approval_amount_threshold",
        reason: "SIMULATED decision for local evaluation; no hosted or onchain write occurred."
      };
    },
    async reportSettlement() {}
  };
  const writer: ArcDecisionWriter = {
    sender,
    async anchorDecision() {
      return { provider: "test", txHash: `0x${"a".repeat(64)}` as Hex };
    },
    async transferUsdcWithMemo() {
      return { provider: "test", txHash: `0x${"b".repeat(64)}` as Hex };
    }
  };
  const verifier: ArcEvidenceVerifier = {
    async verifyRegistryState(input) {
      return { ...input, txHash: `0x${"a".repeat(64)}` as Hex, blockNumber: 100n };
    },
    async verifyAnchor(input) {
      return { ...input, operator: sender, blockNumber: 100n };
    },
    async verifyMemoTransfer(input) {
      return { ...input, blockNumber: 101n, callDataHash: `0x${"c".repeat(64)}` as Hex };
    }
  };
  return { controlClient, writer, verifier };
}
