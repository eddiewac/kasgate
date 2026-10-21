// MOCK CHAIN LAYER — no Kaspa node, no keys, no funds.
// Adapted from elldeeone/kaspa-x402 protocol/examples/lib/mock-direct-mode.mjs (MIT),
// exact (standard-native) path only. Replace these adapters with the upstream
// @kaspa-x402/adapters (kaspa-native / PNN node websocket) + a TN10 wallet for live use.
import { exactRequestAuthorizationDigest, exactRequestAuthorizationId, sha256Hex,
  TESTNET_10_CONFIRMATION_THRESHOLD } from "@kaspa-x402/core";

export const MOCK = true;
export const MOCK_PAYER_ADDRESS = "kaspatest:mock-agent-wallet";
export const MOCK_PAYER_PUBKEY = "22".repeat(32);

export const mockHash = (s) => sha256Hex(`kaspa-x402-example:${s}`);
export const mockTransaction = (s) => `${mockHash(s)}${mockHash(`${s}:body`)}`;
export const mockSignature = (d) => `${d}${d}`;

export class MockAddressCodec {
  scriptPublicKeyForAddress(address, network) { return `0000${sha256Hex(`${network}:${address}`)}`; }
  encodeScriptAddress(input) { return `kaspatest:x402${sha256Hex(JSON.stringify(input)).slice(0, 24)}`; }
}

export function acceptedChainEvidence(transactionId) {
  const cp = 1000n;
  return { status: "accepted", transactionId: transactionId.toLowerCase(),
    acceptingBlockHash: mockHash(`accepting-block:${transactionId}`),
    acceptingBlockBlueScore: (cp - BigInt(TESTNET_10_CONFIRMATION_THRESHOLD) + 1n).toString(),
    confirmationCount: TESTNET_10_CONFIRMATION_THRESHOLD,
    checkpoint: { blockHash: mockHash("selected-chain-checkpoint"), blueScore: cp.toString(), daaScore: "1000" } };
}

/** Seller side: "chain" that accepts any broadcast. */
export class MockChainProvider {
  async sendTransaction(tx) {
    const transactionId = tx.length === 64 ? tx : mockHash(`chain-broadcast:${tx}`);
    return { transactionId, evidence: acceptedChainEvidence(transactionId), finality: "accepted" };
  }
  async getVirtualDaaScore() { return "100"; }
}

/** Seller side: MOCK verifier. Trusts the payload's tx; a real one checks outputs+finality on TN10. */
export const mockExactTransactionVerifier = {
  verifyExactPayment(req) {
    return { transactionId: mockHash(`chain-broadcast:${req.transaction}`),
      paymentOutput: { amount: req.amount, scriptPublicKey: req.payToScriptPublicKey },
      payerAddress: MOCK_PAYER_ADDRESS, finality: "accepted",
      requestAuthorization: { authorizationId: exactRequestAuthorizationId(req.authorization),
        digest: req.authorization.digest, inputIndex: req.authorization.inputIndex, publicKey: MOCK_PAYER_PUBKEY } };
  },
};

/** Agent side: MOCK hot wallet. Produces signed-looking exact payloads without real UTXOs. */
export class MockFundingProvider {
  networkId = "kaspa:testnet-10";
  sourceKind = "hot-wallet";
  attempts = new Map();
  async getPublicIdentity() { return { address: MOCK_PAYER_ADDRESS, publicKey: MOCK_PAYER_PUBKEY }; }
  async payExactTransaction(r) {
    const key = r.attemptId.toLowerCase();
    const prev = this.attempts.get(key);
    if (prev) { if (prev.intentHash !== r.intentHash.toLowerCase()) throw new Error("intent changed"); return structuredClone(prev.result); }
    const id = `${r.profile}:${r.payTo}:${r.amount}:${r.requestHash ?? "unbound"}:${r.paymentIdentifier}`;
    const transaction = mockTransaction(`exact-transaction:${id}`);
    const transactionId = mockHash(`chain-broadcast:${transaction}`);
    const paymentOutputIndex = r.paymentOutputIndex ?? 0;
    const digest = exactRequestAuthorizationDigest({ network: r.network, profile: r.profile, transactionId,
      paymentOutputIndex, amount: r.amount, payTo: r.payTo, payToScriptPublicKey: r.payToScriptPublicKey,
      paymentRequirementsHash: r.paymentRequirementsHash, requestHash: r.requestHash,
      paymentIdentifier: r.paymentIdentifier, challengeId: undefined, inputIndex: 0, expiresAt: r.authorizationExpiresAt });
    const result = { transaction, transactionEncoding: "kaspa-sdk-safe-json-v2.0.0", transactionId, paymentOutputIndex,
      authorization: { version: "kaspa-x402-exact-request-authorization-v2", inputIndex: 0,
        expiresAt: r.authorizationExpiresAt, digest, signature: mockSignature(digest) },
      inputOutpoints: [{ txid: mockHash(`exact-funding:${r.attemptId}`), index: 0 }],
      payerAddress: MOCK_PAYER_ADDRESS, fundingSource: this.sourceKind };
    this.attempts.set(key, { intentHash: r.intentHash.toLowerCase(), result: structuredClone(result) });
    return result;
  }
  async finalizeExactPaymentAttempt() {}
  async sendTransaction(tx) { return new MockChainProvider().sendTransaction(tx); }
}
