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

# Workspace path comes from the same bridge.json the worker loaded.
WS="$(node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!c.workspaces||!c.workspaces.tools){process.stderr.write("bridge.json missing workspaces.tools\n"); process.exit(1)} process.stdout.write(c.workspaces.tools)' "$E/bridge.json")"

# 5) Run the resident worker against the real server using the hermetic agent.
cd "$WS"
env CEO_EXECUTOR_TYPE=test_stub CEO_AGENT_BIN="$STUB" CEO_WORKSPACE_DIR="$WS" \
  "$WRK" bridge run --config "$E/bridge.json" --workspace-ref tools \
  > "$E/worker.stdout.log" 2> "$E/worker.stderr.log" &
WORKER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; kill "$WORKER_PID" 2>/dev/null || true' EXIT

# Wait up to 60s for local completion: receipt, history, and cleared active.
RECEIPT=""
JOB_ID="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).job_id)' "$E/job.json")"
for i in $(seq 1 200); do
  RECEIPT=$(find "$WS/.ceo/jobs" -name receipt.json 2>/dev/null | head -1 || true)
  if [ -n "$RECEIPT" ]; then
    ATTEMPT="$(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const a=r.bridge_context&&r.bridge_context.attempt_id; if(!a){process.exit(2)} process.stdout.write(a)' "$RECEIPT" || true)"
    if [ -n "${ATTEMPT:-}" ] && [ -f "$WS/.ceo/bridge/history/${JOB_ID}.${ATTEMPT}.json" ]; then
      ACTIVE="$(node -e 'const fs=require("fs"); const p=process.argv[1]; if(!fs.existsSync(p)){process.exit(2)} const s=JSON.parse(fs.readFileSync(p,"utf8")); process.stdout.write(s.active===null||s.active===undefined?"null":"set")' "$WS/.ceo/bridge/state.json" || true)"
      if [ "$ACTIVE" = "null" ]; then
        break
      fi
    fi
  fi
  sleep 0.3
done
if [ -z "$RECEIPT" ] || [ -z "${ATTEMPT:-}" ] || [ ! -f "$WS/.ceo/bridge/history/${JOB_ID}.${ATTEMPT}.json" ] || [ "${ACTIVE:-}" != "null" ]; then
  echo "execution acceptance: receipt/history/cleared-active not ready within timeout"
  cat "$E/worker.stderr.log"
  cat "$E/worker.stdout.log"
  exit 1
fi

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
set +e
wait "$WORKER_PID"
worker_ec=$?
set -e
if [ "$worker_ec" != "0" ]; then
  echo "execution acceptance: worker exited $worker_ec"
  cat "$E/worker.stderr.log"
  exit 1
fi
echo "PASS worker exited cleanly on SIGTERM"

# 7) Confirm a real claim/start occurred server-side, matches Redis store, and active state cleared.
cd "$SRV"
REDIS="$REDIS" SRV="$SRV" RECEIPT="$RECEIPT" JOB="$E/job.json" WLOG="$E/worker.stdout.log" SLOG="$E/logs/server.log" \
  BRIDGE="$E/bridge.json" \
