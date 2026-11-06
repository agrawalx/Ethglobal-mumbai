# Kickstart a pool from its coordinator

This workflow targets a group of 2–16 trusted laptops on wired Ethernet. One of them is both
the Parallax coordinator and the marketplace gateway host. It can also contribute a GPU.
All four laptops in the example contribute; a requester is a separate browser/client.

Entry point: `pool/kickstart.sh`. Control code: `pool/bootstrap/`. The coordinator uses SSH
to prepare the named members and release their joins together. An agent bridge is not needed.

The code has local tests. **A live four-laptop bootstrap has not yet been verified.** Do not
describe it as a completed unattended deployment until the acceptance checks below pass.

## Data and request flow

```text
Coordinator: download the canonical GPU model and the Apple MLX variant, once each
    → resolve immutable Hugging Face commits and hash every snapshot file
    → copy each required format over SSH to the appropriate Ethernet member
    → verify the received files and build each member's offline HF cache
    → complete all installs/downloads before starting any inference worker

Each owner: World login → approve their signed node registration → payout address
Each node agent: signed heartbeats to gateway + owner-signed Arkiv node listing
Elected pool writer: expiring Arkiv pool listing derived from gateway layer maps

Requester → marketplace gateway (auth/payment/accounting)
          → Parallax scheduler at 127.0.0.1:3001 on the SAME laptop
          → worker-to-worker Ethernet pipeline → response
```

Parallax chooses the layer placement after seeing the hardware. Four registered workers do
not guarantee four active pipeline stages: a smaller subset may hold a complete pipeline,
with other nodes idle or spare. More computers can increase capacity without increasing
single-request decode speed. Memory is left for the OS, KV cache and runtime workspaces.

## One-time enrollment requirements

A shell script cannot grant itself access to another person's laptop or verify that person's
World ID. These prerequisites are explicit rather than bypassed:

- Every laptop has Python 3.10+ for the bootstrap controller/host helper, Git, `uv`, Node 24+
  and `pnpm`. `uv` installs the node agent's Python 3.12 environment. On macOS, install the
  Apple command-line developer tools; Linux workers need a working NVIDIA driver and `ip`.
- If Parallax is already installed, set its path for that member. Its Git HEAD must be
  `162354a03234a28cf6e2946e2e0b2203da7c3721`. Other revisions are refused and never checked out
  over an existing install. If `parallax_dir` is omitted, it is cloned into the managed pool
  directory and installed with the platform extras. A fresh build also needs `protoc`, a
  Rust toolchain and the platform C/C++ build tools. The bootstrap does not invoke sudo or
  change NVIDIA drivers, firewall settings, SSH configuration or system package managers.
- The coordinator can reach each other laptop through **key-only SSH** with a trusted host
  key. Pair once using the OS's normal SSH setup. Use SSH aliases or `user@laptop.local` in
  the manifest; stable IP addresses are not required. The OS SSH service, authorization of
  the coordinator's key and verification of the host fingerprint require the owner's consent.
- Stop pre-existing inference workloads before `prepare`. It refuses a selected Parallax
  installation that has running processes. It never stops an unrelated pool automatically.
- The marketplace frontend already exists and points at this gateway. The coordinator's
  private gateway env file contains the World app/RP/signing key, gateway/JWT signer, HCS,
  testnet payment/payout and Arkiv operator settings. The bootstrap reuses that file, never
  copies it to members, and does not create external World/Hedera/Arkiv accounts.
- Each provider's node and pool writer wallets need Arkiv testnet gas. Registration prints
  their public addresses. Existing node/pool keys for this managed pool are reused; keys are
  generated separately on each owner laptop and never transferred to the coordinator.
- Model licenses and any gated Hugging Face access must already be accepted by the operator.
  Only the coordinator needs Hub access. Do not put a Hugging Face token in the manifest.

One active physical Ethernet IPv4 interface is selected automatically on each host. If a
laptop has several, set its `interface` field (for example `en8` or `enp4s0`). Wi-Fi, virtual
bridges and link-local-only interfaces are excluded. Hostnames discover machines; the helper
discovers their wired IPs. Transfers and startup control use those wired addresses while
preserving the enrolled SSH host-key identity. It does not scan the venue network.

