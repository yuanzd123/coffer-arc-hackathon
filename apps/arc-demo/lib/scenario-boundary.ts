import { getAddress, type Address } from "viem";
import type {
  AnchorDecisionInput,
  ArcDecisionWriter,
  ArcWriteResult,
  CofferArcControlClient,
  CofferArcDecision,
  CofferArcSpendIntent,
  CofferSettlementReport,
  MemoUsdcTransferInput
} from "@coffer/arc";
import type { DemoScenarioId, PublicDemoScenario } from "./scenarios";

export class ScenarioBoundControlClient implements CofferArcControlClient {
  constructor(
    private readonly inner: CofferArcControlClient,
    private readonly scenario: PublicDemoScenario
  ) {}

  async requestDecision(intent: CofferArcSpendIntent): Promise<CofferArcDecision> {
    const decision = await this.inner.requestDecision(intent);
    if (decision.outcome !== this.scenario.expectedOutcome) {
      throw new DemoInvariantError(
        `Coffer returned ${decision.outcome}; this scenario is configured to require ${this.scenario.expectedOutcome}`
      );
    }
    return decision;
  }

  async reportSettlement(report: CofferSettlementReport): Promise<void> {
    await this.inner.reportSettlement(report);
  }
}

export class ScenarioBoundWriter implements ArcDecisionWriter {
  readonly sender: Address;

  constructor(
    private readonly inner: ArcDecisionWriter,
    private readonly scenarioId: DemoScenarioId,
    private readonly registryAddress: Address,
    private readonly recipient: Address
  ) {
    this.sender = getAddress(inner.sender);
  }

  async anchorDecision(input: AnchorDecisionInput): Promise<ArcWriteResult> {
    this.assertAllowScenario();
    if (getAddress(input.registryAddress) !== getAddress(this.registryAddress) || input.outcome !== "allow") {
      throw new DemoInvariantError("Registry anchor does not match the fixed allow scenario");
    }
    return this.inner.anchorDecision(input);
  }

  async transferUsdcWithMemo(input: MemoUsdcTransferInput): Promise<ArcWriteResult> {
    this.assertAllowScenario();
    if (getAddress(input.recipient) !== getAddress(this.recipient) || input.amountMinor !== 10_000n) {
      throw new DemoInvariantError("Arc transfer does not match the fixed $0.01 recipient boundary");
    }
    return this.inner.transferUsdcWithMemo(input);
  }

  private assertAllowScenario(): void {
    if (this.scenarioId !== "allow") {
      throw new DemoInvariantError("Approval and block scenarios are not permitted to call the Arc writer");
    }
  }
}

export class DemoInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoInvariantError";
  }
}
