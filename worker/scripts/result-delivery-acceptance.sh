#!/usr/bin/env bash
# Real Server + Redis proof that upload failure does not rerun execution:
# start → Server down → local receipt/history/outbox → Worker restart while
# Server is still offline → Server returns → pending report delivered → one attempt.
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

cd "$E/workspace/tools"
git init -q -b "$BRANCH" 2>/dev/null || git init -q
cat > AGENTS.md <<EOF
# Guidelines

<!-- ceo:metadata rule_marker: "DELIVERY-ACCEPT" -->

1. Respect boundaries.
EOF
echo -n "normal" > .stub_mode
git add -A
git -c user.email=t@e -c user.name=t commit -qm init 2>/dev/null || true

SRV="$SRV" DB="$E/data/identity/identity.sqlite" REMOTE="$REMOTE" BRANCH="$BRANCH" KEY="$KEY" IDS="$E/ids.json" \
node --input-type=module -e '
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
const store = await import(pathToFileURL(path.join(process.env.SRV, "dist/identity/store.js")).href);
const id = store.provisionEmptyIdentityDatabase(process.env.DB, {
  remoteUrl: process.env.REMOTE, branch: process.env.BRANCH,
  apiKeyDigest: store.sha256Hex(process.env.KEY),
});
writeFileSync(process.env.IDS, JSON.stringify(id));
'

cd "$SRV"
REDIS="$REDIS" IDS="$E/ids.json" SRV="$SRV" JOB="$E/job.json" \
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "redis";
import { pathToFileURL } from "node:url";
import path from "node:path";
const storeMod = await import(pathToFileURL(path.join(process.env.SRV, "dist/jobs/redis-store.js")).href);
const serviceMod = await import(pathToFileURL(path.join(process.env.SRV, "dist/jobs/service.js")).href);
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
const res = await svc.submit(scope, { request_id: "123e4567-e89b-12d3-a456-4266141740aa",
  workspace_ref: "tools",
  prompt: "[Step 3 - Fully Autonomous Execution: Task Execution]\nCreate output_artifact.txt with the exact bytes: delivery-nonce-4242",
  acceptance: "output_artifact.txt must contain delivery-nonce-4242", timeout_seconds: 120 });
if (!res.ok) throw new Error("submit failed " + JSON.stringify(res));
writeFileSync(process.env.JOB, JSON.stringify({ job_id: res.view.job_id }));
await runner.dispose();
'

start_server() {
  cd "$SRV"
  CEO_DATA_ROOT="$E/data" CEO_REMOTE="$REMOTE" MCP_API_KEY="$KEY" CEO_BRIDGE_ENABLED=true \
    CEO_REDIS_URL="$REDIS" PORT="$PORT" BIND_HOST=127.0.0.1 \
    nohup node dist/server.js > "$E/logs/server.log" 2>&1 &
  SERVER_PID=$!
  for i in $(seq 1 60); do
    if curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/identity" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.3
  done
  echo "result delivery acceptance: server did not start"
  return 1
}

stop_server() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    for i in $(seq 1 40); do
      if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
      sleep 0.1
    done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}

start_server
echo -n "$KEY" > "$E/key"; chmod 600 "$E/key"
node -e 'const fs=require("fs"); const id=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const cfg={schema_version:1,server_url:"http://127.0.0.1:"+process.argv[3],
    api_key_file:process.argv[1].replace(/ids\.json$/,"key"),
    expected_identity:{user_id:id.user_id,workspace_id:id.workspace_id},
    workspaces:{tools:process.argv[2]}};
  fs.writeFileSync(process.argv[1].replace(/ids\.json$/,"bridge.json"), JSON.stringify(cfg,null,2));' \
  "$E/ids.json" "$E/workspace/tools" "$PORT"
WS="$(node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(c.workspaces.tools)' "$E/bridge.json")"
JOB_ID="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).job_id)' "$E/job.json")"

cd "$WS"
env CEO_EXECUTOR_TYPE=test_stub CEO_AGENT_BIN="$STUB" CEO_WORKSPACE_DIR="$WS" \
  "$WRK" bridge run --config "$E/bridge.json" --workspace-ref tools \
  > "$E/worker.stdout.log" 2> "$E/worker.stderr.log" &
WORKER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; kill "$WORKER_PID" 2>/dev/null || true' EXIT

for i in $(seq 1 80); do
  if grep -q start "$E/logs/server.log"; then break; fi
  sleep 0.25
done
if ! grep -q start "$E/logs/server.log"; then
  echo "result delivery acceptance: start never appeared"
  cat "$E/worker.stderr.log"
  exit 1
fi

stop_server

RECEIPT=""
ATTEMPT=""
for i in $(seq 1 200); do
  RECEIPT=$(find "$WS/.ceo/jobs" -name receipt.json 2>/dev/null | head -1 || true)
  if [ -n "$RECEIPT" ]; then
    ATTEMPT="$(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(r.bridge_context&&r.bridge_context.attempt_id||"")' "$RECEIPT" || true)"
    if [ -n "${ATTEMPT:-}" ] \
      && [ -f "$WS/.ceo/bridge/history/${JOB_ID}.${ATTEMPT}.json" ] \
      && [ -f "$WS/.ceo/bridge/outbox/${JOB_ID}.${ATTEMPT}.json" ]; then
      ACTIVE="$(node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(s.active==null?"null":"set")' "$WS/.ceo/bridge/state.json" || true)"
      if [ "$ACTIVE" = "null" ]; then
        break
      fi
    fi
  fi
  sleep 0.3
