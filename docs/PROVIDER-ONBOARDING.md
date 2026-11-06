# Provider onboarding

Open `/getting-started` from **Become a provider** on the landing page or **Provide** in the
console. The page follows the existing dark panels, Departure typography and blue controls.
All progress comes from authenticated API responses; no demo state is used in the application.

## Create or join

1. Choose **Create a pool** or **Join a pool**, then complete the existing World login.
   The choice is kept when the login sheet closes or verification completes.
2. A coordinator chooses a supported model, pool name, member count (including themselves),
   and their Hedera testnet payout address. The gateway creates an owned, random Pool ID.
3. Other owners enter that Pool ID and their own payout address. The coordinator approves
   requests on the same page. Knowing a Pool ID does not authorize compute membership.
4. Approved owners click **Get install command** and paste it into Terminal on the laptop
   they want to contribute. The command contains a single-use pairing code expiring in
   15 minutes; it never contains a World session, marketplace signer or treasury credential.
5. The helper creates a local node key, proves possession with the existing EIP-191 node
   registration signature and exchanges the code for a scoped helper credential. The gateway
   enforces the existing node ownership/cap/payout rules. An owner-approved payout address
   cannot be changed by a helper's claim payload.
6. Helpers discover Ethernet, install/check software and prepare model caches. Each owner
   sees actual stages, byte counts for LAN transfers, hardware, wallet gas needs and errors.
7. When the expected approved helpers are all prepared, the coordinator starts its private
   scheduler and reports its fresh multiaddress. The gateway then issues a common start time.
   Every helper starts its own node; no human must paste timed join commands.
8. The coordinator performs a short warm-up. Readiness additionally requires fresh signed
   layer coverage and an Arkiv pool listing. The normal marketplace router still reads Arkiv
   and gates on the coordinator connection before taking credits/payment.

Approving a late member pauses the pool and prepares a coordinated rebuild. Revoking a member
invalidates its helper token and its signed-heartbeat admission. Rejoining requires another
coordinator approval. Reconnecting an approved helper reuses its local node key and verified
cache, rotates its credential and prepares a new coordinated start. A physical laptop should
run one pool helper at a time. Existing unrelated Parallax workloads are not killed.

## One central gateway, private provider coordinators

```text
Browser --World session--> central marketplace gateway
Local helper --single-use code + node signature--> scoped helper session

Requester --> central auth/payment/hold/settlement --> outbound coordinator relay
                                                   --> 127.0.0.1:3001 Parallax
                                                   --> Ethernet worker pipeline
```

Only the central gateway holds World signing, JWT, ledger/HCS, treasury, settler, catalog and
optional directory gas-funding keys. Providers receive their own node key and a restricted
helper credential (stored locally with mode 600); the server stores only the credential hash.
The coordinator helper maintains outbound HTTPS long polls and uploads streaming responses.
No inbound Internet tunnel, provider payment gateway, public Parallax HTTP port or SSH access
between owners is required. The logical coordinator address `provider://<pool_id>` is routed
inside the gateway to this authenticated relay; it is never fetched through DNS/HTTP.

The relay only forwards chat completions (and the fixed status endpoint supported by the
helper), caps queued work and response sizes, supports cancellation and preserves streaming
usage. Existing accounting runs before and after forwarding exactly as for local pools.
Lost streams do not become successful settlements. x402 failure/refund rules remain unchanged.

## Model preparation and the SSH handoff

Parallax remains the external pinned dependency at
`162354a03234a28cf6e2946e2e0b2203da7c3721`. Its source is not patched. The helpers reuse the
repository's runtime hooks and launcher process groups. Existing pinned installations are
detected at `PARALLAX_DIR`, `~/parallax` or `~/Desktop/ETHGlobal/parallax`; otherwise a managed
installation is made in the owner's private pool directory.

The coordinator resolves and downloads GPU FP8 and Apple MLX formats once each. Complete
existing HF caches are reused, including the handoff's `<parallax>/.cache/huggingface` layout.
Members also reuse matching cached snapshots or `~/Models/<model-repo-name>` files after
checking the coordinator's expected size/hash. No original model files or `p2p.key` are deleted.

Model files are served on the coordinator's wired IPv4 port **5200**, with per-request HMAC
authorization, short timestamp validity and SHA-256 content verification at the receiver.
No enrollment/helper credentials are sent to this LAN server. Paths are restricted to the
approved snapshots; cache layout includes `refs/main` and `snapshots/<commit>` for offline HF
loading. Transfers finish before nodes start. Partial/corrupt files are not promoted.

The supplied handoff is applied: run each helper directly in Terminal, use explicit scheduler
multiaddresses, preserve the scheduler identity, avoid manual `--start-layer/--end-layer`,
and start nodes together. For the tested three-member Qwen3-14B profile, Macs use
`--param-mem-ratio 0.37` plus KV fraction 0.25 and sequence length 4096. Other member counts
use Parallax's default placement budget with the same safe Mac KV/context limits. Placement
may leave spare nodes; four enrolled members do not guarantee four active stages or a speedup.

The helper remains in the foreground while serving. Ctrl+C stops its managed processes.
Ethernet loss/address changes are reported as errors; reconnecting uses newly discovered IPs,
without editing manifests. The page does not substitute a successful state for a failed setup.

## Gateway deployment

