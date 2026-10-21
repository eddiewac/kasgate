# Security

KasGate is a **testnet-only prototype**. It went through five rounds of internal security and protocol review (no independent third-party audit). Active by default: payment verification before the origin is called, node-side tx verification (against a single public node operator), keys kept out of SQLite (0600 key files), retries only for read methods, per-IP channel caps (including responses without `PAYMENT-RESPONSE`), and a batch upfront charge (priced from server-side channel state; tested on the mock chain only). Opt-in or limited: confirmation-depth checks are **off by default** (exact payments are accepted at depth 0); the hold-and-retry `payment_pending` flow avoids double charges, but on live TN10 held payments were not delivered and 5 TKAS paid-without-data across testing had to be refunded by hand; the min-depth quorum is **opt-in, unit-tested only and never run live**, and the default TN10 nodes are run by one operator, so it adds no real independence.

Round 5 additions (mock chain / unit tests only, never run live): the 402 offer and the charged price use one server-side rule; quorum depth fails closed unless `required` authorities answer, including batch lineage depth; depth-gated mode proves depth on a known deep tx before broadcast; held payments expire into an operator-approved refund queue; journal replay errors make the gateway fail closed.

**Keys at rest are not encrypted.** Wallet and channel keys are plaintext files (mode 0600, in a 0700 `.secrets/` directory), and upstream batch-recovery JSON snapshots also hold the channel private key in plaintext. Exact payments are accepted at depth 0 by default.

Open issues are listed under **Known limitations** in the README. **Mainnet use is not supported.**

Report vulnerabilities privately through GitHub's private vulnerability reporting: https://github.com/eddiewac/kasgate/security/advisories/new (Security tab → "Report a vulnerability"). Please don't open a public issue for security problems.
