/** Read-only live readiness checks by default. --inference spends session credits for two small requests. */
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, http, parseEventLogs, type Hex } from 'viem';
import { hederaTestnet } from 'viem/chains';
import { ChatCompletionResponse, LedgerEventsResponse, MeResponse, ModelsResponse, NetworkResponse, PayoutsResponse, PoolStateResponse, Receipt, REQUEST_ID_HEADER, Usage } from '@gpupool/shared';
import { loadNetworkConfig } from '../src/config.ts';
import { PAYOUT_ABI } from '../src/payout-chain.ts';
import { verifyPayoutProof } from '../src/merkle.ts';
import { validLayerMap } from '../src/route.ts';
import { signerFromSeed, verifyEvent } from '../src/events.ts';

const { values } = parseArgs({ options: {
  help: { type: 'boolean', default: false },
  gateway: { type: 'string' }, model: { type: 'string', default: 'Qwen/Qwen3-14B-FP8' },
  inference: { type: 'boolean', default: false }, provider: { type: 'string' },
  report: { type: 'string', default: '/tmp/gpupool-live-check.json' },
} });
if (values.help) {
  console.log(`MVP backend verification
  pnpm --filter @gpupool/gateway verify [--gateway URL] [--report PATH]
  --inference: two small session requests; requires VERIFY_SESSION_TOKEN and spends credits
  --provider ADDRESS: read-only verification of an existing testnet provider claim
Default: read-only readiness checks; never sends x402 payments or provider claims.
Local full-flow fixtures: pnpm --filter @gpupool/gateway test:demo`);
  process.exit(0);
}
const env = process.env;
const base = values.gateway ?? env.GATEWAY_URL ?? env.PUBLIC_URL ?? 'http://127.0.0.1:8080';
const model = loadNetworkConfig().models.find((m) => m.model_id === values.model);
if (!model) throw new Error('requested model is not in the MVP config');
const checks: { check: string; status: 'passed' | 'failed' | 'skipped'; detail: string }[] = [];
const skip = (check: string, detail: string) => checks.push({ check, status: 'skipped', detail });
async function check(name: string, fn: () => Promise<string>) {
  try { checks.push({ check: name, status: 'passed', detail: await fn() }); }
  catch (e) { checks.push({ check: name, status: 'failed', detail: (e as Error).message }); }
}
async function json(path: string, auth = false) {
  const response = await fetch(new URL(path, base), { headers: auth ? { authorization: `Bearer ${env.VERIFY_SESSION_TOKEN}` } : {}, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
let ready = false;
let paymentsObserved = false;
let liveClaimVerified = false;
await check('gateway_health', async () => {
  if (!(await json('/healthz')).ok) throw new Error('gateway did not report healthy');
  return 'gateway responded';
});
await check('arkiv_model_discovery', async () => {
  const models = ModelsResponse.parse(await json('/v1/models'));
  if (!models.data.some((m) => m.id === model.model_id && m.pools > 0 && m.source === 'arkiv')) throw new Error('requested model has no eligible Arkiv pool');
  return 'requested model has an eligible Arkiv pool';
});
await check('three_node_route', async () => {
  const network = NetworkResponse.parse(await json('/network'));
  for (const p of network.pools.filter((p) => p.status === 'ready' && p.models.includes(model.model_id))) {
    const state = PoolStateResponse.parse(await json(`/pools/${encodeURIComponent(p.pool_id)}`));
    const route = state.layer_map && validLayerMap(state.layer_map, model.num_layers);
    if (state.status === 'ready' && state.members.length === 3 && route && new Set(route.map((h) => h.node_id)).size === 3) {
      ready = true;
      return `three fresh signed members cover ${model.num_layers} layers in ${p.pool_id}`;
    }
  }
  throw new Error('no ready three-node pool with complete heartbeat layer coverage');
});
await check('ledger_and_hcs', async () => {
  const result = LedgerEventsResponse.parse(await json('/ledger/events?limit=100'));
  const anchored = result.events.filter((e) => e.hcs_seq !== null);
  if (!anchored.length) throw new Error('no HCS-confirmed ledger events observed');
  paymentsObserved = anchored.some((e) => e.event.type === 'x402_payment');
  if (env.GATEWAY_SIGNING_KEY) {
    const key = signerFromSeed(env.GATEWAY_SIGNING_KEY).publicKeyHex;
    if (anchored.some((e) => !verifyEvent(e.event, key))) throw new Error('ledger event signature failed');
  }
  return `${anchored.length} HCS-confirmed event references; x402 observed: ${paymentsObserved}`;
});

const costs: number[] = [];
if (values.inference && ready && env.VERIFY_SESSION_TOKEN) {
  let before: MeResponse;
  await check('session_balance', async () => { before = MeResponse.parse(await json('/me', true)); return 'session account readable'; });
  if (checks.at(-1)!.status === 'passed') {
    for (const stream of [false, true]) await check(stream ? 'streaming_usage_and_receipt' : 'nonstreaming_usage_and_receipt', async () => {
      const response = await fetch(new URL('/v1/chat/completions', base), {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.VERIFY_SESSION_TOKEN}` },
        body: JSON.stringify({ model: model.model_id, messages: [{ role: 'user', content: 'Say hello in one sentence.' }], max_tokens: 32, stream }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) throw new Error(`inference returned HTTP ${response.status}`);
      if (stream) {
        const body = await response.text();
        const usage = body.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => {
          try { return JSON.parse(line.slice(5).trim()); } catch { return null; }
        }).find((chunk) => Usage.safeParse(chunk?.usage).success)?.usage;
        if (!usage) throw new Error('stream did not include token usage');
      } else ChatCompletionResponse.parse(await response.json());
      const id = response.headers.get(REQUEST_ID_HEADER);
      if (!id) throw new Error('missing request ID');
      let receipt = Receipt.parse(await json(`/requests/${id}`));
      if (receipt.status !== 'ok' || !receipt.route || new Set(receipt.route.map((h) => h.node_id)).size !== 3 || !receipt.cost_mc) throw new Error('request did not settle against all three nodes');
      costs.push(receipt.cost_mc);
      const until = Date.now() + 30_000;
      while (receipt.hcs_seq === null && Date.now() < until) { await delay(500); receipt = Receipt.parse(await json(`/requests/${id}`)); }
      if (receipt.hcs_seq === null) throw new Error('receipt did not receive an HCS sequence within 30 seconds');
      return `${id}: ${receipt.cost_mc} mc, three-node route, HCS #${receipt.hcs_seq}`;
    });
    await check('credit_settlement', async () => {
      const after = MeResponse.parse(await json('/me', true));
      if (after.balance.held_mc !== 0 || after.balance.spent_total_mc - before!.balance.spent_total_mc !== costs.reduce((a, b) => a + b, 0)) throw new Error('spent total/hold does not match measured receipts (run with an idle requester account)');
      return 'holds released; spent total equals receipt costs';
    });
  }
} else {
  skip('inference', '--inference, VERIFY_SESSION_TOKEN, and a ready three-node pool are required; no inference was sent');
}

if (values.provider && env.HEDERA_JSON_RPC_URL && env.PAYOUT_CONTRACT_ADDRESS) {
  await check('provider_claim_on_testnet', async () => {
    const result = PayoutsResponse.parse(await json(`/payouts/${values.provider!.toLowerCase()}`));
    const pub = createPublicClient({ chain: hederaTestnet, transport: http(env.HEDERA_JSON_RPC_URL!) });
    if (await pub.getChainId() !== 296) throw new Error('claim check requires Hedera testnet');
    const p = result.payouts.find((p) => p.claimed && p.claim_tx);
    if (!p) throw new Error('no confirmed provider claim observed');
    const address = result.payout_address as Hex;
    if (!verifyPayoutProof(address, BigInt(p.amount_tinybar), p.proof as Hex[], p.merkle_root as Hex)) throw new Error('provider Merkle proof is invalid');
    const claimed = await pub.readContract({ address: env.PAYOUT_CONTRACT_ADDRESS! as Hex, abi: PAYOUT_ABI, functionName: 'hasClaimed', args: [BigInt(p.epoch), address] });
    const state = await pub.readContract({ address: env.PAYOUT_CONTRACT_ADDRESS! as Hex, abi: PAYOUT_ABI, functionName: 'epochs', args: [BigInt(p.epoch)] });
    if (!claimed || state[0] !== p.merkle_root) throw new Error('contract claim/root does not match payout API');
    const receipt = await pub.getTransactionReceipt({ hash: p.claim_tx! as Hex });
    const events = parseEventLogs({ abi: PAYOUT_ABI, eventName: 'Claimed', logs: receipt.logs, strict: true });
    if (receipt.status !== 'success' || !events.some((event) => event.address.toLowerCase() === env.PAYOUT_CONTRACT_ADDRESS!.toLowerCase()
      && event.args.epoch === BigInt(p.epoch) && event.args.account.toLowerCase() === address && event.args.amount === BigInt(p.amount_tinybar))) throw new Error('claim transaction receipt does not match provider/epoch/amount');
    liveClaimVerified = true;
    return `epoch ${p.epoch}; https://hashscan.io/testnet/transaction/${p.claim_tx}`;
  });
} else skip('provider_claim', '--provider plus testnet RPC/contract config is required; no claim transaction was sent');

const failed = checks.some((c) => c.status === 'failed');
const liveInferenceVerified = ['streaming_usage_and_receipt', 'nonstreaming_usage_and_receipt', 'credit_settlement'].every((name) => checks.some((c) => c.check === name && c.status === 'passed'));
const incomplete = (values.inference && !liveInferenceVerified) || (!!values.provider && !liveClaimVerified);
const result = { checked_at: new Date().toISOString(), mode: values.inference ? 'live_inference' : 'read_only_preflight',
  status: failed ? 'not_ready' : incomplete ? 'incomplete' : 'passed', live_inference_verified: liveInferenceVerified,
  live_x402_observed: paymentsObserved, live_claim_verified: liveClaimVerified, checks };
writeFileSync(values.report!, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (failed || incomplete) process.exitCode = 1;
