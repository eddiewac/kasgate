// MOCK batch-settlement demo: deposit open -> cheap calls -> seller claim -> refund after timeout.
import { createUpstream } from "./demo-upstream.mjs";
import { createGateway } from "./gateway.mjs";
import { validateConfig } from "./config.mjs";
import { AgentWallet, createDevLoopbackFetch } from "./agent-wallet.mjs";
import { createMockBatchWorld } from "./mock-batch.mjs";
const O = "https://api.demo.test";
const up = createUpstream().listen(0, "127.0.0.1"); await new Promise((r) => up.once("listening", r));
const cfg = validateConfig({ network: "kaspa:testnet-10", publicOrigin: O, payTo: "kaspatest:payout", upstream: `http://127.0.0.1:${up.address().port}`, listen: {},
  dashboard: { path: "/d", token: "t" }, batch: { minDepositSompi: "4000000", claimReserveSompi: "2000000", refundTimeoutDeltaDaa: "900" },
  routes: [{ match: "GET /weather/*", scheme: "batch-settlement", priceSompi: "50000" }] });
const world = createMockBatchWorld();
const gw = createGateway(cfg, { mockWorld: world }); const gs = await gw.listen(0, "127.0.0.1");
const w = new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "100000", dailyCapSompi: "1000000", allowedPayTo: ["kaspatest:payout"],
  fetch: createDevLoopbackFetch({ [O]: `http://127.0.0.1:${gs.address().port}` }), mockWorld: world,
  batch: { maxDepositSompi: "4000000", allowedResources: [`${O}/weather/brisbane`], allowedServerPublicKeys: [world.serverPublicKey] } });
for (let i = 0; i < 20; i++) { try { const r = await w.fetch(`${O}/weather/brisbane`); console.log(r.response.status, r.payment?.scheme, r.payment?.openedChannel, r.settlement?.chargedAmount); } catch (e) { console.log("ERR", e.code, e.message); } }
console.log(JSON.stringify(gw.ledger.summary()).slice(0, 400));
console.log(JSON.stringify(await gw.claimAll()));
world.chainProvider.advance(2000);
try { console.log(JSON.stringify(await w.refundAll())); } catch (e) { console.log("refund ERR", e.message); }
gs.close(); up.close();
