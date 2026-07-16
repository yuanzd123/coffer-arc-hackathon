import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertLiveDemoAuthorized, liveDemoRunIds } from "./security";

const originalEnv = { ...process.env };

beforeEach(() => {
  Object.assign(process.env, {
    ARC_DEMO_MODE: "live",
    ARC_WRITE_ENABLED: "true",
    CONFIRM_ARC_TESTNET_ONLY: "ARC_TESTNET",
    VERCEL_ENV: "production",
    ARC_DEMO_ALLOWED_HOST: "arc-demo.example",
    ARC_DEMO_ACCESS_CODE: "judge-access-code-with-enough-entropy",
    ARC_DEMO_RUN_ID_ALLOW: "11111111-1111-4111-8111-111111111111",
    ARC_DEMO_RUN_ID_APPROVAL: "22222222-2222-4222-8222-222222222222",
    ARC_DEMO_RUN_ID_BLOCK: "33333333-3333-4333-8333-333333333333"
  });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("live demo authorization", () => {
  it("accepts the exact host, origin, access code, and scenario run ID", () => {
    const request = liveRequest();
    expect(() => assertLiveDemoAuthorized(request)).not.toThrow();
    expect(liveDemoRunIds().allow).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("rejects a short judge access code", () => {
    process.env.ARC_DEMO_ACCESS_CODE = "too-short";
    expect(() => assertLiveDemoAuthorized(liveRequest())).toThrow(/at least 32 bytes/);
  });

  it("rejects non-production live execution even if every other value is valid", () => {
    process.env.VERCEL_ENV = "preview";
    expect(() => assertLiveDemoAuthorized(liveRequest())).toThrow(/production demo deployment/);
  });
});

function liveRequest(): Request {
  return new Request("https://arc-demo.example/api/demo", {
    method: "POST",
    headers: {
      host: "arc-demo.example",
      origin: "https://arc-demo.example",
      "x-demo-access-code": "judge-access-code-with-enough-entropy"
    }
  });
}
