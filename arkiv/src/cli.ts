#!/usr/bin/env node
/**
 * Arkiv CLI for the Python node agent (and for seeding / checking by hand).
 *
 *   node src/cli.ts upsert-node '<ArkivNode JSON>'    node agent, every ARKIV_EXTEND_SECONDS (key: node.key)
 *   node src/cli.ts upsert-pool '<ArkivPool JSON>'    coordinator, every ARKIV_EXTEND_SECONDS (key: pool.key)
 *   node src/cli.ts upsert-stats '<ArkivAccountStats JSON>'   gateway, every 10 min
 *   node src/cli.ts seed-models                       admin: one gpupool.model per shared config model
 *   node src/cli.ts list-ready-pools <model>          the router query
 *   node src/cli.ts list-models | list-nodes [pool_id] | list-stats
 *   node src/cli.ts address                           writer address (fund it at hub.arkiv.network/faucet)
 *
 * Output: one JSON document on stdout. Errors: message on stderr, exit 1.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { ARKIV_ENTITY, GpupoolConfig, type ArkivModel } from "@gpupool/shared";
import { publicArkiv, walletArkiv, writerKey } from "./client.ts";
import { listAccountStats, listModels, listNodes, listReadyPools } from "./reader.ts";
import { ttlFor, upsert } from "./writer.ts";
import type { Kind } from "./schema.ts";

const USAGE = "usage: cli.ts upsert-node|upsert-pool|upsert-stats <json> | seed-models | list-ready-pools <model> | list-models | list-nodes [pool_id] | list-stats | address";

const loadNetConfig = () =>
  GpupoolConfig.parse(JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("@gpupool/shared/config.json")), "utf8")));

const print = (o: unknown) => console.log(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

function parseJsonArg(arg: string | undefined): unknown {
  if (!arg) throw new Error(USAGE);
  try {
    return JSON.parse(arg);
  } catch {
    throw new Error("argument is not valid JSON");
  }
}

async function upsertCmd(kind: Kind, arg: string | undefined) {
  const cfg = loadNetConfig();
  const entity = parseJsonArg(arg) as never;
  print(await upsert(publicArkiv(), walletArkiv(), kind, entity, ttlFor(cfg, kind)));
}

async function main(argv: string[]) {
  const [cmd, arg] = argv;
  switch (cmd) {
    case "upsert-node": return upsertCmd("node", arg);
    case "upsert-pool": return upsertCmd("pool", arg);
    case "upsert-stats": return upsertCmd("accountStats", arg);
    case "seed-models": {
      const cfg = loadNetConfig();
      const pub = publicArkiv();
      const wallet = walletArkiv();
      const out = [];
      for (const m of cfg.models) {
        const entity: ArkivModel = { type: ARKIV_ENTITY.model, model_id: m.model_id, mlx_variant: m.mlx_variant, size_gb: m.size_gb, model_factor: m.model_factor, license: m.license };
        out.push({ model_id: m.model_id, ...(await upsert(pub, wallet, "model", entity, ttlFor(cfg, "model"))) });
      }
      return print(out);
    }
    case "list-ready-pools":
      if (!arg) throw new Error(USAGE);
      return print(await listReadyPools(publicArkiv(), arg));
    case "list-models": return print(await listModels(publicArkiv()));
    case "list-nodes": return print(await listNodes(publicArkiv(), arg));
    case "list-stats": return print(await listAccountStats(publicArkiv()));
    case "address": return print({ address: privateKeyToAccount(writerKey()).address.toLowerCase() });
    default: throw new Error(USAGE);
  }
}

main(process.argv.slice(2)).catch((e: Error) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
