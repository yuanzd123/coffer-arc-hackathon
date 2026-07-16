import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { DemoRequestError, parseDemoRunRequest, readDemoRequestJson } from "../../../lib/request";
import { runArcDemo } from "../../../lib/run-demo";
import { assertLiveDemoAuthorized, DemoAccessError, isLiveDemoEnabled, liveDemoRunIds } from "../../../lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const input = parseDemoRunRequest(await readDemoRequestJson(request));
    const live = isLiveDemoEnabled();
    if (live) assertLiveDemoAuthorized(request);
    const runId = live ? liveDemoRunIds()[input.scenarioId] : randomUUID();
    const output = await runArcDemo({ ...input, runId, live });
    return new NextResponse(JSON.stringify(output, bigintJson), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    if (error instanceof DemoAccessError) return jsonError(error.status, error.message);
    if (error instanceof DemoRequestError) {
      return jsonError(error.status, error.message);
    }
    if (error instanceof SyntaxError) {
      return jsonError(400, error.message);
    }
    return jsonError(502, "Execution did not complete. Retry with the same run ID so no second payment is created.");
  }
}

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
