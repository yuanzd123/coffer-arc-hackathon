import { describe, expect, it } from "vitest";
import { parseDemoRunRequest, readDemoRequestJson } from "./request";

describe("public Arc demo request boundary", () => {
  it("accepts only a fixed server-defined scenario", () => {
    expect(parseDemoRunRequest({ scenarioId: "allow" })).toEqual({ scenarioId: "allow" });
  });

  it.each([
    { scenarioId: "allow", recipient: "0x1111111111111111111111111111111111111111" },
    { scenarioId: "allow", amount: "99.00" },
    { scenarioId: "allow", runId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" },
    { scenarioId: "custom" }
  ])("rejects arbitrary live inputs: %j", (body) => {
    expect(() => parseDemoRunRequest(body)).toThrow();
  });

  it("enforces the body limit even when Content-Length is absent", async () => {
    const request = new Request("https://arc-demo.example/api/demo", {
      method: "POST",
      body: JSON.stringify({ scenarioId: "allow", padding: "x".repeat(2_100) })
    });
    await expect(readDemoRequestJson(request)).rejects.toMatchObject({ status: 413 });
  });
});
