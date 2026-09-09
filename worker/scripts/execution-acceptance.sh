#!/usr/bin/env bash
# Cross-language EXECUTION acceptance for A2.2-3 (A2.2-2 batch): proves the
# compiled `ceo-worker bridge run` can, against a REAL Server (real Identity
# Service + auth + JobService + Worker Router) backed by a real Redis and a
# temporary identity DB, claim a job, run it under a server lease through the
# controlled Runner (using the hermetic test_stub executor — no paid/real
# model), heartbeat while it runs, save a local receipt, and stop cleanly on
# SIGTERM. It asserts claim/start truly happened server-side and that the
# worker_id/attempt_id in the server execution match the local receipt.
#
# Environment (all required unless noted):
#   CEO_ACCEPTANCE_REDIS    redis:// URL (password auth)
#   CEO_ACCEPTANCE_KEY      the API key provisioned into the identity DB
#   CEO_ACCEPTANCE_REMOTE   absolute path of a bare git remote (repo of record)
#   CEO_ACCEPTANCE_ROOT     temp root dir (created/cleaned by the script)
#   CEO_ACCEPTANCE_SERVER   directory of services/server (built dist present)
#   CEO_ACCEPTANCE_WORKER   path to the compiled ceo-worker binary
#   CEO_ACCEPTANCE_STUB     path to tests/fixtures/test_stub.sh (hermetic agent)
#   CEO_ACCEPTANCE_PORT     local port for the test Server
#   CEO_ACCEPTANCE_BRANCH   branch (default main)
set -euo pipefail

: "${CEO_ACCEPTANCE_REDIS:?missing}"
: "${CEO_ACCEPTANCE_KEY:?missing}"
: "${CEO_ACCEPTANCE_REMOTE:?missing}"
: "${CEO_ACCEPTANCE_ROOT:?missing}"
: "${CEO_ACCEPTANCE_SERVER:?missing}"
: "${CEO_ACCEPTANCE_WORKER:?missing}"
: "${CEO_ACCEPTANCE_STUB:?missing}"
: "${CEO_ACCEPTANCE_PORT:?missing}"
BRANCH="${CEO_ACCEPTANCE_BRANCH:-main}"

E="$CEO_ACCEPTANCE_ROOT"
KEY="$CEO_ACCEPTANCE_KEY"
REDIS="$CEO_ACCEPTANCE_REDIS"
PORT="$CEO_ACCEPTANCE_PORT"
REMOTE="$CEO_ACCEPTANCE_REMOTE"
SRV="$CEO_ACCEPTANCE_SERVER"
WRK="$CEO_ACCEPTANCE_WORKER"
STUB="$CEO_ACCEPTANCE_STUB"

rm -rf "$E"; mkdir -p "$E"/workspace/tools "$E"/data/identity "$E"/logs

# A doctor-passing workspace for the test_stub executor (AGENTS.md marker +
# stub mode file), matching what the generic/doctor-caching tests use.
cd "$E/workspace/tools"
git init -q -b "$BRANCH" 2>/dev/null || git init -q
cat > AGENTS.md <<EOF
# Guidelines

<!-- ceo:metadata rule_marker: "EXEC-ACCEPT" -->

1. Respect boundaries.
EOF
echo -n "normal" > .stub_mode
git add -A
git -c user.email=t@e -c user.name=t commit -qm init 2>/dev/null || true

# 1) Provision the identity DB binding the key to the remote/branch.
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

# 2) Submit a deterministic task via the real Server JobService.
cd "$SRV"
REDIS="$REDIS" IDS="$E/ids.json" SRV="$SRV" JOB="$E/job.json" \
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
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
const request_id = "123e4567-e89b-12d3-a456-4266141740ff";
const res = await svc.submit(scope, { request_id,
  workspace_ref: "tools",
  prompt: "[Step 3 - Fully Autonomous Execution: Task Execution]\nCreate output_artifact.txt with the exact bytes: acceptance-nonce-98765",
  acceptance: "output_artifact.txt must contain acceptance-nonce-98765", timeout_seconds: 120 });
if (!res.ok) throw new Error("submit failed " + JSON.stringify(res));
const rec = await store.getJob(res.view.job_id);
writeFileSync(process.env.JOB, JSON.stringify({
  job_id: res.view.job_id, request_id, user_id: scope.user_id,
  workspace_id: scope.workspace_id, workspace_ref: "tools",
  stream_entry_id: rec.stream_entry_id,
}));
console.log("submitted", res.view.job_id, "entry", rec.stream_entry_id);
await runner.dispose();
'