done
if [ -z "$RECEIPT" ] || [ -z "${ATTEMPT:-}" ] || [ ! -f "$WS/.ceo/bridge/outbox/${JOB_ID}.${ATTEMPT}.json" ]; then
  echo "result delivery acceptance: local pending result not saved while Server was down"
  cat "$E/worker.stderr.log"
  cat "$E/worker.stdout.log"
  exit 1
fi

REDIS="$REDIS" SRV="$SRV" JOB="$E/job.json" node --input-type=module -e '
import { readFileSync } from "node:fs";
import { createClient } from "redis";
import { pathToFileURL } from "node:url";
import path from "node:path";
const storeMod = await import(pathToFileURL(path.join(process.env.SRV, "dist/jobs/redis-store.js")).href);
const runner = storeMod.createRedisRunnerFromClient(
  () => createClient({ url: process.env.REDIS, socket: { reconnectStrategy: false }, disableOfflineQueue: true }),
  { opTimeoutMs: 2500 });
const store = new storeMod.RedisJobStore(runner);
const wait = (ms=8000) => new Promise((res, rej) => { const s=Date.now();
  (function t(){ if (runner.ready()) return res(); if (Date.now()-s>ms) return rej(new Error("redis not ready")); setTimeout(t,20); })(); });
await wait();
const rec = await store.getJob(JSON.parse(readFileSync(process.env.JOB,"utf8")).job_id);
if (rec && rec.report) { console.error("report reached redis while server was supposed to be down"); process.exit(1); }
await runner.dispose();
'

kill -TERM "$WORKER_PID" 2>/dev/null || true
for i in $(seq 1 60); do
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then break; fi
  sleep 0.25
done
if kill -0 "$WORKER_PID" 2>/dev/null; then
  echo "result delivery acceptance: first worker did not exit"
  exit 1
fi
wait "$WORKER_PID" || true

env CEO_EXECUTOR_TYPE=test_stub CEO_AGENT_BIN="$STUB" CEO_WORKSPACE_DIR="$WS" \
  "$WRK" bridge run --config "$E/bridge.json" --workspace-ref tools \
  > "$E/worker2.stdout.log" 2> "$E/worker2.stderr.log" &
WORKER_PID=$!
sleep 2
if ! kill -0 "$WORKER_PID" 2>/dev/null; then
  echo "result delivery acceptance: worker exited while Server was still offline"
  cat "$E/worker2.stderr.log"
  exit 1
fi

start_server
trap 'kill "$SERVER_PID" 2>/dev/null || true; kill "$WORKER_PID" 2>/dev/null || true' EXIT

for i in $(seq 1 200); do
  if [ ! -f "$WS/.ceo/bridge/outbox/${JOB_ID}.${ATTEMPT}.json" ] \
    && grep -q 'server_result_reported' "$E/worker2.stdout.log"; then
    break
  fi
  sleep 0.3
done
if [ -f "$WS/.ceo/bridge/outbox/${JOB_ID}.${ATTEMPT}.json" ]; then
  echo "result delivery acceptance: pending outbox was not delivered after Server returned"
  cat "$E/worker2.stderr.log"
  cat "$E/worker2.stdout.log"
  exit 1
fi

ATTEMPTS="$(find "$WS/.ceo/jobs/$JOB_ID/attempts" -mindepth 1 -maxdepth 1 -type d | wc -l)"
if [ "$ATTEMPTS" != "1" ]; then
  echo "result delivery acceptance: expected one attempt, got $ATTEMPTS"
  exit 1
fi

REDIS="$REDIS" SRV="$SRV" JOB="$E/job.json" RECEIPT="$RECEIPT" node --input-type=module -e '
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createClient } from "redis";
import { pathToFileURL } from "node:url";
import path from "node:path";
const storeMod = await import(pathToFileURL(path.join(process.env.SRV, "dist/jobs/redis-store.js")).href);
const runner = storeMod.createRedisRunnerFromClient(
  () => createClient({ url: process.env.REDIS, socket: { reconnectStrategy: false }, disableOfflineQueue: true }),
  { opTimeoutMs: 2500 });
const store = new storeMod.RedisJobStore(runner);
const wait = (ms=8000) => new Promise((res, rej) => { const s=Date.now();
  (function t(){ if (runner.ready()) return res(); if (Date.now()-s>ms) return rej(new Error("redis not ready")); setTimeout(t,20); })(); });
await wait();
const rec = await store.getJob(JSON.parse(readFileSync(process.env.JOB,"utf8")).job_id);
const receiptBytes = readFileSync(process.env.RECEIPT);
if (!rec || !rec.report) { console.error("redis report missing after restart delivery"); process.exit(1); }
if (rec.report.receipt_sha256 !== createHash("sha256").update(receiptBytes).digest("hex")) {
  console.error("receipt hash mismatch after restart delivery");
  process.exit(1);
}
if (rec.report.business_outcome !== "UNVERIFIED") {
  console.error("expected UNVERIFIED");
  process.exit(1);
}
await runner.dispose();
console.log("PASS disconnect/restart delivered the same attempt without rerun");
'

kill -TERM "$WORKER_PID" 2>/dev/null || true
echo "ALL_RESULT_DELIVERY_ACCEPTANCE_PASS"
