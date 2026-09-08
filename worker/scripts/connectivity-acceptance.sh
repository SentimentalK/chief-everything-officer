#!/usr/bin/env bash
# Cross-language connectivity acceptance for A2.2-2.
#
# Proves the compiled `ceo-worker bridge check` can, against a REAL Server
# (real Identity Service + auth middleware + JobService + Worker Router) backed
# by a real Redis and a temporary identity DB:
#   * resolve the configured alias to a local directory,
#   * verify the live identity equals the configured expected identity,
#   * discover a task that was submitted by the same identity,
#   * and fail cleanly on a wrong key / wrong identity / wrong alias.
# It also asserts `bridge check` never sends claim/start/heartbeat.
#
# Environment (all required unless noted):
#   CEO_ACCEPTANCE_REDIS    redis:// URL (password auth)
#   CEO_ACCEPTANCE_KEY      the API key provisioned into the identity DB
#   CEO_ACCEPTANCE_REMOTE   absolute path of a bare git remote (repo of record)
#   CEO_ACCEPTANCE_ROOT     temp root dir (created/cleaned by the script)
#   CEO_ACCEPTANCE_SERVER   directory of services/server (built dist present)
#   CEO_ACCEPTANCE_WORKER   path to the compiled ceo-worker binary
#   CEO_ACCEPTANCE_PORT     local port for the test Server
#   CEO_ACCEPTANCE_BRANCH   branch (default main)
set -euo pipefail

: "${CEO_ACCEPTANCE_REDIS:?missing}"
: "${CEO_ACCEPTANCE_KEY:?missing}"
: "${CEO_ACCEPTANCE_REMOTE:?missing}"
: "${CEO_ACCEPTANCE_ROOT:?missing}"
: "${CEO_ACCEPTANCE_SERVER:?missing}"
: "${CEO_ACCEPTANCE_WORKER:?missing}"
: "${CEO_ACCEPTANCE_PORT:?missing}"
BRANCH="${CEO_ACCEPTANCE_BRANCH:-main}"

E="$CEO_ACCEPTANCE_ROOT"
KEY="$CEO_ACCEPTANCE_KEY"
REDIS="$CEO_ACCEPTANCE_REDIS"
PORT="$CEO_ACCEPTANCE_PORT"
REMOTE="$CEO_ACCEPTANCE_REMOTE"
SRV="$CEO_ACCEPTANCE_SERVER"
WRK="$CEO_ACCEPTANCE_WORKER"

rm -rf "$E"; mkdir -p "$E"/workspace/tools "$E"/data/identity "$E"/logs

# A local "tools" worktree for the alias (content does not matter for read-only
# discovery; it must simply exist and be a directory).
cd "$E/workspace/tools"
git init -q -b "$BRANCH" 2>/dev/null || git init -q
echo "local tools" > README.md
git add -A
git -c user.email=t@e -c user.name=t commit -qm init 2>/dev/null || true

# 1) Provision the identity DB binding the API key to the remote/branch and
#    capture the single deployment user/workspace ids.
SRV="$SRV" DB="$E/data/identity/identity.sqlite" REMOTE="$REMOTE" BRANCH="$BRANCH" KEY="$KEY" IDS="$E/ids.json" \
node --input-type=module -e '
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
const base = process.env.SRV;
const store = await import(pathToFileURL(path.join(base, "dist/identity/store.js")).href);
const id = store.provisionEmptyIdentityDatabase(process.env.DB, {
  remoteUrl: process.env.REMOTE, branch: process.env.BRANCH,
  apiKeyDigest: store.sha256Hex(process.env.KEY),
});
writeFileSync(process.env.IDS, JSON.stringify(id));
console.log("provisioned", id.user_id, id.workspace_id);
'

# 2) Submit a real task via the Server JobService owned by that identity.
cd "$SRV"
REDIS="$REDIS" IDS="$E/ids.json" SRV="$SRV" \
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { createClient } from "redis";
import { pathToFileURL } from "node:url";
import path from "node:path";
const base = process.env.SRV;
const storeMod = await import(pathToFileURL(path.join(base, "dist/jobs/redis-store.js")).href);
const serviceMod = await import(pathToFileURL(path.join(base, "dist/jobs/service.js")).href);
const id = JSON.parse(readFileSync(process.env.IDS,"utf8"));
const scope = { user_id: id.user_id, workspace_id: id.workspace_id };
const runner = storeMod.createRedisRunnerFromClient(
  () => createClient({ url: process.env.REDIS, socket: { reconnectStrategy: false }, disableOfflineQueue: true }),
  { opTimeoutMs: 2500 });
