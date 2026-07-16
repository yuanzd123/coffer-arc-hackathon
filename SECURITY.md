# Security policy

## Scope

This repository is an Arc Testnet prototype using synthetic data and test USDC with no real-world value. It must never be configured with a production/customer Coffer workspace, production funds, customer data, or a general-purpose wallet.

## Report a vulnerability

Email `support@cofferapi.com` with the subject `Coffer Arc security report`. Please include the affected commit, reproduction steps, impact, and any suggested mitigation. Do not test against the hosted live demo in a way that consumes API quota or submits transactions without authorization.

## Credential handling

- Circle entity secrets, API keys, Coffer API keys, and judge access codes are server-side values only.
- Never use a `NEXT_PUBLIC_` prefix for a secret.
- Never place secrets, recovery files, private keys, customer data, or raw private decision records in source, logs, Memo data, screenshots, issues, or pull requests.
- The public CI workflow has `contents: read`, receives no deployment secrets, and never uses `pull_request_target`.

## Live-demo controls

- Arc Testnet is hard-coded and must be confirmed explicitly.
- Production host and HTTPS origin must match exactly.
- The server, not the browser, selects one fixed UUIDv4 run ID per scenario.
- Only the allow scenario can reach the writer, and only for the fixed recipient and exactly `10,000` USDC minor units (`$0.01`).
- Approval and block outcomes never call Circle.
- Retries reuse Coffer and Circle idempotency keys and independently reverify Registry, Memo, and Transfer evidence.
- The deployment uses a dedicated low-balance Circle sandbox EOA and should disable writes and rotate credentials after judging.