Firewalls must permit the actual member IPv4 addresses to reach **each other's** configured
P2P TCP and UDP ports. In the example these are 5100 on the coordinator's scheduler and
5101–5104 on workers. Port 5190 is a loopback-only node notification endpoint. Only the
gateway HTTP(S) port is exposed to clients; Parallax's scheduler HTTP port stays on loopback.
Review exact allow-list rules with each owner, rather than opening a whole venue subnet.

Use a browser-trusted HTTPS marketplace URL for phone/World flows. HTTP LAN endpoints can
help with development but are not a substitute for live browser acceptance. If gateway TLS
is configured, supply `gateway_url` with a matching, trusted HTTPS hostname. The bootstrap
does not disable certificate verification or generate a fake trusted certificate.

## Create the four-laptop manifest

From the repository root on the coordinator:

```bash
mkdir -p pool/run
cp pool/pool.example.json pool/run/my-pool.json
```

Edit the three member SSH destinations, the existing marketplace `frontend_url`, and the
coordinator's `gateway_env` path. `local` must remain first. `parallax_dir` is resolved on
that member; omit it for a new managed install. The managed copies of the application are
distributed by the coordinator, so members do not need to clone this marketplace repository.

Optional fields:

| Field | Purpose |
|---|---|
| Member `interface` | Select one physical Ethernet adapter when discovery is ambiguous |
| Member `port` | Fixed worker TCP/UDP port; default 5101 + member index |
| Member `param_mem_ratio` | Explicit measured placement budget, between 0 and 1; otherwise Parallax default |
| `gateway_url` | Browser/node-reachable gateway URL; default `http://<discovered coordinator IP>:8080` |
| `gateway_port` | Gateway listener; default 8080 |
| `api_port` | Private scheduler HTTP listener; default 3001 |
| `scheduler_port` | Scheduler P2P TCP/UDP listener; default 5100 |
| `model_revisions` | Optional map of model repo IDs to full 40-character HF commit hashes |

`pool_id` is an explicit group identifier, not `auto`. Four different people can register
one node each in the same pool. A single new account still has the spec's three-node cap;
bootstrap does not bypass that rule to register four machines under one new identity.

## Start with one coordinator command

```bash
pool/kickstart.sh plan pool/run/my-pool.json     # no connections or installs
pool/kickstart.sh doctor pool/run/my-pool.json   # read host hardware, wired IPs and tools
pool/kickstart.sh setup pool/run/my-pool.json
```

`setup` runs the preparation, starts the configured gateway, prints each owner's signed
registration link and Arkiv writer wallet addresses, ensures the selected model is in the
Arkiv catalog, and waits up to 15 minutes for owner registrations. After those approvals,
it starts the scheduler and agents, then all worker joins concurrently. No separate join
commands or IP edits are needed on the members.

The gateway binds `0.0.0.0` on `gateway_port`, uses the managed scheduler's private URL, and
allows the manifest's frontend origin through CORS. It forces output verification off and
database reset off. Relative paths in the operator env (including `DATABASE_PATH`) remain
relative to the directory containing that env file. Existing operator credentials and
database files are preserved. Stop an existing gateway on the same port before starting this
managed one; bootstrap does not take over an unmanaged process or reset an incompatible DB.

If approval/funding takes longer, keep the prepared data and use:

```bash
pool/kickstart.sh register pool/run/my-pool.json  # refresh links; does not give credits itself
pool/kickstart.sh up pool/run/my-pool.json
```

The same workflow can be stepped through explicitly:

```bash
pool/kickstart.sh prepare pool/run/my-pool.json
pool/kickstart.sh register pool/run/my-pool.json
pool/kickstart.sh catalog pool/run/my-pool.json
# Owners complete World registration and fund their own Arkiv writer wallets.
pool/kickstart.sh up pool/run/my-pool.json
pool/kickstart.sh status pool/run/my-pool.json
pool/kickstart.sh down pool/run/my-pool.json
```

`catalog` uses the coordinator operator's Arkiv key only if the selected model is absent. It
does not give providers permission to change marketplace prices or introduce unknown models.

## What preparation installs and stores

- An immutable copy of this application's source at
  `~/.gpupool/pools/<pool_id>/app-<source hash>` on each host. Source bundles omit private env
  files, wallet keys, Git history, dependency directories and model caches. Deployed files
  are verified against their source receipt on reuse.
- Node-agent and Arkiv dependencies on each member; gateway dependencies on the coordinator.
  Parallax remains an external installation. The HTTPX compatibility constraint, CUDA JIT
  toolchain setup on Linux, and runtime-hook source checks follow the existing handoff.
