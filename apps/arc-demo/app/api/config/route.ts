import { NextResponse } from "next/server";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_EXPLORER_URL,
  ARC_TESTNET_MEMO_ADDRESS,
  ARC_TESTNET_USDC_ADDRESS
} from "@coffer/arc";
import { arcTestnetLiveProof } from "../../../lib/scenarios";
import { isLiveDemoEnabled } from "../../../lib/security";

export const dynamic = "force-dynamic";

export function GET() {
  const live = isLiveDemoEnabled();
  return NextResponse.json({
    mode: live ? "live" : "mock",
    chain: "Arc Testnet",
    chainId: ARC_TESTNET_CHAIN_ID,
    explorerUrl: ARC_TESTNET_EXPLORER_URL,
    usdcAddress: ARC_TESTNET_USDC_ADDRESS,
    memoAddress: ARC_TESTNET_MEMO_ADDRESS,
    registryAddress: arcTestnetLiveProof.registry.value,
    accessCodeRequired: live
  }, {
    headers: { "cache-control": "no-store" }
  });
}