const store = new storeMod.RedisJobStore(runner);
const svc = new serviceMod.JobService({ store }, () => true);
const wait = (ms=8000) => new Promise((res, rej) => { const s=Date.now();
  (function t(){ if (runner.ready()) return res(); if (Date.now()-s>ms) return rej(new Error("redis not ready")); setTimeout(t,20); })(); });
await wait();
const res = await svc.submit(scope, { request_id: "123e4567-e89b-12d3-a456-4266141740ff",
  workspace_ref: "tools", prompt: "connectivity acceptance", acceptance: "done", timeout_seconds: 120 });
if (!res.ok) throw new Error("submit failed " + JSON.stringify(res));
console.log("submitted", res.view.job_id);
await runner.dispose();
'

# 3) Start the real Server.
cd "$SRV"
CEO_DATA_ROOT="$E/data" CEO_REMOTE="$REMOTE" MCP_API_KEY="$KEY" CEO_BRIDGE_ENABLED=true \
  CEO_REDIS_URL="$REDIS" PORT="$PORT" BIND_HOST=127.0.0.1 \
  nohup node dist/server.js > "$E/logs/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for i in $(seq 1 40); do
  if curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/identity" >/dev/null 2>&1; then break; fi
  sleep 0.3
done

# 4) Bridge config + key file.
echo -n "$KEY" > "$E/key"; chmod 600 "$E/key"
node -e 'const fs=require("fs"); const id=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const cfg={schema_version:1,server_url:"http://127.0.0.1:"+process.argv[3],
    api_key_file:process.argv[1].replace(/ids\.json$/,"key"),
    expected_identity:{user_id:id.user_id,workspace_id:id.workspace_id},
    workspaces:{tools:process.argv[2]}};
  fs.writeFileSync(process.argv[1].replace(/ids\.json$/,"bridge.json"), JSON.stringify(cfg,null,2));' \
  "$E/ids.json" "$E/workspace/tools" "$PORT"

echo "--- bridge check (expected PASS) ---"
OUT="$("$WRK" bridge check --config "$E/bridge.json" --workspace-ref tools --after 0-0)"
echo "$OUT"
node -e 'const o=JSON.parse(process.argv[1]); if(!o.ok||!o.identity_verified){console.error("expected ok/identity_verified");process.exit(1)} if(o.jobs.length!==1){console.error("expected exactly one discovered job, got "+o.jobs.length);process.exit(1)} if(o.next_cursor==="0-0"){console.error("cursor did not advance");process.exit(1)} console.log("PASS discovered", o.jobs[0].job_id);' "$OUT"

# 5) Failure variants must exit non-zero.
wrong_key="$E/bridge-wrong-key.json"; cp "$E/bridge.json" "$wrong_key"
echo -n "not-the-key" > "$E/key-wrong"; chmod 600 "$E/key-wrong"
node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));c.api_key_file=process.argv[2];fs.writeFileSync(process.argv[1],JSON.stringify(c));' "$wrong_key" "$E/key-wrong"
if "$WRK" bridge check --config "$wrong_key" --workspace-ref tools >/dev/null 2>&1; then echo "wrong-key must fail"; exit 1; fi

wrong_identity="$E/bridge-wrong-id.json"; cp "$E/bridge.json" "$wrong_identity"
node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));c.expected_identity={user_id:"usr_00000000-0000-4000-8000-000000000000",workspace_id:"ws_00000000-0000-4000-8000-000000000000"};fs.writeFileSync(process.argv[1],JSON.stringify(c));' "$wrong_identity"
if "$WRK" bridge check --config "$wrong_identity" --workspace-ref tools >/dev/null 2>&1; then echo "wrong-identity must fail"; exit 1; fi

if "$WRK" bridge check --config "$E/bridge.json" --workspace-ref not-configured >/dev/null 2>&1; then echo "unknown alias must fail"; exit 1; fi

# 6) `bridge check` is read-only: it must never have issued claim/start/heartbeat.
if grep -qE '"(claim|start|heartbeat)"' "$E/logs/server.log"; then
  echo "bridge check must not issue claim/start/heartbeat"; exit 1
fi

echo "ALL_CONNECTIVITY_ACCEPTANCE_PASS"
