// Loads the rusty-kaspa WASM SDK (nodejs build). Testnet-10 only.
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
export const SDK_PATH = process.env.KASPA_WASM_SDK ?? path.resolve(new URL("../../../vendor/kaspa-wasm32-sdk/nodejs/kaspa", import.meta.url).pathname);
globalThis.WebSocket ??= require("websocket").w3cwebsocket;
export const sdk = require(SDK_PATH);
export const NETWORK_ID = "testnet-10";
// Pinned single node (stable selected-chain view across a run); public Resolver is the fallback.
export const PINNED_TN10_WRPC = "wss://muon-10.kaspa.blue/kaspa/testnet-10/wrpc/borsh";
async function tryConnect(cfg) {
  const rpc = new sdk.RpcClient({ networkId: NETWORK_ID, encoding: sdk.Encoding.Borsh, ...cfg });
  await rpc.connect({ timeoutDuration: 15000, retries: 2 });
  const info = await rpc.getServerInfo();
  if (String(info.networkId) !== NETWORK_ID) { await rpc.disconnect(); throw new Error(`node is ${info.networkId}, refusing (testnet-10 only)`); }
  if (!info.isSynced) { await rpc.disconnect(); throw new Error("node not synced"); }
  return { rpc, info };
}
export async function connectTn10(url = process.env.TN10_WRPC_URL ?? PINNED_TN10_WRPC) {
  if (url) try { return { ...(await tryConnect({ url })), via: "pinned" }; } catch (e) { console.error(`[tn10] pinned ${url} failed (${e.message}); falling back to resolver`); }
  return { ...(await tryConnect({ resolver: new sdk.Resolver() })), via: "resolver" };
}