node --input-type=module -e '
import { readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { createClient } from "redis";
import { pathToFileURL } from "node:url";
import path from "node:path";

const base = process.env.SRV;
const storeMod = await import(pathToFileURL(path.join(base, "dist/jobs/redis-store.js")).href);
const bridge = JSON.parse(readFileSync(process.env.BRIDGE, "utf8"));
const ws = bridge.workspaces && bridge.workspaces.tools;
if (!ws) { console.error("bridge.json missing workspaces.tools"); process.exit(1); }
const statePath = path.join(ws, ".ceo", "bridge", "state.json");
const histDir = path.join(ws, ".ceo", "bridge", "history");
const artPath = path.join(ws, "output_artifact.txt");
const receiptBytes = readFileSync(process.env.RECEIPT);
const r = JSON.parse(receiptBytes);
const job = JSON.parse(readFileSync(process.env.JOB, "utf8"));
const log = readFileSync(process.env.WLOG, "utf8");
const srvlog = readFileSync(process.env.SLOG, "utf8");

const attempt = r.bridge_context?.attempt_id;
const worker = r.bridge_context?.worker_id;

if (r.job_id !== job.job_id) { console.error("receipt job_id mismatch"); process.exit(1); }
if (r.execution_status !== "COMPLETED") { console.error("expected COMPLETED, got " + r.execution_status); process.exit(1); }
if (r.business_outcome !== "UNVERIFIED") { console.error("expected UNVERIFIED, got " + r.business_outcome); process.exit(1); }
if (!attempt) { console.error("receipt missing attempt_id"); process.exit(1); }
if (!worker) { console.error("receipt missing worker_id"); process.exit(1); }

if (!log.includes("local_result_saved") || !log.includes("server_result_reported:false")) {
  console.error("worker stdout missing local_result_saved or server_result_reported:false");
  process.exit(1);
}
if (!srvlog.includes(attempt)) { console.error("server log missing attempt " + attempt); process.exit(1); }
if (!srvlog.includes(worker)) { console.error("server log missing worker " + worker); process.exit(1); }
if (!srvlog.includes("claim") || !srvlog.includes("start")) { console.error("server log missing claim/start"); process.exit(1); }

// Verify artifact exists and matches receipt
if (!existsSync(artPath)) { console.error("output artifact missing on disk"); process.exit(1); }
const artBytes = readFileSync(artPath);
const artStat = statSync(artPath);
const artSha = createHash("sha256").update(artBytes).digest("hex");

if (!Array.isArray(r.artifacts) || r.artifacts.length === 0) { console.error("receipt missing artifacts"); process.exit(1); }
const artClaim = r.artifacts.find(a => a.path === "output_artifact.txt");
if (!artClaim) { console.error("receipt missing output_artifact.txt claim"); process.exit(1); }
if (artClaim.size_bytes !== artStat.size) {
  console.error("artifact size mismatch");
  process.exit(1);
}
if (artClaim.sha256 !== artSha) {
  console.error("artifact sha256 mismatch");
  process.exit(1);
}

// Verify bridge state: active attempt must be cleared
if (!existsSync(statePath)) {
  console.error("bridge state.json missing on disk");
  process.exit(1);
}
const state = JSON.parse(readFileSync(statePath, "utf8"));
if (state.active !== null && state.active !== undefined) {
  console.error("bridge active state not cleared");
  process.exit(1);
}
if (state.worker_id !== worker) {
  console.error("bridge state worker_id mismatch");
  process.exit(1);
}

// Verify history record: must exist, match job/attempt, and hash receipt bytes
const histFile = path.join(histDir, `${job.job_id}.${attempt}.json`);
if (!existsSync(histFile)) {
  console.error("bridge history file missing on disk");
  process.exit(1);
}
const hist = JSON.parse(readFileSync(histFile, "utf8"));
if (hist.job_id !== job.job_id || hist.attempt_id !== attempt) {
  console.error("bridge history job/attempt mismatch");
  process.exit(1);
}
if (hist.worker_id !== worker) {
  console.error("bridge history worker_id mismatch");
  process.exit(1);
}
const receiptSha = createHash("sha256").update(receiptBytes).digest("hex");
if (typeof hist.receipt_sha256 !== "string" || hist.receipt_sha256 !== receiptSha) {
  console.error("bridge history receipt_sha256 does not match receipt bytes");
  process.exit(1);
}

// Connect to Redis and inspect the actual server JobRecord
const runner = storeMod.createRedisRunnerFromClient(
  () => createClient({ url: process.env.REDIS, socket: { reconnectStrategy: false }, disableOfflineQueue: true }),
  { opTimeoutMs: 2500 }
);
const store = new storeMod.RedisJobStore(runner);
const wait = (ms=8000) => new Promise((res, rej) => {
  const s = Date.now();
  (function t(){ if (runner.ready()) return res(); if (Date.now()-s>ms) return rej(new Error("redis not ready")); setTimeout(t,20); })();
});
await wait();

const rec = await store.getJob(job.job_id);
if (!rec) { console.error("job not found in redis: " + job.job_id); process.exit(1); }
if (!rec.execution) { console.error("job execution record missing in redis"); process.exit(1); }

if (rec.execution.phase !== "running") {
  console.error("expected redis execution phase to be running, got: " + rec.execution.phase);
  process.exit(1);
}
if (rec.execution.worker_id !== worker) {
  console.error(`worker_id mismatch: redis=${rec.execution.worker_id} receipt=${worker}`);
  process.exit(1);
}
if (rec.execution.attempt_id !== attempt) {
  console.error(`attempt_id mismatch: redis=${rec.execution.attempt_id} receipt=${attempt}`);
  process.exit(1);
}
if (typeof rec.execution.started_at_ms !== "number" || rec.execution.started_at_ms <= 0) {
  console.error("started_at_ms missing or invalid in redis: " + rec.execution.started_at_ms);
  process.exit(1);
}

await runner.dispose();
console.log("PASS redis store verified: phase=running, started_at_ms=" + rec.execution.started_at_ms + ", matching worker=" + worker + ", attempt=" + attempt);
'

# 8) Report the saved local result with the compiled command (worker already stopped).
STATE="$WS/.ceo/bridge/state.json"
HIST="$WS/.ceo/bridge/history/${JOB_ID}.${ATTEMPT}.json"
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const files = {
  receipt: process.argv[1],
  history: process.argv[2],
  state: process.argv[3],
};
const out = {};
for (const [k, p] of Object.entries(files)) {
  out[k] = createHash("sha256").update(readFileSync(p)).digest("hex");
}
writeFileSync(process.argv[4], JSON.stringify(out));
' "$RECEIPT" "$HIST" "$STATE" "$E/local-hashes.json"
CLAIM_BEFORE="$(grep -c '"event":"claim"' "$E/logs/server.log" || true)"
START_BEFORE="$(grep -c '"event":"start"' "$E/logs/server.log" || true)"

set +e
"$WRK" bridge report --config "$E/bridge.json" --workspace-ref tools --job-id "$JOB_ID" --attempt-id "$ATTEMPT" \
  > "$E/report1.stdout" 2> "$E/report1.stderr"
rep_ec=$?
set -e
if [ "$rep_ec" != "0" ]; then
  echo "execution acceptance: first bridge report exited $rep_ec"
  cat "$E/report1.stderr"
  cat "$E/report1.stdout"
  exit 1
fi
if grep -qiE 'api[_-]?key|authorization|claim_token|test-secret|acceptance-nonce' "$E/report1.stdout" "$E/report1.stderr"; then
  echo "execution acceptance: report output leaked a secret"
  exit 1
fi

cd "$SRV"
REDIS="$REDIS" SRV="$SRV" RECEIPT="$RECEIPT" JOB="$E/job.json" \
  REPORT_OUT="$E/report1.stdout" ATTEMPT="$ATTEMPT" \
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createClient } from "redis";
import { pathToFileURL } from "node:url";
import path from "node:path";

