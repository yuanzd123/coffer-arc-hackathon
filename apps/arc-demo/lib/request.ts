import { demoScenarioIds, type DemoScenarioId } from "./scenarios";

export class DemoRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "DemoRequestError";
  }
}

const maxDemoBodyBytes = 2_048;

export async function readDemoRequestJson(request: Request): Promise<unknown> {
  const advertisedLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(advertisedLength) && advertisedLength > maxDemoBodyBytes) {
    throw new DemoRequestError("Request body is too large", 413);
  }
  if (!request.body) throw new DemoRequestError("Request body is required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxDemoBodyBytes) {
      await reader.cancel();
      throw new DemoRequestError("Request body is too large", 413);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

export type DemoRunRequest = {
  scenarioId: DemoScenarioId;
};

export function parseDemoRunRequest(value: unknown): DemoRunRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DemoRequestError("Request body must be an object");
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== "scenarioId") {
    throw new DemoRequestError("Only scenarioId is accepted; run ID, recipient, and amount are server-controlled");
  }
  const scenarioId = String(body.scenarioId ?? "") as DemoScenarioId;
  if (!demoScenarioIds.includes(scenarioId)) {
    throw new DemoRequestError(`scenarioId must be one of: ${demoScenarioIds.join(", ")}`);
  }
  return { scenarioId };
}
