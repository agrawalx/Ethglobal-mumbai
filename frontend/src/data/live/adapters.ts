/** Validated wire records → UI presentation units. No synthetic service records. */
import { MeResponse, Receipt as ReceiptSchema, NetworkResponse, LedgerEventsResponse, PayoutsResponse, RpSignatureResponse } from '@gpupool/shared';
import type { NetworkSnapshot, WorldRpContext } from '../api';
import type { Me, Receipt } from '@shared/types';
import type { Epoch, LedgerEvent, NodeListing, Payout } from '@shared/types';
export function meFromWire(raw: unknown): Me {
 const r = MeResponse.parse(raw), b = r.balance;
 return { account_id: r.account_id, payout_address: r.payout_address as Me['payout_address'], ratio: r.ratio,
 balance: { starter: b.starter_mc/1000, starter_expires_at: b.starter_expires_at ?? 0, earned: b.earned_mc/1000, held: b.held_mc/1000, earned_total: b.earned_total_mc/1000, spent_total: b.spent_total_mc/1000 },
 incentives: r.incentives,
 nodes: r.nodes.map(n => ({...n, owner_account:r.account_id, status:n.online?'online':'offline', layers:null, tok_s:0, expires_at:0})) };
}
export function receiptFromWire(raw: unknown): Receipt {
 const r=ReceiptSchema.parse(raw);
 return {...r, status:r.status, in_tokens:r.in_tokens ?? 0, out_tokens:r.out_tokens ?? 0, cost:(r.cost_mc ?? 0)/1000,
 x402_amount:r.x402_amount_tinybar, route:r.route ?? [], resp_hash:r.resp_hash ?? '',
 split:r.split ? {burn:r.split.burn_mc/1000, reserve:r.split.reserve_mc/1000,
 nodes:Object.entries(r.split.nodes).map(([node_id,mc])=>({node_id,credits:mc/1000,layers:r.route?.find(n=>n.node_id===node_id)?.layers.reduce((a,b)=>b-a) ?? 0,self:false}))}:null};
}
export function networkFromWire(raw: unknown): NetworkSnapshot {
 const r=NetworkResponse.parse(raw);
 return {pools:r.pools.map(p=>({...p,status:p.status==='loading'?'forming':p.status,layer_map:p.layer_map ?? [],expires_at:0})),
 nodes:r.nodes.map(n=>({...n,tok_s:n.tok_s ?? 0,expires_at:0})) as NodeListing[],stats:r.stats.map(s=>({...s,earned:s.earned_mc/1000,spent:s.spent_mc/1000,reliability:s.reliability ?? 0})),updated_at:Date.now()};
}
export function ledgerFromWire(raw: unknown): LedgerEvent[] {
 return LedgerEventsResponse.parse(raw).events.map(r=>({id:String(r.id),type:r.event.type as LedgerEvent['type'],payload:r.event,gateway_sig:r.event.sig,hcs_seq:r.hcs_seq,ts:r.event.ts}));
}
export function rpFromWire(raw: unknown): WorldRpContext {
 const r=RpSignatureResponse.parse(raw);return {...r, app_id:r.app_id as `app_${string}`,signature:r.sig};
}
export function payoutsFromWire(raw: unknown): {epochs:Epoch[];payouts:Payout[]} {
 const r=PayoutsResponse.parse(raw);
 // The endpoint lists this address's leaves, not aggregate epoch totals. Do not invent totals.
 return {epochs:[],payouts:r.payouts.map(p=>({...p,payout_address:r.payout_address as Payout['payout_address'],proof:p.proof as Payout['proof']}))};
}