const first = JSON.parse(readFileSync(process.env.REPORT_OUT, "utf8"));
if (first.ok !== true || first.report_received !== true || first.replayed !== false) {
  console.error("first report confirmation invalid: " + JSON.stringify(first));
  process.exit(1);
}
const job = JSON.parse(readFileSync(process.env.JOB, "utf8"));
const receiptBytes = readFileSync(process.env.RECEIPT);
const receipt = JSON.parse(receiptBytes);
if (first.job_id !== job.job_id || first.attempt_id !== process.env.ATTEMPT) {
  console.error("report confirmation identity mismatch");
  process.exit(1);
}
if (first.state !== "completed") {
  console.error("expected completed, got " + first.state);
  process.exit(1);
}

const storeMod = await import(pathToFileURL(path.join(process.env.SRV, "dist/jobs/redis-store.js")).href);
const runner = storeMod.createRedisRunnerFromClient(
  () => createClient({ url: process.env.REDIS, socket: { reconnectStrategy: false }, disableOfflineQueue: true }),
  { opTimeoutMs: 2500 }
);
const store = new storeMod.RedisJobStore(runner);
const wait = (ms=8000) => new Promise((res, rej) => {
  const s = Date.now();
  (function t(){ if (runner.ready()) return res(); if (Date.now()-s>ms) return rej(new Error("redis not ready")); setTimeout(t,20); })();
});
await wait();
const rec = await store.getJob(job.job_id);
if (!rec || !rec.report) { console.error("redis report missing after first report"); process.exit(1); }
const receiptSha = createHash("sha256").update(receiptBytes).digest("hex");
const finishedMs = Date.parse(receipt.timestamps.finished_at);
if (rec.report.execution_status !== "COMPLETED") { console.error("redis execution_status mismatch"); process.exit(1); }
if (rec.report.receipt_sha256 !== receiptSha) { console.error("redis receipt hash mismatch"); process.exit(1); }
if (rec.report.finished_at_ms !== finishedMs) { console.error("redis finished_at_ms mismatch: " + rec.report.finished_at_ms + " vs " + finishedMs); process.exit(1); }
if (first.received_at !== new Date(rec.report.received_at_ms).toISOString()) {
  console.error("received_at mismatch");
  process.exit(1);
}
await runner.dispose();
console.log("PASS first report persisted in redis received_at=" + first.received_at);
'

