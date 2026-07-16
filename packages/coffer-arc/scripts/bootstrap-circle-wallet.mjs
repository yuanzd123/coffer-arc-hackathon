import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { getAddress } from "viem";
import { stableUuidV4 } from "./stable-uuid.mjs";

const BLOCKCHAIN = "ARC-TESTNET";
const ACCOUNT_TYPE = "EOA";
const CUSTODY_TYPE = "DEVELOPER";
const DEFAULT_SEED = "coffer-arc-hackathon-2026-v1";
const PAIR_IDEMPOTENCY_VERSION = "arc-testnet-eoa-pair-v2";
const ROLES = Object.freeze({
  payer: Object.freeze({
    name: "Coffer Arc Payer",
    refId: "coffer-arc-payer-v2",
    role: "registry_operator_and_settlement_payer"
  }),
  vendorRecipient: Object.freeze({
    name: "Coffer Arc Vendor Recipient",
    refId: "coffer-arc-vendor-recipient-v2",
    role: "fixed_receive_only_vendor_recipient"
  })
});

try {
  if (process.argv.includes("--self-test")) {
    await runSelfTest();
  } else {
    await main();
  }
} catch (error) {
  process.stderr.write(`${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
}

async function main() {
  const outputArgument = readArg("--output");
  if (!outputArgument) {
    throw new Error("--output with a private file path is required");
  }
  const outputPath = path.resolve(process.cwd(), outputArgument);
  await assertPrivateOutputDestination(outputPath);

  const apiKey = requiredSecret("CIRCLE_API_KEY");
  const entitySecret = requiredSecret("CIRCLE_ENTITY_SECRET");
  const seed = bootstrapSeed();
  const require = createRequire(import.meta.url);
  const { initiateDeveloperControlledWalletsClient } = require(
    "@circle-fin/developer-controlled-wallets"
  );
  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

  const walletSetResponse = await suppressSdkConsole(() => client.createWalletSet({
    name: "Coffer Arc Hackathon",
    idempotencyKey: stableUuidV4(`${seed}:wallet-set`)
  }));
  const walletSetId = walletSetResponse.data?.walletSet?.id;
  if (!walletSetId) throw new Error("Circle did not return a wallet set ID");

  const walletsResponse = await suppressSdkConsole(() => client.createWallets(walletPairRequest(seed, walletSetId)));
  const pair = validateAndMapWalletPair(walletsResponse.data?.wallets, walletSetId);

  const result = {
    schemaVersion: 1,
    blockchain: BLOCKCHAIN,
    accountType: ACCOUNT_TYPE,
    walletSetId,
    payer: pair.payer,
    vendorRecipient: pair.vendorRecipient,
    deploymentEnvironment: {
      CIRCLE_ARC_WALLET_ID: pair.payer.walletId,
      CIRCLE_ARC_WALLET_ADDRESS: pair.payer.walletAddress,
      COFFER_ARC_FIXED_RECIPIENT: pair.vendorRecipient.walletAddress
    }
  };
  await writePrivateJsonExclusive(outputPath, result);
  process.stdout.write("Circle Arc wallet pair securely written to the private output file.\n");
}

function walletPairRequest(seed, walletSetId) {
  return {
    blockchains: [BLOCKCHAIN],
    accountType: ACCOUNT_TYPE,
    count: 2,
    walletSetId,
    metadata: [
      { name: ROLES.payer.name, refId: ROLES.payer.refId },
      { name: ROLES.vendorRecipient.name, refId: ROLES.vendorRecipient.refId }
    ],
    idempotencyKey: stableUuidV4(`${seed}:${PAIR_IDEMPOTENCY_VERSION}`)
  };
}

function validateAndMapWalletPair(wallets, walletSetId) {
  if (!Array.isArray(wallets) || wallets.length !== 2) {
    throw new Error("Circle must return exactly two wallets for the dedicated role pair");
  }

  const expectedByRefId = new Map(
    Object.entries(ROLES).map(([key, role]) => [role.refId, { key, role }])
  );
  const result = {};

  for (const wallet of wallets) {
    const expected = expectedByRefId.get(wallet?.refId);
    if (!expected) {
      throw new Error("Circle returned a wallet with a missing or unexpected role refId");
    }
    if (result[expected.key]) {
      throw new Error(`Circle returned the ${expected.key} role more than once`);
    }
    if (!wallet.id || !wallet.address) {
      throw new Error(`Circle did not return an ID and address for the ${expected.key} wallet`);
    }
    if (
      wallet.blockchain !== BLOCKCHAIN ||
      wallet.accountType !== ACCOUNT_TYPE ||
      wallet.custodyType !== CUSTODY_TYPE ||
      wallet.walletSetId !== walletSetId ||
      wallet.state !== "LIVE"
    ) {
      throw new Error(`Circle returned an invalid ${expected.key} wallet configuration`);
    }

    let walletAddress;
    try {
      walletAddress = getAddress(wallet.address);
    } catch {
      throw new Error(`Circle returned an invalid ${expected.key} wallet address`);
    }

    result[expected.key] = {
      role: expected.role.role,
      walletId: wallet.id,
      walletAddress,
      state: wallet.state,
      refId: expected.role.refId
    };
  }

  if (!result.payer || !result.vendorRecipient) {
    throw new Error("Circle did not return both required wallet roles");
  }
  if (result.payer.walletId === result.vendorRecipient.walletId) {
    throw new Error("Payer and vendor recipient must have distinct Circle wallet IDs");
  }
  if (
    result.payer.walletAddress.toLowerCase() ===
    result.vendorRecipient.walletAddress.toLowerCase()
  ) {
    throw new Error("Payer and vendor recipient must have distinct Arc addresses");
  }

  return result;
}

function bootstrapSeed() {
  const seed = process.env.COFFER_ARC_BOOTSTRAP_SEED?.trim() || DEFAULT_SEED;
  if (seed.length > 200 || /[\u0000-\u001f\u007f]/u.test(seed)) {
    throw new Error("COFFER_ARC_BOOTSTRAP_SEED must be 200 printable characters or fewer");
  }
  return seed;
}

function requiredSecret(name) {
  const value = process.env[name]?.trim();
  if (!value || value.length < 16) {
    throw new Error(`${name} is required and must remain outside source control`);
  }
  return value;
}

function safeErrorMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const name of ["CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET"]) {
    const secret = process.env[name]?.trim();
    if (secret) message = message.split(secret).join(`[${name} redacted]`);
  }
  return `Circle wallet bootstrap failed: ${message.slice(0, 2_000).replace(/[\u0000-\u001f\u007f]/gu, " ")}`;
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

async function runSelfTest() {
  const walletSetId = "018f5f2a-ff2b-7d9f-8a40-0123456789ab";
  const request = walletPairRequest(DEFAULT_SEED, walletSetId);
  assert.equal(request.count, 2);
  assert.deepEqual(request.blockchains, [BLOCKCHAIN]);
  assert.deepEqual(
    request.metadata.map(({ refId }) => refId),
    [ROLES.payer.refId, ROLES.vendorRecipient.refId]
  );
  assert.equal(request.idempotencyKey, walletPairRequest(DEFAULT_SEED, walletSetId).idempotencyKey);
  assert.notEqual(request.idempotencyKey, stableUuidV4(`${DEFAULT_SEED}:arc-testnet-eoa`));

  const payer = mockWallet({
    id: "payer-wallet-id",
    address: "0x1111111111111111111111111111111111111111",
    refId: ROLES.payer.refId,
    walletSetId
  });
  const recipient = mockWallet({
    id: "recipient-wallet-id",
    address: "0x2222222222222222222222222222222222222222",
    refId: ROLES.vendorRecipient.refId,
    walletSetId
  });
  const mapped = validateAndMapWalletPair([recipient, payer], walletSetId);
  assert.equal(mapped.payer.walletId, payer.id);
  assert.equal(mapped.vendorRecipient.walletId, recipient.id);

  assert.throws(
    () => validateAndMapWalletPair([{ ...recipient, refId: ROLES.payer.refId }, payer], walletSetId),
    /payer role more than once/
  );
  assert.throws(
    () => validateAndMapWalletPair([payer, { ...recipient, address: payer.address }], walletSetId),
    /distinct Arc addresses/
  );
  assert.throws(
    () => validateAndMapWalletPair([payer, { ...recipient, state: "FROZEN" }], walletSetId),
    /invalid vendorRecipient wallet configuration/
  );
  assert.throws(
    () => validateAndMapWalletPair([payer, { ...recipient, blockchain: "ETH-SEPOLIA" }], walletSetId),
    /invalid vendorRecipient wallet configuration/
  );

  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coffer-circle-wallet-output-"));
  try {
    await fs.chmod(outputDirectory, 0o700);
    const outputPath = path.join(outputDirectory, "pair.json");
    const output = { schemaVersion: 1, payer: mapped.payer, vendorRecipient: mapped.vendorRecipient };
    await assertPrivateOutputDestination(outputPath);
    await writePrivateJsonExclusive(outputPath, output);
    const stat = await fs.lstat(outputPath);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await fs.readFile(outputPath, "utf8")), output);
    await assert.rejects(() => assertPrivateOutputDestination(outputPath), /already exists/);
  } finally {
    await fs.rm(outputDirectory, { recursive: true, force: true });
  }

  process.stdout.write("Circle wallet bootstrap self-test passed\n");
}

async function assertPrivateOutputDestination(outputPath) {
  const parent = path.dirname(outputPath);
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("wallet output parent must be a regular directory");
  }
  if ((parentStat.mode & 0o777) !== 0o700) {
    throw new Error("wallet output parent must have mode 0700");
  }
  if (typeof process.getuid === "function" && parentStat.uid !== process.getuid()) {
    throw new Error("wallet output parent must be owned by the current user");
  }
  try {
    await fs.lstat(outputPath);
    throw new Error("wallet output already exists; refusing to overwrite it");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function writePrivateJsonExclusive(outputPath, value) {
  const parent = path.dirname(outputPath);
  const temporary = path.join(parent, `.${path.basename(outputPath)}.${crypto.randomUUID()}.tmp`);
  let linked = false;
  try {
    const handle = await fs.open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600
    );
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.link(temporary, outputPath);
    linked = true;
    await fsyncDirectory(parent);
  } finally {
    await fs.unlink(temporary).catch(() => {});
    if (linked) await fsyncDirectory(parent);
  }
  const stat = await fs.lstat(outputPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
    throw new Error("wallet output did not retain the required private file boundary");
  }
}

async function fsyncDirectory(directory) {
  const handle = await fs.open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function mockWallet({ id, address, refId, walletSetId }) {
  return {
    id,
    address,
    refId,
    walletSetId,
    blockchain: BLOCKCHAIN,
    accountType: ACCOUNT_TYPE,
    custodyType: CUSTODY_TYPE,
    state: "LIVE"
  };
}
