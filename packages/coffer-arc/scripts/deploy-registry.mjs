import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createPublicClient, getAddress, http, keccak256 } from "viem";
import { arcTestnet } from "viem/chains";
import { compileDecisionRegistry, materializeRegistryRuntimeBytecode } from "./contract-artifact.mjs";
import { stableUuidV4 } from "./stable-uuid.mjs";

const CIRCLE_BLOCKCHAIN = "ARC-TESTNET";
const ARC_TESTNET_CHAIN_ID = 5_042_002;
const SENSITIVE_ENV_NAMES = ["CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET", "CIRCLE_ARC_WALLET_ID"];

class SafeDeploymentError extends Error {
  constructor(publicMessage, options) {
    super(publicMessage, options);
    this.name = "SafeDeploymentError";
    this.publicMessage = publicMessage;
  }
}

await main().catch((error) => {
  process.stderr.write(`${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  if (process.argv.includes("--self-test")) {
    await runSelfTest();
    return;
  }

  const apiKey = requiredSecret("CIRCLE_API_KEY");
  const entitySecret = requiredSecret("CIRCLE_ENTITY_SECRET");
  const walletId = requiredEnv("CIRCLE_ARC_WALLET_ID");
  const operator = requiredAddress("CIRCLE_ARC_WALLET_ADDRESS");
  const rpcUrl = process.env.ARC_RPC_URL?.trim() || "https://rpc.blockdaemon.testnet.arc.io";
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  const outputPath = path.resolve(
    repositoryRoot,
    process.env.COFFER_ARC_DEPLOYMENT_OUTPUT?.trim() || "deployments/arc-testnet.json"
  );
  assertPublicOutputPath(outputPath, [apiKey, entitySecret, walletId]);
  await assertOutputAbsent(outputPath);

  const artifact = await safeStep(
    "Coffer registry compilation failed before Circle submission.",
    () => compileDecisionRegistry()
  );
  const deploymentAbi = circleDeploymentAbi(artifact.abi);
  const deploymentKey = stableUuidV4(`coffer-arc-registry-v1:${operator}:${artifact.sourceHash}`);
  const { contractsClient, walletsClient } = await circleStep(
    "Circle deployment clients could not be initialized.",
    () => {
      const require = createRequire(import.meta.url);
      const { initiateDeveloperControlledWalletsClient } = require(
        "@circle-fin/developer-controlled-wallets"
      );
      const { initiateSmartContractPlatformClient } = require(
        "@circle-fin/smart-contract-platform"
      );
      return {
        contractsClient: initiateSmartContractPlatformClient({ apiKey, entitySecret }),
        walletsClient: initiateDeveloperControlledWalletsClient({ apiKey, entitySecret })
      };
    }
  );

  const submitted = await circleStep(
    "Circle registry submission failed; review the Circle dashboard before retrying the stable deployment request.",
    () => contractsClient.deployContract({
      name: "CofferDecisionRegistry",
      blockchain: CIRCLE_BLOCKCHAIN,
      walletId,
      abiJson: JSON.stringify(deploymentAbi),
      bytecode: artifact.bytecode,
      constructorParameters: [operator],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey: deploymentKey
    })
  );
  const contractId = submitted.data?.contractId;
  const transactionId = submitted.data?.transactionId;
  if (!contractId || !transactionId) {
    throw new SafeDeploymentError(
      "Circle accepted the deployment request but did not return both deployment identifiers."
    );
  }

  const contract = await pollContract(contractsClient, contractId);
  const registryAddress = responseAddress(
    contract.contractAddress,
    "Circle completed the deployment without a valid registry address."
  );
  const completed = await circleStep(
    "Circle transaction confirmation failed; review the Circle dashboard before retrying or changing deployment state.",
    () => walletsClient.getTransaction({
      id: transactionId,
      waitForState: "COMPLETE",
      pollingInterval: 1_500
    })
  );
  const transaction = completed.data?.transaction;
  const txHash = transaction?.txHash;
  if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new SafeDeploymentError(
      "Circle completed the deployment without a valid Arc transaction hash."
    );
  }

  const publicClient = await safeStep(
    "The Arc Testnet RPC client could not be initialized.",
    () => createPublicClient({
      chain: arcTestnet,
      transport: http(rpcUrl, { retryCount: 4, retryDelay: 500 })
    })
  );
  const receipt = await safeStep(
    "The Arc Testnet deployment receipt could not be verified.",
    () => publicClient.getTransactionReceipt({ hash: txHash })
  );
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new SafeDeploymentError("The Arc registry deployment reverted or has no contract address.");
  }
  const receiptAddress = responseAddress(
    receipt.contractAddress,
    "Arc returned an invalid registry address in the deployment receipt."
  );
  if (receiptAddress !== registryAddress) {
    throw new SafeDeploymentError("Circle and Arc returned different registry addresses.");
  }
  const chainId = await safeStep(
    "The Arc Testnet chain ID could not be verified.",
    () => publicClient.getChainId()
  );
  if (chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new SafeDeploymentError("The configured RPC endpoint is not Arc Testnet chain 5042002.");
  }
  const runtimeCode = await safeStep(
    "The deployed Arc registry runtime bytecode could not be read.",
    () => publicClient.getCode({ address: registryAddress })
  );
  if (!runtimeCode || runtimeCode === "0x") {
    throw new SafeDeploymentError("Arc registry runtime bytecode is missing.");
  }
  const expectedRuntimeCode = materializeRegistryRuntimeBytecode(artifact, operator);
  if (keccak256(runtimeCode) !== keccak256(expectedRuntimeCode)) {
    throw new SafeDeploymentError(
      "Deployed registry runtime bytecode does not match the compiled source and operator."
    );
  }

  const manifest = {
    schemaVersion: 1,
    network: CIRCLE_BLOCKCHAIN,
    chainId,
    registryAddress,
    operator,
    deploymentTransactionHash: txHash,
    deploymentBlockNumber: receipt.blockNumber.toString(),
    compilerVersion: artifact.compilerVersion,
    optimizer: artifact.optimizer,
    sourceHash: artifact.sourceHash,
    creationBytecodeHash: keccak256(artifact.bytecode),
    runtimeBytecodeHash: keccak256(runtimeCode),
    deployedAt: new Date().toISOString()
  };
  const manifestDocument = `${JSON.stringify(manifest, null, 2)}\n`;
  const publicResult = `${JSON.stringify({ ...manifest, manifestPath: outputPath }, null, 2)}\n`;
  assertNoSensitiveMaterial(manifestDocument, [apiKey, entitySecret, walletId]);
  assertNoSensitiveMaterial(publicResult, [apiKey, entitySecret, walletId]);
  await safeStep("The verified deployment manifest could not be written.", async () => {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, manifestDocument, { flag: "wx" });
  });
  process.stdout.write(publicResult);
}

function circleDeploymentAbi(abi) {
  // Circle only needs the constructor ABI to encode deployment arguments. The
  // complete compiler ABI remains the source of truth in the public package.
  if (!Array.isArray(abi)) {
    throw new SafeDeploymentError("Compiled registry ABI is invalid.");
  }
  const constructors = abi.filter((item) => item?.type === "constructor");
  if (constructors.length !== 1) {
    throw new SafeDeploymentError("Compiled registry ABI must contain exactly one constructor.");
  }
  return constructors;
}

async function pollContract(client, contractId) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const response = await circleStep(
      "Circle registry status polling failed; review the Circle dashboard before retrying or changing deployment state.",
      () => client.getContract({ id: contractId })
    );
    const contract = response.data?.contract;
    if (contract?.status === "COMPLETE" && contract.contractAddress) return contract;
    if (contract?.status === "FAILED") {
      throw new SafeDeploymentError("Circle reported that the registry deployment failed.");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new SafeDeploymentError("Timed out waiting for Circle registry deployment.");
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new SafeDeploymentError(`${name} is required.`);
  return value;
}

function requiredSecret(name) {
  const value = requiredEnv(name);
  if (value.length < 16) throw new SafeDeploymentError(`${name} is invalid.`);
  return value;
}

function requiredAddress(name) {
  const value = requiredEnv(name);
  try {
    return getAddress(value);
  } catch (error) {
    throw new SafeDeploymentError(`${name} must be a valid EVM address.`, { cause: error });
  }
}

function responseAddress(value, publicMessage) {
  try {
    return getAddress(value);
  } catch (error) {
    throw new SafeDeploymentError(publicMessage, { cause: error });
  }
}

function assertPublicOutputPath(outputPath, sensitiveValues) {
  if (sensitiveValues.some((value) => value && outputPath.includes(value))) {
    throw new SafeDeploymentError("The deployment output path must not contain Circle credentials or IDs.");
  }
}

async function assertOutputAbsent(outputPath) {
  try {
    await fs.lstat(outputPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new SafeDeploymentError("The deployment output path could not be checked safely.");
  }
  throw new SafeDeploymentError(
    "The Arc deployment manifest already exists; refusing to contact Circle or overwrite verified deployment state."
  );
}

function assertNoSensitiveMaterial(value, sensitiveValues) {
  if (sensitiveValues.some((sensitive) => sensitive && value.includes(sensitive))) {
    throw new SafeDeploymentError("The public deployment artifact unexpectedly contains private Circle material.");
  }
}

async function safeStep(publicMessage, action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof SafeDeploymentError) throw error;
    throw new SafeDeploymentError(publicMessage, { cause: error });
  }
}

async function circleStep(publicMessage, action) {
  try {
    return await suppressSdkConsole(action);
  } catch (error) {
    if (error instanceof SafeDeploymentError) throw error;
    throw new SafeDeploymentError(`${publicMessage}${safeCircleFailureCode(error)}`, { cause: error });
  }
}

function safeCircleFailureCode(error) {
  const rawStatus = error?.response?.status ?? error?.status;
  const rawCode = error?.response?.data?.code ?? error?.code;
  const parts = [];
  if (Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599) {
    parts.push(`HTTP ${rawStatus}`);
  }
  const code = typeof rawCode === "number" ? String(rawCode) : rawCode;
  if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) {
    parts.push(`Circle code ${code}`);
  }
  const remoteMessage = safeCircleRemoteMessage(error?.response?.data?.message ?? error?.message);
  if (remoteMessage) parts.push(`Circle message ${remoteMessage}`);
  return parts.length > 0 ? ` (${parts.join(", ")}).` : "";
}

function safeCircleRemoteMessage(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_000) return "";
  let message = value;
  for (const name of SENSITIVE_ENV_NAMES) {
    const sensitive = process.env[name]?.trim();
    if (sensitive) message = message.split(sensitive).join(`[${name} redacted]`);
  }
  message = message
    .replace(/(?:TEST|LIVE)_API_KEY:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+/gu, "[Circle API key redacted]")
    .replace(/\b[a-fA-F0-9]{64}\b/gu, "[64-hex secret redacted]")
    .replace(/[A-Za-z0-9_-]{80,}/gu, "[long token redacted]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, 400);
  return message;
}

async function suppressSdkConsole(action) {
  const methods = ["log", "error", "warn", "info", "debug"];
  const originals = Object.fromEntries(methods.map((name) => [name, console[name]]));
  for (const name of methods) console[name] = () => {};
  try {
    return await action();
  } finally {
    for (const name of methods) console[name] = originals[name];
  }
}

function safeErrorMessage(error) {
  const fallback =
    "Arc registry deployment failed unexpectedly. No external diagnostic object was printed.";
  let message = error instanceof SafeDeploymentError ? error.publicMessage : fallback;
  for (const name of SENSITIVE_ENV_NAMES) {
    const value = process.env[name]?.trim();
    if (value) message = message.split(value).join(`[${name} redacted]`);
  }
  message = message
    .replace(/(?:TEST|LIVE)_API_KEY:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+/gu, "[Circle API key redacted]")
    .replace(/\b[a-fA-F0-9]{64}\b/gu, "[64-hex secret redacted]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .slice(0, 2_000);
  return `Arc registry deployment failed: ${message}`;
}

async function runSelfTest() {
  const originalEnvironment = Object.fromEntries(
    SENSITIVE_ENV_NAMES.map((name) => [name, process.env[name]])
  );
  const testValues = {
    CIRCLE_API_KEY: ["TEST_API_KEY", "test-id", "test-secret-material"].join(":"),
    CIRCLE_ENTITY_SECRET: "a".repeat(64),
    CIRCLE_ARC_WALLET_ID: "private-circle-wallet-id"
  };
  try {
    Object.assign(process.env, testValues);
    const safeMessage = safeErrorMessage(
      new SafeDeploymentError(
        `safe context ${testValues.CIRCLE_API_KEY} ${testValues.CIRCLE_ENTITY_SECRET} ${testValues.CIRCLE_ARC_WALLET_ID}`
      )
    );
    for (const value of Object.values(testValues)) assert.equal(safeMessage.includes(value), false);

    const unknownMessage = safeErrorMessage(
      new Error(`Axios request config headers Authorization ${Object.values(testValues).join(" ")}`)
    );
    assert.match(unknownMessage, /No external diagnostic object was printed/);
    assert.equal(unknownMessage.includes("Axios"), false);
    for (const value of Object.values(testValues)) assert.equal(unknownMessage.includes(value), false);
    assert.throws(
      () => assertNoSensitiveMaterial(
        `public manifest ${testValues.CIRCLE_ARC_WALLET_ID}`,
        Object.values(testValues)
      ),
      /unexpectedly contains private Circle material/
    );
    assert.deepEqual(
      circleDeploymentAbi([
        { type: "error", name: "IgnoredByDeployment" },
        { type: "constructor", inputs: [{ name: "operator", type: "address" }] },
        { type: "function", name: "operator" }
      ]),
      [{ type: "constructor", inputs: [{ name: "operator", type: "address" }] }]
    );

    await assert.rejects(
      () => safeStep("Fixed public step failure.", () => {
        throw new Error(`headers: Authorization ${testValues.CIRCLE_API_KEY}`);
      }),
      (error) => error instanceof SafeDeploymentError && error.publicMessage === "Fixed public step failure."
    );

    assert.equal(
      safeCircleFailureCode({ response: { status: 400, data: { code: "INVALID_REQUEST", message: testValues.CIRCLE_API_KEY } } }),
      " (HTTP 400, Circle code INVALID_REQUEST, Circle message [CIRCLE_API_KEY redacted])."
    );
    assert.equal(
      safeCircleFailureCode({ response: { status: 401, data: { code: testValues.CIRCLE_API_KEY } } }),
      " (HTTP 401)."
    );

    const consoleMethods = ["log", "error", "warn", "info", "debug"];
    const originalConsole = Object.fromEntries(consoleMethods.map((name) => [name, console[name]]));
    const observed = [];
    try {
      for (const name of consoleMethods) console[name] = () => observed.push(name);
      const result = await suppressSdkConsole(() => {
        for (const name of consoleMethods) console[name](testValues.CIRCLE_API_KEY);
        return "complete";
      });
      assert.equal(result, "complete");
      assert.deepEqual(observed, []);
      for (const name of consoleMethods) assert.equal(typeof console[name], "function");
    } finally {
      for (const name of consoleMethods) console[name] = originalConsole[name];
    }
  } finally {
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  process.stdout.write("Arc registry deployment safety self-test passed\n");
}
