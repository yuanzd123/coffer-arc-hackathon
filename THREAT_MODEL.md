# Threat model

## Assets

- integrity of the Coffer spend decision and its Arc commitment
- dedicated Circle sandbox EOA and its testnet balance
- Circle and Coffer API quota
- server-side credentials
- accuracy of the public Arc evidence
- confidentiality of Coffer’s private policy and production systems

## Trust boundaries

The browser is untrusted. It can select only one of three scenario IDs; run ID, recipient, amount, wallet, registry, and hosted credentials are controlled by the server. The hosted Coffer control plane is trusted to evaluate the synthetic intent and return the canonical decision contract. Circle is trusted to control the EOA. Arc state is independently checked through RPC receipts, logs, and contract reads.

## Main threats and controls

| Threat | Control |
| --- | --- |
| Arbitrary recipient or amount | API rejects extra fields; scenario data is server-defined; writer rechecks fixed recipient and `$0.01`. |
| Misconfigured policy allows approval/block scenario | Expected outcome wrapper fails closed before any writer call. |
| Same idempotency key reused with changed payload | Hosted Coffer stores a canonical request fingerprint and returns `409`; demo inputs are fixed. |
| Retry creates a second payment | Stable, separate Circle UUIDv4 keys for anchor and settlement; fixed server run IDs; replay path verifies existing chain evidence. |
| Fake or mismatched chain evidence | Verify Arc chain ID, Registry operator/state/event, receipt status/from/to, Memo sender/target/ID/data/call hash, and exact same-transaction USDC Transfer. |
| Third party emits the same Memo ID | Indexed query filters sender, target, and Memo ID and matches transaction hash and log index. |
| Shared judge code leaks | Fixed runs prevent new unique payments; low-balance EOA; exact host/origin; code has at least 32 bytes; writes disabled after judging. |
| Secret or private-core disclosure | Exact public file manifest, clean Git history, secret/private-path scans, no private workspace imports, public DTO redaction. |
| Public repo cloned | No open-source license; private control-plane logic and production systems are absent. Technical access cannot prevent copying of public proof code. |

## Explicit non-goals

- mainnet or real-value custody
- anonymous public transaction service
- production-grade Sybil resistance for a shared hackathon demo
- exposing or reproducing Coffer’s policy/risk, budget, approval, ledger, customer, or operational systems
