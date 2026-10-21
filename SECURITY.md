# Security

KasGate is a **testnet-only prototype**. It went through three rounds of internal security and protocol review (no independent third-party audit). Those reviews fixed: payment verification before the origin is called, node-side tx verification, confirmation-depth checks, keys kept out of SQLite (0600 key files), retries only for read methods, a hold-and-retry `payment_pending` flow so a broadcast payment is never lost, per-IP channel caps (including responses without `PAYMENT-RESPONSE`), a batch upfront charge, and min-depth quorum across nodes.

Open issues are listed under **Known limitations** in the README. **Mainnet use is not supported.**

Report vulnerabilities privately through GitHub Security Advisories on this repository rather than in a public issue.
