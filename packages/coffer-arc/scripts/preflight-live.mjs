import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import {
  createPublicClient,
  formatEther,
  getAddress,
  http,
  keccak256,
  zeroAddress
} from "viem";
import { arcTestnet } from "viem/chains";

const require = createRequire(import.meta.url);
const ARC_CHAIN_ID = 5_042_002;
const ARC_USDC = getAddress("0x3600000000000000000000000000000000000000");
const ARC_MEMO = getAddress("0x5294E9927c3306DcBaDb03fe70b92e01cCede505");
const SAFE_FAILURE = Object.freeze({
  ok: false,
  error: "Arc live preflight failed; no credential or provider detail was emitted"
});
const registryAbi = [{
  type: "function",
  name: "operator",
  stateMutability: "view",
  inputs: [],
  outputs: [{ name: "", type: "address" }]
}];
const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }
];

main().catch(() => {
  process.stderr.write(`${JSON.stringify(SAFE_FAILURE)}\n`);
  process.exitCode = 1;
});

async function main() {
  if (process.argv.includes("--self-test")) {
    await runSelfTest();
    process.stdout.write(`${JSON.stringify({ ok: true, selfTest: "preflight-live-safe-output" })}\n`);
    return;
  }

  if (process.env.ARC_WRITE_ENABLED !== "true" || process.env.CONFIRM_ARC_TESTNET_ONLY !== "ARC_TESTNET") {
    throw new Error("Arc Testnet confirmation is missing");
  }
  const apiKey = requiredSecret("CIRCLE_API_KEY");
  const entitySecret = requiredSecret("CIRCLE_ENTITY_SECRET");
  const walletId = requiredEnv("CIRCLE_ARC_WALLET_ID");
  const walletAddress = getAddress(requiredEnv("CIRCLE_ARC_WALLET_ADDRESS"));
  const registryAddress = getAddress(requiredEnv("COFFER_ARC_REGISTRY_ADDRESS"));
  const recipient = getAddress(requiredEnv("COFFER_ARC_FIXED_RECIPIENT"));
  const cofferBaseUrl = verifiedHttpsBaseUrl(requiredEnv("COFFER_API_BASE_URL"));
  requiredSecret("COFFER_API_KEY");
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  const deploymentPath = path.resolve(
    repositoryRoot,
    process.env.COFFER_ARC_DEPLOYMENT_MANIFEST?.trim() || "deployments/arc-testnet.json"
  );
  const manifest = JSON.parse(await fs.readFile(deploymentPath, "utf8"));
  const rpcUrl = process.env.ARC_RPC_URL?.trim() || "https://rpc.blockdaemon.testnet.arc.io";
  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl, { retryCount: 4, retryDelay: 500 })
  });

  const chainId = await publicClient.getChainId();
  if (chainId !== ARC_CHAIN_ID) throw new Error("Unexpected chain ID");
  for (const address of [ARC_USDC, ARC_MEMO, registryAddress]) {
    const code = await publicClient.getCode({ address });
    if (!code || code === "0x") throw new Error("Required Arc contract code is missing");
  }
  const runtimeCode = await publicClient.getCode({ address: registryAddress });
  if (!runtimeCode || keccak256(runtimeCode) !== manifest.runtimeBytecodeHash) {
    throw new Error("Registry runtime bytecode does not match the deployment manifest");
  }
  const operator = getAddress(await publicClient.readContract({
    address: registryAddress,
    abi: registryAbi,
    functionName: "operator"
  }));
  if (operator !== walletAddress) throw new Error("Registry operator does not match the configured EOA");
  if (getAddress(manifest.registryAddress) !== registryAddress || getAddress(manifest.operator) !== operator) {
    throw new Error("Deployment manifest does not match Arc state");
  }
  if (Number(manifest.chainId) !== chainId) throw new Error("Deployment manifest chain ID mismatch");

  const usdcDecimals = Number(await publicClient.readContract({
    address: ARC_USDC,
    abi: erc20Abi,
    functionName: "decimals"
  }));
  if (usdcDecimals !== 6) throw new Error("Unexpected Arc USDC decimals");
  const usdcBalanceMinor = await publicClient.readContract({
    address: ARC_USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [walletAddress]
  });
  if (usdcBalanceMinor < 10_000n) throw new Error("Insufficient Arc Testnet USDC");
  const gasBalance = await publicClient.getBalance({ address: walletAddress });
  if (gasBalance <= 0n) throw new Error("Arc native gas balance is empty");

  const forbiddenRecipients = new Set([
    zeroAddress.toLowerCase(),
    walletAddress.toLowerCase(),
    registryAddress.toLowerCase(),
    ARC_USDC.toLowerCase(),
    ARC_MEMO.toLowerCase()
  ]);
  if (forbiddenRecipients.has(recipient.toLowerCase())) throw new Error("Unsafe fixed recipient");

  const wallet = await withSuppressedConsole(async () => {
    const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");
    const walletClient = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
    const walletResponse = await walletClient.getWallet({ id: walletId });
    return walletResponse.data?.wallet;
  });
  if (!wallet || getAddress(wallet.address) !== walletAddress) {
    throw new Error("Circle wallet binding does not match the configured EOA");
  }
  if (wallet.blockchain !== "ARC-TESTNET" || wallet.accountType !== "EOA" || wallet.state !== "LIVE") {
    throw new Error("Circle wallet is not a live Arc Testnet EOA");
  }

  for (const name of ["ARC_DEMO_RUN_ID_ALLOW", "ARC_DEMO_RUN_ID_APPROVAL", "ARC_DEMO_RUN_ID_BLOCK"]) {
    requiredUuidV4(name);
  }
  if (Buffer.byteLength(requiredEnv("ARC_DEMO_ACCESS_CODE"), "utf8") < 32) {
    throw new Error("Invalid demo access code");
  }
  const healthResponse = await fetch(new URL("health", `${cofferBaseUrl}/`), {
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" }
  });
  if (!healthResponse.ok) throw new Error("Hosted Coffer health check failed");

  process.stdout.write(`${JSON.stringify(buildSuccessSummary({
    chainId,
    walletAddress,
    registryAddress,
    operator,
    recipient,
    manifest,
    usdcDecimals,
    usdcBalanceMinor,
    gasBalance,
    healthStatus: healthResponse.status
  }), null, 2)}\n`);
}

