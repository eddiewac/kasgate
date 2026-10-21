# KasGate

**Kaspa x402 payment gateway for API sellers and AI agents.**

KasGate is a reverse proxy that puts pay-per-call [x402](https://www.x402.org/) payments in Kaspa in front of any HTTP API. It also includes a budgeted agent wallet that pays for those calls automatically. It is built on [`elldeeone/kaspa-x402`](https://github.com/elldeeone/kaspa-x402) and supports the `exact` scheme (one on-chain payment per call) and the `batch` scheme (a covenant deposit channel with off-chain vouchers, then a claim and a refund).

> ⚠️ **TESTNET ONLY (Testnet-10). NOT AUDITED FOR MAINNET.**
> This is a prototype. The network is pinned to `kaspa:testnet-10`. Do not use it with real funds. See [Known limitations](#known-limitations) and [SECURITY.md](SECURITY.md).

## Quickstart (mock chain, no funds needed)

Requires Node.js 20+ and a local checkout of `kaspa-x402` (see *Dependencies* below).

```bash
./scripts/bootstrap.sh   # clones kaspa-x402 to ../upstream-x402 at the pinned commit and builds it, fetches the
                         # rusty-kaspa WASM SDK v2.0.0 to ../vendor (sha256-checked; SKIP_SDK=1 to skip), then npm ci
npm rebuild better-sqlite3   # only if install ran with --ignore-scripts or the native build was skipped; otherwise ~20 tests fail
npm test            # unit + integration tests on the mock chain
npm run demo        # upstream API + gateway + paying agent in one process
```

Real Testnet-10 (optional): `cp .env.example .env`, set `TN10_WALLET_KEY_FILE`, run `npm run wallet:init`, fund the printed address with test KAS, then run `X402_CHAIN=real npm run gateway`.

## Configuration

- Routes, price and `payTo`: the YAML files in `config/` (replace `kaspatest:YOUR_MERCHANT_ADDRESS`). Select one with `X402_CONFIG`.
- Environment variables are listed in `.env.example`. Keys live in files (mode 0600) under the gitignored `.secrets/` directory and never go in env vars or SQLite.
- Dashboard: create a hash with `npm run hash-password` and set `X402_DASHBOARD_PASSWORD_HASH`.

## Dependencies

`package.json` points to the `@kaspa-x402/*` packages with `file:../upstream-x402/...` because they aren't on npm, so a plain `npm ci` in a fresh clone fails. `scripts/bootstrap.sh` sets everything up (upstream commit `8d575de` = kaspa-x402 1.0.1; override with `UPSTREAM_COMMIT`). The real-TN10 code needs the rusty-kaspa WASM SDK (nodejs build) at `../vendor/kaspa-wasm32-sdk/nodejs/kaspa` or at `KASPA_WASM_SDK`; without it the real-chain tests are skipped with a reason, and everything else runs.

---


Built **on top of [elldeeone/kaspa-x402](https://github.com/elldeeone/kaspa-x402)**.
- The protocol (402 offers, `PAYMENT-REQUIRED`/`PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE`, verification, replay/idempotency, quotas) comes from upstream `@kaspa-x402/server` `DirectModeServer` and `@kaspa-x402/client` `DirectModeClient`.
- This repo adds two pieces:
  1. A **seller reverse proxy**: YAML per-route pricing, a ledger, and a dashboard.
  2. A **budgeted agent wallet**: per-request max, per-day cap, host allowlist, and auto-pay of 402 responses.

> ⚠️ **MOCK CHAIN LAYER.** `src/mock-chain.mjs` stands in for the Kaspa node, the payer's hot wallet, and the seller's payment verifier. It is adapted from upstream `protocol/examples/lib/mock-direct-mode.mjs`, which uses the same approach for all upstream examples. No node, keys, faucet or funds are used. The seller's mock verifier **trusts any well-formed payload**, so it is not secure. The config refuses any network other than `kaspa:testnet-10`. The upstream server and client also fail closed on mainnet unless `allowMainnet` is set, and this repo never sets it.

## Layout
```
config/routes.yaml     per-route pricing (sompi), upstream URL, payTo, dashboard token
src/gateway.mjs        seller reverse proxy (DirectModeServer.handlePaidRequest -> upstream)
src/ledger.mjs         JSONL paid-request log + revenue summary
src/agent-wallet.mjs   AgentWallet (spend limits) + dev loopback transport
src/mock-chain.mjs     MOCK node/wallet/verifier adapters (replace for live TN10)
src/demo-upstream.mjs  demo API (weather, summarize, premium, health) with no payment code
src/demo-e2e.mjs       end-to-end demo
test/gateway.test.mjs  node:test suite
```

## Setup
Requires Node 20+.
```sh
./scripts/bootstrap.sh   # see Dependencies above
```

## Run
```sh
npm test            # 83 tests (82 pass, 1 live test skipped)
npm run demo        # upstream + gateway + agent in one process
# or run as separate services:
npm run upstream    # :8500
npm run gateway     # :8402 (reads config/routes.yaml, writes data/ledger.jsonl)
curl -i http://127.0.0.1:8402/weather/brisbane            # -> 402 + PAYMENT-REQUIRED
open "http://127.0.0.1:8402/_x402/dashboard?token=change-me-dev-token"
```

### Pricing config
```yaml
routes:
  - match: "GET /weather/*"   # METHOD + path, trailing * wildcard, first match wins
    priceSompi: "10000000"    # 0.1 KAS, decimal sompi string
  - match: "GET /health"
    free: true                # proxied without payment; unmatched paths return 404
```

### Agent wallet
```js
const w = new AgentWallet({ allowedOrigins: ["https://api.demo.test"], perRequestMaxSompi: "50000000",
  dailyCapSompi: "500000000", allowedPayTo: ["kaspatest:..."], fetch });
const { response } = await w.fetch("https://api.demo.test/weather/brisbane"); // auto-pays the 402
w.report(); // spend log + denials
```
Limits are enforced in two layers:
- Upstream `fundingPolicy`: origin allowlist, `maximumExactAmountSompi`, and the `allowedPayTo` list.
- Our `authorizeExactPayment` callback, which upstream binds to the exact intent digest: network pin, host allowlist, and the per-day cap (by UTC day).

A blocked payment throws `SpendLimitError` with one of these codes: `host`, `per_request`, `daily_cap`, or `network`.

### Why `https://api.demo.test` + "dev loopback"
Upstream `paidFetch` deliberately refuses `http`, `localhost`, and literal-IP destinations, and it requires a "bound" transport. For a local demo, `createDevLoopbackFetch` maps the public origin to a `127.0.0.1` target, and it only accepts loopback targets. **In production use upstream `createNodeBoundedFetch` from `@kaspa-x402/client/node`** and a real HTTPS hostname.

## Chain modes
| Mode | Seller verification / broadcast | Payer wallet |
|---|---|---|
| `mock` (default; `npm run demo`, `npm test`) | `src/mock-chain.mjs` (trusts payloads) | mock |
| `real` (`X402_CHAIN=real npm run gateway`, `npm run demo:live`) | **upstream `@kaspa-x402/adapters`**: `VerifiedExactTransactionVerifier`, `VerifiedExactSettlementReconciler`, `VerifiedKaspaChainProvider` over `KaspaRestClient` (`https://api-tn10.kaspa.org`, or `restUrl` in the YAML) | `RealTn10FundingProvider` (`src/live/real-adapters.mjs`): rusty-kaspa WASM SDK v2.0.0, builds and signs a standard-native exact tx (ported from upstream `scripts/live-adapter-reference.mjs`). The seller broadcasts it. |

Neither mode uses mainnet: config validation, `ScriptAddressBook("kaspa:testnet-10")`, the node `networkId` check, and no `allowMainnet` anywhere.

## Real Testnet-10 setup
```sh
# WASM SDK (nodejs build) is expected at ../vendor/kaspa-wasm32-sdk (override with KASPA_WASM_SDK)
npm run wallet:init     # creates .secrets/tn10-wallet.key (payer) + tn10-merchant.key, mode 0600, gitignored; prints addresses only
npm run wallet:status   # balances via public TN10 wRPC (Resolver) or TN10_WRPC_URL
# fund the payer address at https://faucet-tn10.kaspanet.io/ (Cloudflare challenge -> browser)
npm run demo:live       # one real paid request; txid -> data/live-run.json + explorer link
npm run test:live       # adds the LIVE network test (real 402 + unfunded payer fails closed)
```

## Remaining work
1. Durable stores instead of `Memory*Store` (upstream `docs/server-store-contract.md`), plus a persistent agent spend ledger and UTXO reservations.
2. `batch-settlement` (covenant escrow + vouchers) for sub-0.1-KAS pricing.
3. Pass upstream response headers through, check the request-body hash, set `trustedSecurityContext` on authenticated routes, and add a real dashboard login.
4. Use the PNN wRPC evidence path (`KaspaPnnClient` + corroboration) instead of the single REST authority.

## batch-settlement (covenant prepaid deposit) — mock (default) and real TN10
- **Network:** kaspa-x402 runs batch on **kaspa:testnet-10**. Toccata covenants (KIP-17/20) are live there, and upstream's funded proofs ran on TN10 (`protocol/docs/live-testnet-report.md`). TN12 is not used. The config refuses any `batch.network` other than TN10, and mainnet everywhere.
- **Route config:** `scheme: batch-settlement`. These routes can be priced below 0.1 KAS. Exact routes must be at least 0.1 KAS.
- **Gateway config:** a `batch:` block with `minDepositSompi`, `claimReserveSompi` and `refundTimeoutDeltaDaa`.
- **Flow (all upstream code; only the chain is mocked, `src/mock-batch*.mjs`):**
  1. The first call opens a KIP-20 escrow deposit.
  2. Each later call is an off-chain signed voucher.
  3. The seller calls `POST /_x402/claim?token=…` (upstream `executeClaim`) to claim on-chain.
  4. After the refund timeout, the payer calls `wallet.refundAll()` (upstream `refundChannel`) to get the remainder back.
- **Wallet limits:** `perRequestMaxSompi` caps each voucher, `batch.maxDepositSompi` caps the deposit/top-up, and `dailyCapSompi` counts voucher charges. `batch.allowedResources` and `allowedServerPublicKeys` are passed through to the upstream `fundingPolicy.batchPayment`.
- **Run:** `npm run demo:batch` (config example: `config/routes-batch.yaml`).
- **Live:** not wired. `chain: real` with a batch route throws. Upstream's real batch adapters exist only inside `protocol/scripts/live-adapter-reference.mjs`, which is not an exported package.

## Real batch mode (Testnet-10)

Real batch adapters are ported from kaspa-x402 `protocol/scripts/live-adapter-reference.mjs`
(MIT, commit 8d575de; vendored with LICENSE + attribution in `src/live/upstream-ref/`), exposed via
`createLiveKit()` and wrapped by `src/live/batch-kit.mjs` (`createLiveBatchKit({ rpc })`).
Pass the kit to both sides: `createGateway(cfg, { chain: "real", liveKit, refundTimeoutDaa })` and
`new AgentWallet({ ..., liveKit, batch: {...} })`. The kit binds both channel stores into upstream's
pre-broadcast durability checks. Mock mode stays the default, and tests never touch the network.

```bash
npm run wallet:status                       # payer needs ~2.1 TKAS for a 2 TKAS run
CALLS=12 PRICE=2000000 DEPOSIT=200000000 TIMEOUT_DELTA_DAA=3600 node src/live/demo-live-batch.mjs
```

The flow is: split an exact-size UTXO, then genesis deposit into the KIP-20 covenant, then N off-chain vouchers,
then `claimAll()` (or `POST /_x402/claim?token=`), and once the timeout DAA passes, `wallet.refundAll()`.
Outputs go to `data/live-batch-run.json`, `data/ledger-live-batch.jsonl` and `data/live-batch.log`.
Channel/server keys and batch artifacts live in gitignored `.secrets/live-batch/`.

- **Node:** pinned to a single wRPC node (`PINNED_TN10_WRPC` in `src/live/sdk.mjs`; override with
  `TN10_WRPC_URL`), so one run sees one selected-chain view. If that node fails, it falls back to the public Resolver.
- **Retries** (`src/retry.mjs`): chain-provider *read* methods (get*/discover*/list*…), `previewClaim` and
  `executeClaim` are retried with exponential backoff, but only for transient errors
  (e.g. "selected-chain rollback lacks a confirmed replacement", socket or timeouts). Broadcasts and signing are
  never retried by us. Upstream's "corrective 402 requires a new explicit payment authorization" is
  never auto-answered.
- **Limits:** the seller claim minimum is 0.1 TKAS, so you need at least 5 calls at 0.02 TKAS before claiming. Each on-chain step
  (genesis, claim, refund) costs about 0.02 TKAS in fees. The network is pinned to `kaspa:testnet-10`; anything else is refused.

## Durable mode, CLI and Docker

```bash
npm run hash-password <<< 'a long dashboard password'     # -> scrypt$16384$8$1$<salt>$<hash>
export X402_DASHBOARD_PASSWORD_HASH='scrypt$…'             # enables /_x402/login; legacy ?token= is then refused
node src/demo-upstream.mjs &                               # demo origin on :8500
node bin/x402-gateway.mjs serve --config config/routes-batch.yaml --db data/gateway.sqlite   # mock chain (default)
node bin/x402-gateway.mjs serve --config <batch.yaml> --chain real                         # TN10 (needs wallet + SDK)
node bin/x402-gateway.mjs check-config --config config/routes.yaml
```

- **SQLite** (`src/store.mjs`, better-sqlite3, WAL, `synchronous=FULL`): one file holds the seller ledger, server
  channel state, the wallet's channels and funding/refund attempts, its spend history and reservations, and dashboard sessions
  (stored as sha256 of the session id). Upstream's `Memory*Store` state machines are kept as they are. We subclass them and
  write a snapshot through to SQLite after every successful mutating call, then rehydrate them via their public constructors on start.
  *What survives a restart:* channels (with accrued vouchers, so the seller can still claim) and client funding/refund attempts.
  *What doesn't:* in-flight operation leases, idempotency/commitment caches, and exact-payment attempt records. A request interrupted
  by a crash fails closed. In `AgentWallet({ db })`, spends with status `authorized` are **reservations**. They keep counting toward the
  daily cap after a restart until you call `releaseReservation(id)`, which you should only do once you've confirmed on-chain that the spend never paid.
- **Periodic seller claims:** `settlement: { claimEveryCalls: 10, claimEveryMinutes: 15, minClaimSompi: "10000000" }`. Claims run
  in the background and never overlap. Channels below `minClaimSompi` are skipped (TN10 batch payout floor is 0.1 TKAS). Results show
  on the dashboard (`autoClaims`).
- **Dashboard login:** `GET/POST /_x402/login` and `POST /_x402/logout`. The password is stored as an scrypt hash taken from env. The session cookie is
  random 256-bit, `HttpOnly; SameSite=Strict; Secure; Path=/_x402` with a 12 h TTL. Failed logins are throttled per IP (5, then a 60 s lockout).
  `X402_INSECURE_COOKIE=1` drops `Secure` for plain-http localhost dev.
- **Upstream header pass-through:** origin response headers are forwarded, except hop-by-hop headers, content-length/-encoding,
  `set-cookie`, `www-authenticate`, `payment-*` and `x-x402-*`, so the origin can't spoof x402 headers. The optional
  `passHeaders: [..]` setting is an allowlist. On paid responses the x402 server's own headers win (e.g. `cache-control: private, no-store`).
- **Docker** (build from the parent dir so the `file:` deps on the upstream clone resolve):
  `docker build -f x402-gateway/Dockerfile -t x402-gateway:dev . && docker run -p 8402:8402 -v x402data:/data -e X402_DASHBOARD_PASSWORD_HASH x402-gateway:dev serve --config config/routes-batch.yaml --host 0.0.0.0`

## Node trust, depth and pending payments (Round 3)

**PNN trust (who verifies payments).** Default is **single source**: `pnnEndpoints` form ONE node client with endpoint
failover (whichever node answers is trusted). This is *not* agreement between nodes.

| Setting | Effect |
|---|---|
| (none) | single source over `pnnEndpoints` (default) |
| `pnnTrust: { mode: single, endpoints: [...] }` | explicit single source (e.g. your own node `ws://127.0.0.1:18210`: wRPC **JSON**, testnet port 18210; 17210 is Borsh) |
| `pnnTrust: { mode: quorum, authorities: [{ trustDomain, endpoints }], required: 2 }` | upstream corroboration: every responding authority must agree; **depth = minimum `confirmationCount` across authorities**, and at least `required` authorities must answer the depth re-check or the call fails closed; covenant lineage depth (batch) is wrapped the same way (`withMinDepth`) |
| env `X402_PNN_DEFAULT_QUORUM=1` | with no `pnnTrust`, use a 2-of-N quorum over `pnnEndpoints`, one authority per hostname |

**Running your own TN10 node.** kaspad serves wRPC only when asked: `kaspad --testnet --netsuffix=10 --utxoindex --rpclisten-json=default`
(loopback `ws://127.0.0.1:18210`) or `--rpclisten-json=0.0.0.0:18210` behind a TLS reverse proxy for a public `wss://` endpoint.
`--utxoindex` is required. The gateway accepts plain `ws://` only on loopback.

Caveat: the two default TN10 endpoints are both run by kaspa.blue, so a quorum over them is ONE operator in practice
(R3-M2, open). Mainnet needs your own node plus independent operators.

**`exactFinality`** (`accepted` default | `confirmed`). In `confirmed` mode the gateway first proves the node(s) can
serve depth evidence *before* the payment is broadcast: it re-proves a known deep tx at the required confirmations
(`depthProbeTxid`, or the latest exact payment it delivered more than 60 s ago). With no probe tx, or if the proof fails, it fails closed. If it can't, the payer gets `503 depth_verification_unavailable`
and nothing is broadcast. If the tx is broadcast but depth can't be proven within the in-request replays, the payment is
held as **pending** (SQLite `kv` ns `exact-pending`, shown on the dashboard as `pendingExact`) and the payer gets
`503 payment_pending` with the txid. Retrying the **same** payment delivers the data; it is never charged twice.
Pending payments expire after `exactPendingTtlMs` into a refund-due queue (SQLite ns `exact-refund-due`,
dashboard `refundsDue`, ledger `pending-expired`); retries then get `410 payment_expired_refund_due`. Refunds are
operator-approved: send it from your TN10 wallet, then record it with `x402-gateway refunds --txid <paid tx> --refund-tx <refund tx>`
(`x402-gateway refunds` lists the queue). `exactPendingTtlMs` defaults to, and may not exceed, the payer's
authorization lifetime (`maxTimeoutSeconds`, default 60 s); startup refuses a larger value, because a payment past its
authorization can never be re-presented.

**`batch.openChargeSompi`.** The call that opens a batch channel is charged at least this amount (real-chain default:
`settlement.minClaimNetSompi` + claim fee), so every channel is claimable from its first call. It must be >= `minClaimNetSompi` + claim fee (startup refuses less).
The 402 challenge, the paid price and the per-IP cap use ONE rule: a channel is "below minimum" until its cumulative
charge reaches the threshold recorded when its open charge was paid (a later fee/minimum change never re-charges it).
Later calls on the channel pay the route price. Without a payment, the 402 offer is decided per client IP unless the client
names its own channel with the optional `kasgate-channel-id: <64 hex>` header; a channel that is active and was opened from
the same client IP key is then priced by the same per-channel rule (an unknown or foreign id falls back to the IP rule).
**Journal replay** restores payment state on start. If any journal row fails to replay, the gateway fails closed: paid
routes answer `503 gateway_state_unavailable` and state transitions are refused until you reconcile and restart with
`X402_ACK_REPLAY_ERRORS=1` (errors are shown on the dashboard as `replayErrors`). Every replay failure, acknowledged or
not, is logged as `[x402-store] ALERT`, booked in the ledger as `store-replay-alert`, and passed to the optional
`onReplayError` hook of `createGateway` (wire it to your pager).

## Hardening

The internal review notes are not published. The operator-visible changes:
- **Dashboard auth:** use `X402_DASHBOARD_PASSWORD_HASH` (required for `--chain real`), or for mock/dev `X402_DASHBOARD_TOKEN` sent as `Authorization: Bearer …`. `?token=` and the old default token are refused.
- **Batch config:** `batch.claimMarginDaa`, `batch.rotateEveryDaa`, `batch.acceptedFinality` (real default `confirmed`) and `batch.allowShortRefundTimeout` (needed when the delta is under 36,000 DAA on a real chain).
- **Settlement config:** `settlement.minClaimNetSompi` (real default 0.11 TKAS, a storage-mass guard).
- **Wallet caps:** `dailyCapSompi` counts exact payments + deposits/top-ups; `dailyVoucherCapSompi` caps voucher charges. Reservations with unknown outcome keep counting toward the cap. `releaseReservation(id, { lookupTx })` marks a tx that is absent on-chain as `absent-unspent`, which **still counts** until its inputs are proven spent elsewhere.
- **Request handling:** `maxBodyBytes` (default 1 MiB) and `passRequestHeaders`.
- **Crash recovery:** `node src/live/recover-live-batch.mjs [--refund]` restarts a live batch run from `data/live-batch.sqlite`.

## Known limitations

- **Mainnet: NO-GO.** Mainnet needs independent Kaspa node operators (our own node plus others) so payment verification doesn't depend on one public API. The protocol's upstream code also needs an independent audit.
- **Depth-gated (confirmation) mode is off by default.** The x402 payment authorization expires after about 60 s, which is before public TN10 nodes can prove the required confirmation depth. Retries return `payment_pending` and never charge twice, but they don't deliver data reliably. `config/routes-weather-confirmed.yaml` is experimental.
- **Single node and quorum.** By default verification trusts one REST/wRPC endpoint. Quorum mode (`X402_PNN_DEFAULT_QUORUM`) takes the minimum depth across nodes, but the nodes are only as independent as their operators. Exact settlement at depth 0 relies on that node.
- **Per-IP cap (low severity).** Sub-minimum batch channels are capped per client IP. Rotating IPs, NAT or proxies can get around it, or cause false limits. Run it behind a trusted proxy setup.
- **Batch upfront charge** (narrows the free-below-claim-minimum gap) has been **tested on the mock chain only** and not yet in a live TN10 run. Any call on a channel whose recorded charge is still below the claim minimum (e.g. after a failed open) pays the open charge again, priced from server state. After a claim, new unclaimed value on a channel below the claim minimum is **accepted** (not counted by the per-IP cap) and is booked as `accepted-loss` if it is still unclaimable at the refund window: at most minimum + claim fee − route price per channel per claim cycle, borne by the seller. The per-IP open counter (`pendingOpens`) is per process, IPv4-mapped/NAT64 addresses can collide in `ipKey`, and `batch-open-ip` rows are never pruned (O(n) scan per open).
- **Stuck-claim recovery is retry-only** (no reconcile/abandon). A channel can stay frozen until the payer refunds.
- **Batch fees are a flat 0.02 KAS** for open/claim/refund, not mass × feerate.
- **Batch handler durability/idempotency after a crash is not proven.**
- **The journal is never compacted**, so replay on restart grows without bound.
- **TN10 storage-mass standard limit is unverified** (500k default assumed).
- **Config is hard-locked to TN10.** Mainnet would need code changes plus a fresh audit, not just new nodes.
- **Verify-then-double-spend window:** a payer can try to double-spend while the origin is being fetched.
- **Depth-gated preflight, pending expiry, quorum fail-closed and the lineage wrapper are unit-tested only** (mock chain), never run live. A depth proof of an older tx does not guarantee the new tx will verify at depth; a held payment may still expire into the refund queue.
- **One dissenting (or silent) authority halts settlement** in quorum mode, and **transactions are submitted to a single node**.
- **Exact payments are served at depth 0** (`accepted`): a reorg after delivery is not handled, and the merchant bears that loss.
- **Keys are unencrypted at rest.** No KMS or HSM: wallet and channel keys are plaintext 0600 files under `.secrets/` (0700), and upstream batch-recovery snapshots (`persistBatchRecoveryRecord`) write the live channel private key in plaintext JSON. Anyone who can read that disk can spend those funds. Must move to an encrypted keystore before any mainnet use.
- The `Dockerfile` has never been built or tested.

See `SECURITY.md` to report issues.

## License

MIT. See `LICENSE`. `src/live/upstream-ref/` contains code ported from kaspa-x402 under its own license (`src/live/upstream-ref/LICENSE`).
