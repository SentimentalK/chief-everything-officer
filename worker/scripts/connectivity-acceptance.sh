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
# It also asserts `bridge check` never sends claim/start/heartbeat and that the
# discovery request leaves the JobRecord, dedupe record, and Stream unchanged.
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

# 2) Submit a real task via the Server JobService owned by that identity, then
#    persist the EXACT submitted result (job_id, request_id, user_id,
#    workspace_id, workspace_ref, stream_entry_id) for later assertions.
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
  workspace_ref: "tools", prompt: "connectivity acceptance", acceptance: "done", timeout_seconds: 120 });
if (!res.ok) throw new Error("submit failed " + JSON.stringify(res));
const jobId = res.view.job_id;
const rec = await store.getJob(jobId);
if (!rec) throw new Error("job record missing after submit");
writeFileSync(process.env.JOB, JSON.stringify({
  job_id: jobId,
  request_id: rec.request_id,
  user_id: scope.user_id,
  workspace_id: scope.workspace_id,
  workspace_ref: rec.workspace_ref,
  stream_entry_id: rec.stream_entry_id,
}));
console.log("submitted", jobId, "entry", rec.stream_entry_id);
await runner.dispose();
'

# A reusable Redis probe: reads the JobRecord, the dedupe (request) record, and
# the Stream length, writing them to a snapshot file for before/after compares.
cat > "$E/probe.mjs" <<'PROBE'
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "redis";
import { pathToFileURL } from "node:url";
import path from "node:path";
const base = process.env.SRV;
const info = JSON.parse(readFileSync(process.env.JOB_FILE, "utf8"));
const storeMod = await import(pathToFileURL(path.join(base, "dist/jobs/redis-store.js")).href);
const runner = storeMod.createRedisRunnerFromClient(
  () => createClient({ url: process.env.REDIS, socket: { reconnectStrategy: false }, disableOfflineQueue: true }),
  { opTimeoutMs: 2500 });
const store = new storeMod.RedisJobStore(runner);
const wait = (ms=8000) => new Promise((res, rej) => { const s=Date.now();
  (function t(){ if (runner.ready()) return res(); if (Date.now()-s>ms) return rej(new Error("redis not ready")); setTimeout(t,20); })(); });
await wait();
const scope = { user_id: info.user_id, workspace_id: info.workspace_id };
const job = await store.getJob(info.job_id);
const dedupe = await store.getPlaceholder(scope, info.request_id);
const stream_length = await store.streamLength();
writeFileSync(process.env.PROBE_OUT, JSON.stringify({ job, dedupe, stream_length }));
await runner.dispose();
PROBE

snapshot() { # $1 = output snapshot file
  JOB_FILE="$E/job.json" PROBE_OUT="$1" SRV="$SRV" REDIS="$REDIS" node "$E/probe.mjs"
}

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

# 5) Snapshot the pre-execution Redis state and confirm the JobRecord is a
#    clean "queued" record with no execution attached.
snapshot "$E/before.json"
node -e 'const fs=require("fs");
  const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if (s.job.status!=="queued"){console.error("expected status queued");process.exit(1)}
  if ("execution" in s.job){console.error("execution must be absent before discovery");process.exit(1)}
  console.log("PASS pre-execution snapshot (queued, no execution)");' "$E/before.json"

echo "--- bridge check (expected PASS) ---"
OUT="$("$WRK" bridge check --config "$E/bridge.json" --workspace-ref tools --after 0-0)"
echo "$OUT"
node -e 'const fs=require("fs");
  const o=JSON.parse(process.argv[1]);
  const job=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
  const id=JSON.parse(fs.readFileSync(process.argv[3],"utf8"));
  if(!o.ok||!o.identity_verified){console.error("expected ok/identity_verified");process.exit(1)}
  if(o.user_id!==id.user_id||o.workspace_id!==id.workspace_id){console.error("identity mismatch vs temp DB");process.exit(1)}
  if(o.workspace_ref!=="tools"){console.error("workspace_ref not tools");process.exit(1)}
  if(o.workspace!==process.argv[4]){console.error("canonical workspace dir mismatch");process.exit(1)}
  if(o.jobs.length!==1){console.error("expected exactly one discovered job, got "+o.jobs.length);process.exit(1)}
  if(o.jobs[0].job_id!==job.job_id){console.error("discovered job != submitted job");process.exit(1)}
  if(o.next_cursor!==job.stream_entry_id){console.error("next_cursor != stream entry id");process.exit(1)}
  if(o.has_more!==false){console.error("single-task page must have has_more=false");process.exit(1)}
  console.log("PASS discovered", o.jobs[0].job_id, "cursor", o.next_cursor);' \
  "$OUT" "$E/job.json" "$E/ids.json" "$E/workspace/tools"

