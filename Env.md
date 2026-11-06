# Environment setup

The values below come from the repository's example files. Blank values still need to be filled. This file contains no secrets; keep real secrets only in the ignored environment files, not in this Markdown file or Git.

## Obtain the missing values

1. *World:* Sign in at https://developer.world.org/. Create a staging app and relying party, and the gpupool-account action. Put the app ID, RP ID, and server-only RP signing key in gateway/.env. Copy only the public app ID to frontend/.env.local. Confirm that selfieCheck is available for the staging app.
2. *Hedera testnet:* Use https://portal.hedera.com/ to create or obtain testnet accounts for the operator, treasury, settler, agent, deployer, and provider payouts. Fund them with testnet HBAR. Create an HCS topic with the appropriate submit key and record its ID. Use the account IDs and corresponding private keys for their named roles. Contract deployment later supplies PAYOUT_CONTRACT_ADDRESS; use the settler's EVM address for SETTLER_ADDRESS. Never use mainnet keys.
3. *Arkiv:* At https://hub.arkiv.network/access-keys connect a wallet and obtain an access key. Create separate testnet writer wallets for the gateway, coordinator, and nodes; use the Arkiv faucet to fund them. Put the gateway writer private key in gateway/.env, and store node/coordinator keys at the paths configured in node-agent/.env.
4. *Local secrets:* Generate a long random JWT_SECRET locally (for example, openssl rand -hex 32). Generate the gateway's Ed25519 signing key in the format required by its implementation; that format must be confirmed before filling GATEWAY_SIGNING_KEY.
5. *Deployment details:* Set the real wired LAN addresses and cache paths for each machine. Deploy the payout contract before filling its address. Confirm the Hedera-compatible x402 facilitator and network identifier; the example facilitator is not yet verified for Hedera.

Copy the templates to the paths below without overwriting existing files. Fill the blanks locally. Each node needs its own pool/node.env and node-agent/.env on that machine. Example LAN addresses may be stale.

| Template | Destination |
| --- | --- |
| gateway/.env.example | gateway/.env |
| node-agent/.env.example | node-agent/.env |
| contracts/.env.example | contracts/.env |
| agent-client/.env.example | agent-client/.env |
| frontend/.env.example | frontend/.env.local |
| pool/node.env.example | pool/node.env |

## Key-value templates

The following are examples, not active configuration. Values must be copied into the appropriate ignored files above.

### gateway/.env

dotenv
PORT=8080
PUBLIC_URL=http://10.73.185.71:8080
POOL_COORDINATOR_URL=http://127.0.0.1:3001
DATABASE_PATH=./data/gateway.sqlite
JWT_SECRET=
GATEWAY_SIGNING_KEY=
CORS_ORIGINS=http://localhost:3000

WORLD_APP_ID=app_3defa81f175967a96109b1a628927bb6
WORLD_RP_ID=rp_831104fa5fd04dd5
WORLD_RP_SIGNING_KEY=
WORLD_ACTION=gpupool-account
WORLD_ENVIRONMENT=staging
STARTER_CREDITS=10000
STARTER_EXPIRY_DAYS=14

HEDERA_NETWORK=testnet
HEDERA_OPERATOR_ID=0.0.11331600
HEDERA_OPERATOR_KEY=
HCS_TOPIC_ID=
HEDERA_MIRROR_URL=https://testnet.mirrornode.hedera.com
HEDERA_JSON_RPC_URL=https://testnet.hashio.io/api
HEDERA_CHAIN_ID=296
TREASURY_ACCOUNT_ID=0.0.11331600
TREASURY_PRIVATE_KEY=
X402_FACILITATOR_URL=https://x402.org/facilitator
X402_NETWORK=
X402_PAY_TO=0.0.0.0.11331600
SETTLER_PRIVATE_KEY=
PAYOUT_CONTRACT_ADDRESS=
EPOCH_SECONDS=600

ARKIV_RPC_URL=https://rpc.rabdi.db-chain.testnet.arkiv.network
ARKIV_CHAIN_ID=7794095
ARKIV_ACCESS_KEY=
ARKIV_PRIVATE_KEY=


### node-agent/.env

dotenv
GATEWAY_URL=http://10.73.185.71:8080
NODE_KEY_PATH=~/.gpupool/node.key
POOL_ID=pool-lab-1
IS_COORDINATOR=false
POOL_KEY_PATH=~/.gpupool/pool.key
ARKIV_RPC_URL=https://rpc.rabdi.db-chain.testnet.arkiv.network
ARKIV_CHAIN_ID=7794095
ARKIV_ACCESS_KEY=
HEARTBEAT_SECONDS=10
ARKIV_EXTEND_SECONDS=30


### contracts/.env

dotenv
HEDERA_JSON_RPC_URL=https://testnet.hashio.io/api
DEPLOYER_PRIVATE_KEY=
SETTLER_ADDRESS=
CLAIM_DELAY_SECONDS=60


### agent-client/.env

dotenv
GATEWAY_URL=http://10.73.185.71:8080
AGENT_ACCOUNT_ID=
AGENT_PRIVATE_KEY=
AGENT_BUDGET_HBAR=1
HEDERA_NETWORK=testnet


### frontend/.env.local

dotenv
NEXT_PUBLIC_GATEWAY_URL=http://10.73.185.71:8080
NEXT_PUBLIC_WORLD_APP_ID=app_3defa81f175967a96109b1a628927bb6
NEXT_PUBLIC_WORLD_ACTION=gpupool-account
NEXT_PUBLIC_WORLD_ENVIRONMENT=staging
NEXT_PUBLIC_ARKIV_RPC_URL=https://rpc.rabdi.db-chain.testnet.arkiv.network
NEXT_PUBLIC_PAYOUT_CONTRACT=
NEXT_PUBLIC_HEDERA_CHAIN_ID=296
NEXT_PUBLIC_HASHSCAN_URL=https://hashscan.io/testnet


### pool/node.env

dotenv
PARALLAX_DIR=$HOME/parallax
ROLE=node                 # scheduler | node
MODEL=Qwen/Qwen3-14B-FP8
INIT_NODES=3              # scheduler only
DHT_PREFIX=gpupool-x7k2
LAN_IP=
TCP_PORT=5101
UDP_PORT=5101
HF_HOME=
EXTRA_FLAGS=              # Mac: --kv-cache-memory-fraction 0.25 --max-sequence-length 4096
CUDA_HOME=                # CUDA nodes: $PARALLAX_DIR/.venv/lib/python3.12/site-packages/nvidia/cu13