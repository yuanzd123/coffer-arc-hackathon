import type { Address, Hex } from "viem";
import type {
  ArcDecisionWriter,
  ArcEvidenceVerifier,
  CofferArcControlClient
} from "@coffer/arc";
import { evaluateReferenceSpend } from "./reference-policy";

export function mockArcDependencies(sender: Address): {
  controlClient: CofferArcControlClient;
  writer: ArcDecisionWriter;
  verifier: ArcEvidenceVerifier;
} {
  const controlClient: CofferArcControlClient = {
    async requestDecision(intent) {
      return evaluateReferenceSpend(intent);
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
