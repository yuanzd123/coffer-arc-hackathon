import { createHash, timingSafeEqual } from "node:crypto";
import type { DemoScenarioId } from "./scenarios";

type LiveRunIds = Record<DemoScenarioId, string>;

export function isLiveDemoEnabled(): boolean {
  return process.env.ARC_DEMO_MODE === "live" &&
    process.env.ARC_WRITE_ENABLED === "true" &&
    process.env.CONFIRM_ARC_TESTNET_ONLY === "ARC_TESTNET";
}

export function assertLiveDemoAuthorized(request: Request): void {
  if (!isLiveDemoEnabled()) {
    throw new DemoAccessError(503, "Live Arc writes are disabled");
  }
  if (process.env.VERCEL_ENV !== "production") {
    throw new DemoAccessError(403, "Live writes are restricted to the production demo deployment");
  }
  const expectedHost = requiredEnv("ARC_DEMO_ALLOWED_HOST").toLowerCase();
  const host = String(request.headers.get("host") ?? "").toLowerCase();
  if (host !== expectedHost) throw new DemoAccessError(403, "Live request host is not allowed");
  const origin = String(request.headers.get("origin") ?? "").toLowerCase();
  if (origin !== `https://${expectedHost}`) {
    throw new DemoAccessError(403, "Live request origin is not allowed");
  }
  const suppliedCode = request.headers.get("x-demo-access-code") ?? "";
  if (!secureEqual(suppliedCode, requiredAccessCode())) {
    throw new DemoAccessError(401, "A valid judge access code is required");
  }
}

export function liveDemoRunIds(): LiveRunIds {
  return {
    allow: requiredUuidEnv("ARC_DEMO_RUN_ID_ALLOW"),
    approval: requiredUuidEnv("ARC_DEMO_RUN_ID_APPROVAL"),
    block: requiredUuidEnv("ARC_DEMO_RUN_ID_BLOCK")
  };
}

export class DemoAccessError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "DemoAccessError";
  }
}

function secureEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest) && left.length === right.length;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new DemoAccessError(503, `${name} is not configured`);
  return value;
}

function requiredUuidEnv(name: string): string {
  const value = requiredEnv(name).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new DemoAccessError(503, `${name} must be a UUIDv4`);
  }
  return value;
}

function requiredAccessCode(): string {
  const value = requiredEnv("ARC_DEMO_ACCESS_CODE");
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new DemoAccessError(503, "ARC_DEMO_ACCESS_CODE must contain at least 32 bytes");
  }
  return value;
}
