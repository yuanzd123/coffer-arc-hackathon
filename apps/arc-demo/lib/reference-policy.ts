import type { CofferArcDecision, CofferArcSpendIntent } from "@coffer/arc";

const REFERENCE_AGENT_ID = "external_research_agent";
const REFERENCE_VENDOR_ID = "arc-data-agent";
const USDC_MINOR_PER_UNIT = 1_000_000n;
const APPROVAL_THRESHOLD_MINOR = 10n * USDC_MINOR_PER_UNIT;
const MONTHLY_BUDGET_REMAINING_MINOR = 20n * USDC_MINOR_PER_UNIT;

export function evaluateReferenceSpend(intent: CofferArcSpendIntent): CofferArcDecision {
  const amountMinor = parseCanonicalUsdc(intent.amount);
  if (amountMinor === null || amountMinor <= 0n) {
    return decision("block", "invalid_amount", "Amount must be a positive canonical USDC value.");
  }
  if (intent.agentId !== REFERENCE_AGENT_ID) {
    return decision("block", "blocked_unknown_agent", "The agent is outside the public reference allowlist.");
  }
  if (intent.vendorId !== REFERENCE_VENDOR_ID) {
    return decision("block", "blocked_unknown_vendor", "The vendor is outside the public reference allowlist.");
  }
  if (!intent.businessPurpose.trim()) {
    return decision("block", "missing_business_purpose", "A business purpose is required before payment.");
  }
  if (amountMinor > MONTHLY_BUDGET_REMAINING_MINOR) {
    return decision("block", "budget_exceeded", "The request exceeds the remaining public reference budget.");
  }
  if (amountMinor > APPROVAL_THRESHOLD_MINOR) {
    return decision(
      "requires_approval",
      "requires_approval_amount_threshold",
      "The request exceeds the public reference auto-approval threshold."
    );
  }
  return decision("allow", "within_reference_policy", "The request is inside the public reference policy boundary.");
}

function parseCanonicalUsdc(value: string): bigint | null {
  const match = /^(0|[1-9]\d{0,8})\.(\d{2})$/.exec(value);
  if (!match) return null;
  const whole = match[1];
  const cents = match[2];
  if (whole === undefined || cents === undefined) return null;
  return BigInt(whole) * USDC_MINOR_PER_UNIT + BigInt(cents) * 10_000n;
}

function decision(
  outcome: CofferArcDecision["outcome"],
  reasonCode: string,
  reason: string
): CofferArcDecision {
  const suffix = outcome === "requires_approval" ? "approval" : outcome;
  return {
    outcome,
    spendRequestId: `si_reference_${suffix}`,
    decisionId: `pd_reference_${suffix}`,
    spendDecisionRecordId: `sdr_reference_${suffix}`,
    reasonCode,
    reason: `PUBLIC REFERENCE decision: ${reason}`
  };
}