function buildSuccessSummary({
  chainId,
  walletAddress,
  registryAddress,
  operator,
  recipient,
  manifest,
  usdcDecimals,
  usdcBalanceMinor,
  gasBalance,
  healthStatus
}) {
  return {
    ok: true,
    network: "ARC-TESTNET",
    chainId,
    walletAddress,
    registryAddress,
    fixedRecipient: recipient,
    contracts: {
      usdcAddress: ARC_USDC,
      memoAddress: ARC_MEMO,
      requiredCodePresent: true
    },
    balances: {
      usdcDecimals,
      usdcMinor: usdcBalanceMinor.toString(),
      nativeGas: formatEther(gasBalance)
    },
    manifest: {
      chainMatches: true,
      registryAddressMatches: true,
      operatorMatches: operator === walletAddress,
      runtimeBytecodeMatches: true,
      runtimeBytecodeHash: manifest.runtimeBytecodeHash,
      deploymentBlock: String(manifest.deploymentBlockNumber)
    },
    circleWalletBindingVerified: true,
    cofferHealthStatus: healthStatus
  };
}

async function withSuppressedConsole(action) {
  const methods = Object.getOwnPropertyNames(console)
    .filter((name) => typeof console[name] === "function");
  const originals = new Map(methods.map((name) => [name, console[name]]));
  for (const name of methods) console[name] = () => {};
  try {
    return await action();
  } finally {
    for (const [name, original] of originals) console[name] = original;
  }
}

async function runSelfTest() {
  const sentinels = {
    apiKey: ["TEST_API_KEY", "provider-id", "super-secret-value"].join(":"),
    entitySecret: "entity-secret-that-must-never-appear",
    walletId: "circle-wallet-id-that-must-never-appear"
  };
  const failureJson = JSON.stringify(SAFE_FAILURE);
  for (const value of Object.values(sentinels)) {
    if (failureJson.includes(value)) throw new Error("Failure output leaked an internal value");
  }

  let suppressedCalls = 0;
  const originalLog = console.log;
  console.log = () => { suppressedCalls += 1; };
  try {
    await withSuppressedConsole(async () => {
      console.log(sentinels.apiKey);
      console.error(sentinels.entitySecret);
    });
    console.log("restored");
  } finally {
    console.log = originalLog;
  }
  if (suppressedCalls !== 1) throw new Error("Console suppression did not restore the caller console");

  const walletAddress = getAddress("0x1111111111111111111111111111111111111111");
  const summaryJson = JSON.stringify(buildSuccessSummary({
    chainId: ARC_CHAIN_ID,
    walletAddress,
    registryAddress: getAddress("0x2222222222222222222222222222222222222222"),
    operator: walletAddress,
    recipient: getAddress("0x3333333333333333333333333333333333333333"),
    manifest: {
      runtimeBytecodeHash: `0x${"44".repeat(32)}`,
      deploymentBlockNumber: "123"
    },
    usdcDecimals: 6,
    usdcBalanceMinor: 20_000_000n,
    gasBalance: 20_000_000_000_000_000_000n,
    healthStatus: 200,
    walletId: sentinels.walletId
  }));
  for (const value of Object.values(sentinels)) {
    if (summaryJson.includes(value)) throw new Error("Success output leaked an internal value");
  }
  const summary = JSON.parse(summaryJson);
  if (!summary.ok || !summary.manifest.runtimeBytecodeMatches || !summary.circleWalletBindingVerified) {
    throw new Error("Success summary lost a required verification signal");
  }
}

function verifiedHttpsBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Invalid hosted Coffer URL");
  }
  return url.toString().replace(/\/$/, "");
}

function requiredUuidV4(name) {
  const value = requiredEnv(name).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error("Invalid demo run ID");
  }
  return value;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("Required preflight configuration is missing");
  return value;
}

function requiredSecret(name) {
  const value = requiredEnv(name);
  if (value.length < 16) throw new Error("Invalid preflight credential");
  return value;
}