set +e
"$WRK" bridge report --config "$E/bridge.json" --workspace-ref tools --job-id "$JOB_ID" --attempt-id "$ATTEMPT" \
  > "$E/report2.stdout" 2> "$E/report2.stderr"
rep2_ec=$?
set -e
if [ "$rep2_ec" != "0" ]; then
  echo "execution acceptance: replay bridge report exited $rep2_ec"
  cat "$E/report2.stderr"
  exit 1
fi

node --input-type=module -e '
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
const first = JSON.parse(readFileSync(process.argv[1], "utf8"));
const second = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (second.ok !== true || second.report_received !== true || second.replayed !== true) {
  console.error("replay confirmation invalid: " + JSON.stringify(second));
  process.exit(1);
}
if (second.received_at !== first.received_at) {
  console.error("replay changed received_at");
  process.exit(1);
}
const expected = JSON.parse(readFileSync(process.argv[3], "utf8"));
const files = { receipt: process.argv[4], history: process.argv[5], state: process.argv[6] };
for (const [k, p] of Object.entries(files)) {
  const now = createHash("sha256").update(readFileSync(p)).digest("hex");
  if (now !== expected[k]) {
    console.error("local " + k + " hash changed after report");
    process.exit(1);
  }
}
const histDir = process.argv[7];
const histFiles = readdirSync(histDir).filter((n) => n.endsWith(".json"));
if (histFiles.length !== 1) {
  console.error("unexpected extra history files: " + histFiles.join(","));
  process.exit(1);
}
' "$E/report1.stdout" "$E/report2.stdout" "$E/local-hashes.json" "$RECEIPT" "$HIST" "$STATE" "$WS/.ceo/bridge/history"

CLAIM_AFTER="$(grep -c '"event":"claim"' "$E/logs/server.log" || true)"
START_AFTER="$(grep -c '"event":"start"' "$E/logs/server.log" || true)"
if [ "$CLAIM_AFTER" != "$CLAIM_BEFORE" ] || [ "$START_AFTER" != "$START_BEFORE" ]; then
  echo "execution acceptance: report issued extra claim/start"
  exit 1
fi
echo "PASS report replayed without rewriting local files or re-claiming"

echo "ALL_EXECUTION_ACCEPTANCE_PASS"