- Set `PUBLIC_URL` to the browser/helper-reachable **HTTPS API URL**. Point the frontend's
  existing `VITE_GATEWAY_URL` at it, or reverse-proxy `/provider/*` alongside the existing API.
  Vite dev/preview routing includes the new API prefix. The frontend itself needs no new keys.
- Keep the existing World, HCS, Arkiv and testnet payout configuration on this central host.
  Keep the shared Qwen catalog published in Arkiv (`arkiv/src/cli.ts seed-models`) when setting
  up a fresh marketplace. Providers cannot change model prices or add unsupported architectures.
- SQLite schema is now **13**. Follow the repository's development database policy: use a fresh
  DB, or the existing automatic backup/reset mechanism. `DB_RESET_ON_MISMATCH=false` refuses
  a mismatched DB. No running database was changed during this implementation.
- Optionally configure a **dedicated, funded Rabdi testnet wallet** in
  `PROVIDER_ARKIV_FUNDER_KEY`, held only on the gateway. `PROVIDER_ARKIV_GRANT_WEI` defaults
  to `10000000000000000` (0.01 tGLM) and is capped at 1 tGLM per paired node. Set it to `0`
  or leave the key blank to disable automatic grants. Use this wallet only for grants, so
  another writer cannot race its nonce. This is separate from provider HBAR payouts.
- Gas grants serialize signing, persist raw bytes/hash before broadcast, reuse the exact
  transaction on retry/restart and stop on a reverted transaction. The provider never receives
  the funder key. Without the optional funder, the UI shows each node wallet and the faucet;
  an already funded node works without another grant.
- Disable request/response buffering for streaming `/provider/helper/jobs/*` uploads and
  `/v1/chat/completions` responses at the reverse proxy. Allow long polls (20 seconds) and
  inference uploads (up to 10 minutes); do not cache provider endpoints or log pairing bodies.
- Only the gateway HTTPS port is public. On the LAN allow approved peer IPv4 addresses to
  reach scheduler port 5100 and worker TCP/UDP ports 5101 onward, plus cache TCP 5200 on
  the coordinator. Notification port 5190 and Parallax HTTP 3001 remain loopback-only.

The helper can install user-space uv, Node 24, pnpm, Rust and protoc and can install Parallax
platform extras. Git, working NVIDIA drivers / Apple developer tools and Python 3.10+ must
be available. OS Local Network, developer-tool and firewall approvals still require the
owner. The helper never invokes sudo, weakens SSH/firewalls, or pretends to bypass OS consent.

## API and storage

Shared schemas are in `shared/src/provider.ts`.

| Endpoint | Authorization | Purpose |
|---|---|---|
| `GET/POST /provider/pools` | World session | Own memberships/models; create a pool |
| `POST /provider/pools/join` | World session | Request membership with Pool ID |
| `GET /provider/pools/:id` | Member World session | Read setup state |
| `POST .../:id/members/:member/approve` or `/revoke` | Coordinator World session | Manage admission |
| `POST .../:id/enroll` | Approved owner's World session | Issue one-use install command |
| `POST .../:id/stop` or `/restart` | Coordinator World session | Stop/rebuild coordination |
| `/provider/bootstrap`, `/bundle.zip`, `/helper.py`, `/install.sh` | Public | Source-only installer assets |
| `POST /provider/enroll/info`, `/claim`, `/failure` | Unexpired pairing code; signature for claim | Pair a machine/report pre-install error |
| `/provider/helper/config`, `/progress`, `/fund` | Scoped helper token | Own runtime state and bounded directory grant |
| `/provider/helper/snapshots`, `/scheduler`, `/ready`, `/jobs` | Coordinator helper token | Prepare and serve this pool |

`provider_pools` stores ownership, selected model, private LAN configuration, snapshot locks
and generations. `provider_members` stores approval, bound node identity, hashed credential,
progress and gas transaction evidence. `provider_enrollments` stores hashed, expiring one-use
codes. Browser responses are schema-filtered to exclude tokens, LAN secrets and raw funding
transactions. Existing node, credit, reliability, HCS and Arkiv records are reused.

The older `pool/kickstart.sh` SSH/manifest tool remains available for operator-managed LAN
setups. The website uses `pool/provider/helper.py` instead; it never distributes a local
marketplace gateway or asks providers for platform secrets.

## Verification and remaining live acceptance

Tests cover authenticated creation/admission, one-use enrollment, payout binding, scoped and
revoked credentials, coordinated-start barriers, signed heartbeat coverage, source bundle
contents, retry-safe gas funding, model integrity/cache reuse and normal credit settlement
over the relay. A real localhost test runs the Python coordinator against HTTP servers,
streams SSE through a chunked upload and verifies a single central settlement.

Browser validation uses an isolated in-memory fixture gateway. It does not prove World App
verification, four physical laptops, fresh GPU/compiler installations, model generation,
public HTTPS proxy behavior, testnet grants or HCS/payout transactions. Those need a live
operator run with actual enrolled owners and funded central services. No installer was run
on the user's active pool as part of development.

References: [Hugging Face snapshots](https://huggingface.co/docs/huggingface_hub/guides/download),
[uv installer](https://docs.astral.sh/uv/getting-started/installation/), and the supplied
three-node SSH handoff. The handoff's old IPs and private access setup are not committed here.