# 5b) Re-run discovery from the returned cursor: an empty, non-advancing page.
OUT2="$("$WRK" bridge check --config "$E/bridge.json" --workspace-ref tools --after "$(node -e 'const fs=require("fs");console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).stream_entry_id)' "$E/job.json")")"
echo "$OUT2"
node -e 'const fs=require("fs");
  const o=JSON.parse(process.argv[1]);
  const job=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
  if(!o.ok||o.identity_verified!==true){console.error("second check failed");process.exit(1)}
  if(o.jobs.length!==0){console.error("expected empty page");process.exit(1)}
  if(o.next_cursor!==job.stream_entry_id){console.error("cursor must stay unchanged on empty page");process.exit(1)}
  if(o.has_more!==false){console.error("empty page must have has_more=false");process.exit(1)}
  console.log("PASS second page empty and cursor stable");' \
  "$OUT2" "$E/job.json"

# 5c) Snapshot the post-execution Redis state and assert nothing changed.
snapshot "$E/after.json"
node -e 'const fs=require("fs");
  const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const b=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
  if ("execution" in a.job){console.error("execution must remain absent");process.exit(1)}
  if (JSON.stringify(a.job)!==JSON.stringify(b.job)){console.error("JobRecord changed by discovery");process.exit(1)}
  if (JSON.stringify(a.dedupe)!==JSON.stringify(b.dedupe)){console.error("dedupe record changed by discovery");process.exit(1)}
  if (a.stream_length!==b.stream_length){console.error("Stream length changed by discovery");process.exit(1)}
  console.log("PASS post-execution snapshot unchanged (job, dedupe, stream)");' \
  "$E/after.json" "$E/before.json"

# 6) Failure variants must exit non-zero.
wrong_key="$E/bridge-wrong-key.json"; cp "$E/bridge.json" "$wrong_key"
echo -n "not-the-key" > "$E/key-wrong"; chmod 600 "$E/key-wrong"
node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));c.api_key_file=process.argv[2];fs.writeFileSync(process.argv[1],JSON.stringify(c));' "$wrong_key" "$E/key-wrong"
if "$WRK" bridge check --config "$wrong_key" --workspace-ref tools >/dev/null 2>&1; then echo "wrong-key must fail"; exit 1; fi

wrong_identity="$E/bridge-wrong-id.json"; cp "$E/bridge.json" "$wrong_identity"
node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));c.expected_identity={user_id:"usr_00000000-0000-4000-8000-000000000000",workspace_id:"ws_00000000-0000-4000-8000-000000000000"};fs.writeFileSync(process.argv[1],JSON.stringify(c));' "$wrong_identity"
if "$WRK" bridge check --config "$wrong_identity" --workspace-ref tools >/dev/null 2>&1; then echo "wrong-identity must fail"; exit 1; fi

if "$WRK" bridge check --config "$E/bridge.json" --workspace-ref not-configured >/dev/null 2>&1; then echo "unknown alias must fail"; exit 1; fi

# 7) `bridge check` is read-only: it must never have issued claim/start/heartbeat.
if grep -qE '"(claim|start|heartbeat)"' "$E/logs/server.log"; then
  echo "bridge check must not issue claim/start/heartbeat"; exit 1
fi

echo "ALL_CONNECTIVITY_ACCEPTANCE_PASS"
