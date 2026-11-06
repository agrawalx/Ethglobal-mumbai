import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeFunctionData, encodeFunctionResult, keccak256, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/config.ts";
import { hederaSettlementChain, PAYOUT_ABI } from "../src/payout-chain.ts";
import { ZERO_ROOT } from "../src/merkle.ts";

// Test-only keys and addresses, never used on a public network.
const treasuryKey = `0x${"11".repeat(32)}` as Hex;
const settlerKey = `0x${"22".repeat(32)}` as Hex;
const treasury = privateKeyToAccount(treasuryKey);
const settler = privateKeyToAccount(settlerKey);
const contract = `0x${"aa".repeat(20)}` as Hex;

test("Hedera adapter signs exact treasury funding and postEpoch values; enforces chain, settler and treasury identity", async () => {
  let chainId = 296;
  let declaredSettler = settler.address;
  let broadcasts = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/accounts/0.0.1') { res.end(JSON.stringify({ evm_address: treasury.address.toLowerCase() })); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    let result: unknown;
    switch (rpc.method) {
      case 'eth_chainId': result = `0x${chainId.toString(16)}`; break;
      case 'eth_getBlockByNumber': result = { number: '0xa', timestamp: '0x4b0', gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x0', transactions: [], uncles: [], hash: ZERO_ROOT, parentHash: ZERO_ROOT, nonce: '0x0000000000000000' }; break;
      case 'eth_getTransactionCount': result = '0x0'; break;
      case 'eth_gasPrice': result = '0x3b9aca00'; break;
      case 'eth_estimateGas': result = '0x186a0'; break;
      case 'eth_sendRawTransaction': broadcasts++; result = keccak256(rpc.params[0]); break;
      case 'eth_call': {
        const fn = decodeFunctionData({ abi: PAYOUT_ABI, data: rpc.params[0].data });
        if (fn.functionName === 'settler') result = encodeFunctionResult({ abi: PAYOUT_ABI, functionName: 'settler', result: declaredSettler });
        else if (fn.functionName === 'epochs') result = encodeFunctionResult({ abi: PAYOUT_ABI, functionName: 'epochs', result: [ZERO_ROOT, 0n, 0n, 0n] });
        else if (fn.functionName === 'claimDelay') result = encodeFunctionResult({ abi: PAYOUT_ABI, functionName: 'claimDelay', result: 60n });
        break;
      }
    }
    res.end(JSON.stringify(result === undefined ? { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `unexpected method ${rpc.method}` } } : { jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const cfg = loadConfig({ DATABASE_PATH: ':memory:', POOL_COORDINATOR_URL: 'http://127.0.0.1:3001',
      HEDERA_JSON_RPC_URL: url, HEDERA_MIRROR_URL: url, HEDERA_CHAIN_ID: '296', HEDERA_NETWORK: 'testnet',
      TREASURY_ACCOUNT_ID: '0.0.1', X402_PAY_TO: '0.0.1', TREASURY_PRIVATE_KEY: treasuryKey,
      SETTLER_PRIVATE_KEY: settlerKey, PAYOUT_CONTRACT_ADDRESS: contract });
    const chain = hederaSettlementChain(cfg);
    await chain.verify();
    assert.equal(chain.needsFunding, true);
    const funding = await chain.prepareFunding(1_600_000n);
    const fundingTx = parseTransaction(funding.raw);
    assert.equal(funding.hash, keccak256(funding.raw));
    assert.equal(fundingTx.to?.toLowerCase(), settler.address.toLowerCase());
    assert.equal(fundingTx.value, 16_000_000_000_000_000n);
    const root = keccak256('0x1234');
    const post = await chain.preparePost(42, root, 1_600_000n);
    const postTx = parseTransaction(post.raw);
    assert.equal(postTx.to?.toLowerCase(), contract);
    assert.equal(postTx.chainId, 296);
    assert.equal(postTx.value, 16_000_000_000_000_000n);
    const decoded = decodeFunctionData({ abi: PAYOUT_ABI, data: postTx.data! });
    assert.equal(decoded.functionName, 'postEpoch');
    assert.deepEqual(decoded.args, [42n, root]);
    assert.equal(await chain.broadcast(post.raw), post.hash);
    assert.equal(broadcasts, 1);
    chainId = 1;
    await assert.rejects(chain.verify(), /not Hedera testnet/);
    chainId = 296; declaredSettler = treasury.address;
    await assert.rejects(chain.verify(), /does not match EpochPayout.settler/);
    assert.throws(() => hederaSettlementChain({ ...cfg, env: { ...cfg.env, HEDERA_NETWORK: 'mainnet' } }), /testnet/);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
