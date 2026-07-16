import fs from "node:fs/promises";
import path from "node:path";
import solc from "solc";
import { keccak256, stringToHex } from "viem";

const root = path.resolve(import.meta.dirname, "..");
const sourceName = "CofferDecisionRegistry.sol";
const contractName = "CofferDecisionRegistry";

export async function compileDecisionRegistry() {
  const sourcePath = path.join(root, "contracts", "src", sourceName);
  const source = await fs.readFile(sourcePath, "utf8");
  const settings = {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      "*": {
        "*": [
          "abi",
          "evm.bytecode.object",
          "evm.deployedBytecode.object",
          "evm.deployedBytecode.immutableReferences",
          "metadata"
        ]
      }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { [sourceName]: { content: source } },
    settings
  })));
  const errors = Array.isArray(output.errors) ? output.errors : [];
  const fatalErrors = errors.filter((entry) => entry.severity === "error");
  if (fatalErrors.length > 0) {
    throw new Error(fatalErrors.map((entry) => entry.formattedMessage ?? entry.message).join("\n"));
  }
  const compiled = output.contracts?.[sourceName]?.[contractName];
  if (!compiled?.abi || !compiled?.evm?.bytecode?.object || !compiled?.evm?.deployedBytecode?.object) {
    throw new Error("Solidity compiler did not produce the expected Decision Registry artifact");
  }
  if (!compiled.abi.some((entry) => entry.type === "event" && entry.name === "DecisionAnchored")) {
    throw new Error("Compiled Decision Registry ABI is missing DecisionAnchored");
  }
  return {
    contractName,
    sourceName,
    source,
    sourceHash: keccak256(stringToHex(source)),
    compilerVersion: solc.version(),
    optimizer: settings.optimizer,
    abi: compiled.abi,
    bytecode: `0x${compiled.evm.bytecode.object}`,
    deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`,
    immutableReferences: compiled.evm.deployedBytecode.immutableReferences ?? {}
  };
}

export function materializeRegistryRuntimeBytecode(artifact, operator) {
  const hex = artifact.deployedBytecode.slice(2).split("");
  const encodedOperator = operator.toLowerCase().slice(2).padStart(64, "0");
  const immutableEntries = Object.values(artifact.immutableReferences);
  if (immutableEntries.length !== 1 || immutableEntries[0].length === 0) {
    throw new Error("Expected exactly one immutable operator identifier in registry runtime bytecode");
  }
  for (const reference of immutableEntries[0]) {
    if (reference.length !== 32 || reference.start < 0 || (reference.start + reference.length) * 2 > hex.length) {
      throw new Error("Registry immutable operator reference is invalid");
    }
    const start = reference.start * 2;
    hex.splice(start, reference.length * 2, ...encodedOperator);
  }
  return `0x${hex.join("")}`;
}
