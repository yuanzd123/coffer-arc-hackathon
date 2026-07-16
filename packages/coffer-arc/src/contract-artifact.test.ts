import { describe, expect, it } from "vitest";
import type { AbiParameter } from "viem";
import { decisionRegistryAbi } from "./abis";
// @ts-expect-error The deployment helper is intentionally plain ESM so it can run without a TS loader.
import { compileDecisionRegistry, materializeRegistryRuntimeBytecode } from "../scripts/contract-artifact.mjs";

describe("Decision Registry compiler artifact", () => {
  it("keeps the public ABI aligned with the compiled contract", async () => {
    const artifact = await compileDecisionRegistry();
    const compiledEntries = artifact.abi
      .filter((entry: { type: string }) => entry.type === "function" || entry.type === "event")
      .map(normalizeAbiEntry)
      .sort(compareAbiEntries);

    expect(compiledEntries).toEqual(decisionRegistryAbi.map(normalizeAbiEntry).sort(compareAbiEntries));
  });

  it("materializes every reference to the one immutable operator", async () => {
    const artifact = await compileDecisionRegistry();
    const operator = "0x1111111111111111111111111111111111111111";
    const runtime = materializeRegistryRuntimeBytecode(artifact, operator);

    expect(runtime).toMatch(/^0x[0-9a-f]+$/);
    expect(runtime.length).toBe(artifact.deployedBytecode.length);
    expect(runtime).not.toBe(artifact.deployedBytecode);
    const referenceCount = Object.values(artifact.immutableReferences).flat().length;
    expect(runtime.split(operator.slice(2))).toHaveLength(referenceCount + 1);
  });
});

function normalizeAbiEntry(entry: {
  type: string;
  name?: string;
  stateMutability?: string;
  anonymous?: boolean;
  inputs?: readonly AbiParameter[];
  outputs?: readonly AbiParameter[];
}) {
  return {
    type: entry.type,
    name: entry.name,
    stateMutability: entry.stateMutability,
    anonymous: entry.anonymous,
    inputs: entry.inputs?.map(normalizeParameter) ?? [],
    outputs: entry.outputs?.map(normalizeParameter) ?? []
  };
}

function compareAbiEntries(left: ReturnType<typeof normalizeAbiEntry>, right: ReturnType<typeof normalizeAbiEntry>) {
  return `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`);
}

type NormalizedParameter = {
  name: string;
  type: string;
  indexed: boolean | undefined;
  components: NormalizedParameter[] | undefined;
};

function normalizeParameter(parameter: AbiParameter & { indexed?: boolean }): NormalizedParameter {
  return {
    name: parameter.name ?? "",
    type: parameter.type,
    indexed: parameter.indexed,
    components: "components" in parameter
      ? parameter.components.map((component) => normalizeParameter(component))
      : undefined
  };
}
