# Arc Testnet deployment runbook

Use only a dedicated Circle sandbox project, dedicated synthetic Coffer workspace, synthetic recipient, and test USDC. Keep all live values outside source control.

1. In Circle Console, create a sandbox API key, register an entity secret, and save the recovery file in an approved secret store. Do not paste any of them into chat, shell history, issues, or source.
2. Optionally run the wallet bootstrap's offline validation, then load `CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET` from an ignored secret manager export and create the dedicated Arc EOA pair. Always write the response to a private file so Circle wallet IDs are not printed to the terminal:

   ```bash
   pnpm --filter @coffer/arc circle:bootstrap-wallet -- --self-test
   mkdir -p .tmp/arc
   chmod 0700 .tmp/arc
   pnpm circle:bootstrap-wallet -- --output .tmp/arc/circle-wallet-pair.json
   ```

   The output file is created once with mode `0600`; the command refuses to overwrite it. The operation is idempotent for the same `COFFER_ARC_BOOTSTRAP_SEED` and returns two distinct, role-labelled wallets. Do not change that seed when retrying, do not print the file in shared logs, and do not commit the bootstrap output. Transfer its `deploymentEnvironment` mapping through the secret manager: `CIRCLE_ARC_WALLET_ID` and `CIRCLE_ARC_WALLET_ADDRESS` identify the payer/operator; `COFFER_ARC_FIXED_RECIPIENT` identifies the separate, receive-only synthetic vendor. Fund only the payer address from Circle’s Arc Testnet faucet. Never configure the recipient wallet as a Registry operator or transaction signer.
3. With the payer variables set, deploy the Registry through Circle Smart Contract Platform:

   ```bash
   pnpm contract:deploy
   ```

   The script uses the Circle EOA as both deployer and immutable Registry operator, verifies the Arc receipt and exact runtime bytecode, and writes `deployments/arc-testnet.json` without secrets.
4. Configure a dedicated Coffer workspace in `limited_real` mode. Register only `external_research_agent`, `arc-data-agent`, and the returned fixed synthetic vendor recipient address. Configure:

   - `$0.01` allow scenario
   - `$12.00` approval threshold scenario
   - unknown-vendor block scenario
   - API key restricted to that agent with only `spend_intents:write` and `settlement_references:write`

5. Generate one high-entropy access code and three UUIDv4 run IDs. Set all variables from `.env.example` in the Vercel Production environment. Set `ARC_DEMO_ALLOWED_HOST` to the exact production hostname.
6. Run the secret-backed preflight locally without printing or committing secrets:

   ```bash
   pnpm live:preflight
   ```

7. Run block, approval, allow, and allow-replay evidence checks. Confirm block/approval created no Circle transaction, allow produced one Registry anchor and one Memo/USDC transaction, replay returned the original hashes, and every ArcScan link resolves.
8. Deploy the Web app in mock mode first. Enable `ARC_DEMO_MODE=live`, `ARC_WRITE_ENABLED=true`, and `CONFIRM_ARC_TESTNET_ONLY=ARC_TESTNET` only after preflight passes.
9. After judging, set `ARC_WRITE_ENABLED=false`, rotate the access code and API credentials, and archive only the public evidence manifest.
