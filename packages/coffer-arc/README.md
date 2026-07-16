# Coffer for Arc

This package is the narrow, public-extractable Arc integration for Coffer. It asks the hosted Coffer control plane for a spend decision **before** any wallet operation, anchors an opaque decision commitment, executes an approved USDC transfer through Arc's predeployed Memo contract, verifies the onchain evidence, and then reports the transaction hash to Coffer.

## Safety boundary

- `block` and `requires_approval` never call the Arc writer.
- Live writes require a dedicated Circle Developer-Controlled payer **EOA** and a separate receive-only vendor recipient EOA. Arc Memo does not support a smart contract wallet as the direct caller.
- Circle anchor and settlement operations use separate, deterministic UUIDv4 idempotency keys so process retries do not create a second payment.
- The verifier checks the Arc chain, registry event, Memo event, USDC Transfer event, sender, recipient, amount, commitment, and record hash before settlement is reported.
- The registry is immutable, non-upgradeable, operator-only, and non-custodial.
- Coffer's production policy engine, approval workflow, budget concurrency, ledger, evidence retention, RBAC, and data model are not part of this package.

Arc Testnet USDC has no real-world value. Never use a production wallet, production credentials, or customer data with this demo.

## Local verification

Node 22 or newer is required by Circle's Developer-Controlled Wallet SDK.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @coffer/arc typecheck
pnpm --filter @coffer/arc test
```

The test suite validates the pre-payment gate, strict operation order, replay behavior, commitment construction, Circle idempotency keys, public hosted contract mapping, and Solidity compilation.
The optional `pnpm contract:test` command runs the pinned Foundry image and requires Docker.

## Live environment

The adapter expects server-side values for the hosted Coffer API, the dedicated Circle sandbox project, its payer/operator EOA, the separate fixed vendor recipient EOA, the deployed decision registry, and Arc RPC. Create the two Arc Testnet EOAs as one idempotent, role-labelled pair and validate the bootstrap offline. Always write the Circle response to a private, ignored file so wallet IDs are not printed to the terminal:

```bash
pnpm circle:bootstrap-wallet -- --self-test
mkdir -p .tmp/arc
chmod 0700 .tmp/arc
pnpm circle:bootstrap-wallet -- --output .tmp/arc/circle-wallet-pair.json
```

The output is created once with mode `0600`. Keep the same `COFFER_ARC_BOOTSTRAP_SEED` for retries, transfer its `deploymentEnvironment` mapping through a secret manager, fund only the payer, and never configure the recipient as an operator or signer. Never print or commit the bootstrap output. Secrets must never use a `NEXT_PUBLIC_` prefix or enter browser code, logs, source control, or transaction memo data.

After `live:preflight` passes, use fresh UUIDv4 scenario run IDs and generate the ordered block, approval, allow, and allow-replay evidence bundle:

```bash
pnpm --filter @coffer/arc live:evidence
pnpm --filter @coffer/arc evidence:verify
```

Fresh mode remains the default and requires a new, unused allow UUIDv4. It fails closed if Coffer reports a replay or if the current operator nonce does not increase by exactly two. Do not use recovery as a substitute for fresh run IDs.

If both allow transactions were already mined but the evidence process crashed before writing its artifact, explicitly recover that same allow run:

```bash
pnpm --filter @coffer/arc live:evidence -- --recover-allow
```

Recovery mode first proves the existing Registry commitment and unique Memo settlement from public Arc state, disables all Circle writer calls, reconstructs the original consecutive two-transaction nonce/order window, and requires the operator nonce to remain unchanged throughout the current recovery observation. It refuses a new/unmined UUID and still never overwrites an existing evidence file.

`live:evidence` writes `deployments/arc-testnet-evidence.json` once. The schema distinguishes a fresh current execution from a recovered historical execution and stores only public Arc state, hashed allow-record evidence, nonce windows, and ArcScan links; block and approval outcomes do not retain record fingerprints. The deployment manifest contains no Circle-internal IDs.

Hosted outcomes, writer-call counts, settlement-reference repair, and replay observations are runner-attested. `evidence:verify` independently verifies deployment and onchain claims using the public Solidity source, pinned `solc`, deployment manifest, evidence file, and Arc RPC; it never needs Circle or Coffer credentials. Use `COFFER_ARC_DEPLOYMENT_MANIFEST` and `COFFER_ARC_EVIDENCE_OUTPUT` to select alternate files.

This package remains `private: true` to prevent accidental npm publication. Repository creation, deployment, and any package publication are separate, audited steps.
