import { hashPublicRecordId, type GuardedArcTransferResult } from "@coffer/arc";
import type { DemoScenarioId } from "./scenarios";

export type PublicDemoOutput = ReturnType<typeof toPublicDemoOutput>;

export function toPublicDemoOutput(input: {
  mode: "live" | "mock";
  scenarioId: DemoScenarioId;
  expectedOutcome: "allow" | "requires_approval" | "block";
  result: GuardedArcTransferResult;
}) {
  const publicDecision = {
    outcome: input.result.decision.outcome,
    reason: publicDecisionReason(input.scenarioId)
  };
  if (input.result.state === "not_executed") {
    return {
      mode: input.mode,
      scenarioId: input.scenarioId,
      expectedOutcome: input.expectedOutcome,
      result: {
        state: input.result.state,
        decision: publicDecision
      }
    };
  }
  const decision = {
    ...publicDecision,
    recordIdHash: hashPublicRecordId(input.result.decision.spendDecisionRecordId)
  };
  return {
    mode: input.mode,
    scenarioId: input.scenarioId,
    expectedOutcome: input.expectedOutcome,
    result: {
      state: input.result.state,
      replayed: input.result.replayed,
      decisionCommitment: input.result.decisionCommitment,
      decision,
      anchor: {
        txHash: input.result.anchor.txHash,
        blockNumber: input.result.anchor.blockNumber.toString()
      },
      settlement: {
        txHash: input.result.settlement.txHash,
        blockNumber: input.result.settlement.blockNumber.toString(),
        amountMinor: input.result.settlement.amountMinor.toString(),
        memoId: input.result.settlement.memoId
      }
    }
  };
}

function publicDecisionReason(scenarioId: DemoScenarioId): string {
  if (scenarioId === "allow") return "Policy allowed this fixed scenario";
  if (scenarioId === "approval") return "Human approval is required before payment";
  return "Payment was blocked before wallet execution";
}
