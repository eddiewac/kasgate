// MOCK batch-settlement world (shared by gateway + agent wallet in one process).
// The batch server/client config blocks below are adapted from upstream
// protocol/examples/lib/mock-direct-mode.mjs (copied in mock-batch-upstream.mjs, MIT).
// Protocol logic (escrow script, covenant ids, vouchers, claims, refunds) is upstream code;
// only the "chain" is fake. No node, keys, or funds.
import { sha256Hex } from "@kaspa-x402/core";
import { escrowScriptPublicKey, serializedScriptPublicKey } from "@kaspa-x402/covenant";
import { MockAddressCodec, MockChainProvider, MockFundingProvider, MockSigner, SERVER_PUBLIC_KEY,
  acceptedChainEvidence, mockHash, mockSignature, mockTransaction } from "./mock-batch-upstream.mjs";

/** Mock chain whose virtual DAA score can be advanced (to reach refund timeouts). */
class AdvancingChain extends MockChainProvider {
  daa = 100n;
  async getVirtualDaaScore() { return this.daa.toString(); }
  advance(n) { this.daa += BigInt(n); }
}
class AdvancingFunding extends MockFundingProvider {
  async getVirtualDaaScore() { return this.chainProvider.daa.toString(); }
}

export function createMockBatchWorld() {
  const chainProvider = new AdvancingChain();
  const fundingProvider = new AdvancingFunding(chainProvider);
  const addressCodec = new MockAddressCodec();
  return { chainProvider, fundingProvider, addressCodec, serverPublicKey: SERVER_PUBLIC_KEY,
    serverBatch: (b) => serverBatchConfig({ chainProvider, addressCodec, ...b }),
    clientBatch: () => clientBatchConfig({ chainProvider, fundingProvider, addressCodec }) };
}

function serverBatchConfig({ chainProvider, addressCodec, minDepositSompi, claimReserveSompi, refundTimeoutDaa }) {
  return {
    serverPublicKey: SERVER_PUBLIC_KEY, minDepositSompi, claimReserveSompi, refundTimeoutDaa, minimumRefundLeadDaa: "0",
    voucherVerifier: { verifyVoucher: ({ digest, voucher }) => voucher.signature === mockSignature(digest) },
    batchPresentationVerifier: { verifyPresentation: ({ digest, signature }) => signature === mockSignature(digest) },
    topUpVerifier: { verifyTopUp: ({ previous, next }) => chainProvider.verifyCovenantTopUp({ previous, next }) },
    claimBuilder: { async buildClaimTransaction({ channel, claimAmount }) {
      const claimedCumulativeAmount = (BigInt(channel.claimedCumulativeAmount) + BigInt(claimAmount)).toString();
      const payout = addressCodec.scriptPublicKeyForAddress(channel.channelConfig.payTo, channel.channelConfig.network);
      const refund = addressCodec.scriptPublicKeyForAddress(channel.channelConfig.refundAddress, channel.channelConfig.network);
      const continuationScriptPublicKey = serializedScriptPublicKey(escrowScriptPublicKey({
        clientPublicKey: channel.channelConfig.clientPublicKey, serverPublicKey: channel.channelConfig.serverPublicKey,
        network: channel.channelConfig.network, payoutScriptPublicKeyHash: sha256Hex(Buffer.from(payout, "hex")),
        refundScriptPublicKeyHash: sha256Hex(Buffer.from(refund, "hex")), timeoutDaa: channel.channelConfig.refundTimeoutDaa,
        claimedCumulativeAmount }));
      const transaction = mockHash(`claim:${channel.covenantId}:${claimedCumulativeAmount}`);
      const continuationOutpoint = { txid: transaction, index: 1 };
      const continuationFundingAmount = (BigInt(channel.fundingAmount) - BigInt(claimAmount)).toString();
      chainProvider.prepareTransaction(transaction, () => {
        chainProvider.deleteUtxo(channel.activeOutpoint);
        const acceptance = acceptedChainEvidence(transaction);
        chainProvider.setUtxo({ outpoint: continuationOutpoint, covenantId: channel.covenantId, amount: continuationFundingAmount,
          scriptPublicKey: continuationScriptPublicKey, acceptance, finality: "accepted" });
        chainProvider.recordTransition({ kind: "claim", covenantId: channel.covenantId, templateId: channel.channelConfig.templateId,
          consumedOutpoint: channel.activeOutpoint, transactionId: transaction, authorizedSuccessorCount: 1,
          successor: { outpoint: continuationOutpoint, covenantId: channel.covenantId, authorizingInput: 0,
            scriptPublicKey: continuationScriptPublicKey, value: continuationFundingAmount, claimedCumulativeAmount },
          terminalOutput: null, acceptance });
      });
      return { transaction, transactionId: transaction, claimAmount, continuationOutpoint, continuationScriptPublicKey, continuationFundingAmount };
    } },
  };
}

function clientBatchConfig({ chainProvider, fundingProvider, addressCodec }) {
  return {
    signer: new MockSigner(),
    refundBuilder: { async buildRefundTransaction({ channel, refundAmount, signDigest }) {
      await signDigest(mockHash(`refund-digest:${refundAmount}`));
      const transaction = mockTransaction(`refund:${channel.covenantId}:${refundAmount}`);
      const transactionId = mockHash(`broadcast:${transaction}`);
      const refundScriptPublicKey = addressCodec.scriptPublicKeyForAddress(channel.config.refundAddress, channel.config.network);
      chainProvider.prepareTransaction(transaction, () => {
        chainProvider.deleteUtxo(channel.activeOutpoint);
        fundingProvider.removeAddressUtxo(channel.escrowAddress, channel.activeOutpoint);
        chainProvider.recordTransition({ kind: "refund", covenantId: channel.covenantId, templateId: channel.templateId,
          consumedOutpoint: channel.activeOutpoint, transactionId, authorizedSuccessorCount: 0, successor: null,
          terminalOutput: { index: 0, scriptPublicKey: refundScriptPublicKey, value: refundAmount }, acceptance: acceptedChainEvidence(transactionId) });
      });
      return { transaction, transactionId, refundAmount };
    } },
  };
}
