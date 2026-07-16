import { compileDecisionRegistry } from "./contract-artifact.mjs";

const artifact = await compileDecisionRegistry();
process.stdout.write(`PASS CofferDecisionRegistry.sol compiled with solc ${artifact.compilerVersion}\n`);