- Complete model snapshots under `~/.gpupool/pools/<pool_id>/hf/hub`. The coordinator downloads
  GPU and MLX formats once each, records the resolved commits, and hashes their contents.
  Members receive only their format, with the `refs/main` and snapshot layout needed for
  offline loading. An incomplete/corrupt LAN transfer is rejected and its staging directory
  removed. Completed verified copies are reused; interrupted LAN transfers restart.
- Per-host private node/pool keys under the managed pool's `keys/`; generated env files are
  mode 600. The node agent's state/PID files are isolated from existing node-agent instances.
- Coordinator progress/model locks at `pool/run/kickstart/<pool_id>/state.json` (ignored,
  mode 600). The same manifest reuses its locked model revisions. A changed manifest requires
  a new pool ID; stop the old pool using the original manifest first.

This first version transfers complete snapshots rather than individual assigned layers.
Placement happens later and can change. Full snapshots allow reliable offline joins/restarts
without changing Parallax. Budget disk for complete snapshots on every member and both
formats on a mixed-hardware coordinator. HF's download cache and this pool's isolated cache
are separate; an unrelated pre-existing cache is not silently copied or modified.

On 100 Mbps Ethernet a 15 GB transfer takes at least about 20 minutes before overhead; use
Gigabit Ethernet when available. Download/copy speed is separate from inference tokens/sec.
Transfers are sequential to bound coordinator disk/network load and stream rather than buffer
weights in RAM. Peer-to-peer cache replication and selective shard preloading are not built.

## Readiness, recovery and limits

`up` checks owner registrations before starting inference workers. It gets the fresh scheduler
peer ID from the current scheduler startup log and supplies an explicit multiaddress to every
member. All preparation finishes before parallel joins. Macs use the known low-KV profile:
`--kv-cache-memory-fraction 0.25 --max-sequence-length 4096`; workers batch one request.

Readiness requires executable Parallax pipeline capacity, a successful short warm-up with
actual token usage, fresh signed node heartbeats and the selected model appearing through
the gateway's Arkiv-backed `/v1/models`. A health check or a list of `available` nodes is
insufficient. The warm-up uses private Parallax directly and does not make a paid request.
Readiness does not prove x402/HCS/provider claims; those remain the live demo runbook's tests.

Failures leave logs/evidence intact and do not claim success. Gateway/agent logs and process
records are under each host's managed pool root; Parallax logs are under its managed app's
`pool/logs`. `status` shows process health and reported layer assignments. `down` stops only
recorded owned process groups and their observed descendant groups; it does not run the
existing machine-wide `stop-all.sh` sweep. Arkiv listings then expire normally.

If an Ethernet address changes, `up` refuses stale announcement addresses. Run `down`, then
`prepare` again with the same manifest before `up`. OS firewall allow-lists may also need
the new IP. Sleep/adapter drops, firewall prompts and machine power remain owner/OS actions.

Only the two configured Qwen models are selectable today. An arbitrary new Hugging Face ID
must first be supported by the pinned Parallax backend/MLX mapping and approved in shared
model configuration (layers, size, factors and prices), then published to Arkiv. This command
does not edit Parallax or assume every Hugging Face architecture can be served.

This version implements the agreed co-located coordinator/gateway architecture. Independent
provider groups registering against a centrally hosted gateway need a separately designed,
authenticated private connection and operator-approved coordinator mapping. Do not expose
raw Parallax HTTP publicly or deploy a separate payments gateway per provider to work around it.

## Local validation

```bash
python3 -m unittest discover -s pool/bootstrap/tests -v
PARALLAX_SRC=/path/to/parallax uv run --project node-agent pytest pool/hooks -q
bash -n pool/kickstart.sh
pool/kickstart.sh plan pool/pool.example.json
```

Before live acceptance: provision actual enrolled hosts and credentials, run `setup`, confirm
the four hardware identities and actual layer placement, test inference from a requester,
confirm Arkiv listings and HCS records, then test a managed stop/restart. Preserve private
keys locally and record only public IDs and measured outputs as evidence.

Sources: [Hugging Face snapshot downloads and revisions](https://huggingface.co/docs/huggingface_hub/guides/download),
[Parallax upstream](https://github.com/GradientHQ/parallax), pinned installed source and this
repository's `docs/HANDOFF.md` / `docs/SPEC.md`.