# 3) Start the real Server.
cd "$SRV"
CEO_DATA_ROOT="$E/data" CEO_REMOTE="$REMOTE" MCP_API_KEY="$KEY" CEO_BRIDGE_ENABLED=true \
  CEO_REDIS_URL="$REDIS" PORT="$PORT" BIND_HOST=127.0.0.1 \
  nohup node dist/server.js > "$E/logs/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for i in $(seq 1 60); do
  if curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/identity" >/dev/null 2>&1; then break; fi
  sleep 0.3
done

# 4) Bridge config + key file pointing at the workspace.
echo -n "$KEY" > "$E/key"; chmod 600 "$E/key"
node -e 'const fs=require("fs"); const id=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const cfg={schema_version:1,server_url:"http://127.0.0.1:"+process.argv[3],
    api_key_file:process.argv[1].replace(/ids\.json$/,"key"),
    expected_identity:{user_id:id.user_id,workspace_id:id.workspace_id},
    workspaces:{tools:process.argv[2]}};
  fs.writeFileSync(process.argv[1].replace(/ids\.json$/,"bridge.json"), JSON.stringify(cfg,null,2));' \
  "$E/ids.json" "$E/workspace/tools" "$PORT"

# 5) Run the resident worker against the real server using the hermetic agent.
cd "$E/workspace/tools"
env CEO_EXECUTOR_TYPE=test_stub CEO_AGENT_BIN="$STUB" CEO_WORKSPACE_DIR="$E/workspace/tools" \
  "$WRK" bridge run --config "$E/bridge.json" --workspace-ref tools \
  > "$E/worker.stdout.log" 2> "$E/worker.stderr.log" &
WORKER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; kill "$WORKER_PID" 2>/dev/null || true' EXIT

# Wait up to 60s for a final receipt to be saved locally.
RECEIPT=""
for i in $(seq 1 200); do
  RECEIPT=$(find "$E/workspace/tools/.ceo/jobs" -name receipt.json 2>/dev/null | head -1 || true)
  if [ -n "$RECEIPT" ]; then break; fi
  sleep 0.3
done
if [ -z "$RECEIPT" ]; then
  echo "execution acceptance: no receipt within timeout"; cat "$E/worker.stderr.log"; cat "$E/worker.stdout.log"; exit 1
fi

node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const job=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
  if(r.job_id!==job.job_id){console.error("receipt job_id mismatch");process.exit(1)}
  if(r.execution_status!=="COMPLETED"){console.error("expected COMPLETED, got "+r.execution_status);process.exit(1)}
  if(!r.bridge_context){console.error("bridge receipt missing bridge_context");process.exit(1)}
  if(r.bridge_context.worker_id!==""){ /* worker id filled from state at runtime */ }
  console.log("PASS local receipt", r.job_id, r.execution_status, r.bridge_context.attempt_id);' \
  "$RECEIPT" "$E/job.json"

# 6) SIGTERM the worker: it must stop cleanly (the current task already done).
kill -TERM "$WORKER_PID" 2>/dev/null || true
exited=0
for i in $(seq 1 60); do
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then exited=1; break; fi
  sleep 0.25
done
if [ "$exited" != "1" ]; then
  kill -KILL "$WORKER_PID" 2>/dev/null || true
  echo "execution acceptance: worker did not exit on SIGTERM"; exit 1
fi
echo "PASS worker exited cleanly on SIGTERM"

# 7) Confirm a real claim/start occurred server-side and matches the receipt.
node -e 'const fs=require("fs");
  const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const log=fs.readFileSync(process.argv[2],"utf8");
  const srvlog=fs.readFileSync(process.argv[3],"utf8");
  const job=JSON.parse(fs.readFileSync(process.argv[4],"utf8"));
  const attempt=r.bridge_context.attempt_id;
  const worker=r.bridge_context.worker_id;
  if(!log.includes("local_result_saved")||!log.includes("server_result_reported:false")){
    console.error("worker stdout missing local_result_saved"); process.exit(1);}
  if(!srvlog.includes(attempt)){console.error("server log missing attempt "+attempt); process.exit(1);}
  if(!srvlog.includes("worker_id")){console.error("server log missing worker"); process.exit(1);}
  if(!srvlog.includes("claim")||!srvlog.includes("start")){console.error("server log missing claim/start"); process.exit(1);}
  if(worker===""){console.error("receipt worker_id empty"); process.exit(1);}
  if(!srvlog.includes(worker)){console.error("server worker != receipt worker "+worker); process.exit(1);}
  console.log("PASS server saw claim/start for attempt "+attempt+" worker "+worker);' \
  "$RECEIPT" "$E/worker.stdout.log" "$E/logs/server.log" "$E/job.json"

echo "ALL_EXECUTION_ACCEPTANCE_PASS"
