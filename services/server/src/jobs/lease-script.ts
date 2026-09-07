// services/server/src/jobs/lease-script.ts
//
// Shared, single-key Lua that implements inspect/claim/start/heartbeat for a
// job's execution lease. All operations touch only KEYS[1] = ceo:job:<job_id>;
// every other input arrives as ARGV. The script is fixed (never generated per
// task) and every non-trivial decision (deadline math, structural validation,
// state derivation) lives here — TypeScript only converts response fields and
// timestamps and never re-implements deadline logic.
//
// ARGV layout (1-indexed in Lua):
//   [1]  operation           'inspect' | 'claim' | 'start' | 'heartbeat'
//   [2]  expected_job_id
//   [3]  trusted_user_id     (from authenticated scope)
//   [4]  trusted_workspace_id
//   [5]  worker_id
//   [6]  attempt_id
//   [7]  workspace_ref       (claim only; empty for others / inspect)
//   [8]  lease_token_sha256  (never the raw token; inspect passes empty)
//   [9]  LEASE_DURATION_MS   (server constant, fixed)
//   [10] START_WINDOW_MS     (server constant, fixed)
//
// Returns a single cjson-encoded object string so the caller JSON.parses it.

export const LEASE_SCRIPT = `
local LEASE_DURATION = tonumber(ARGV[9])
local START_WINDOW   = tonumber(ARGV[10])

local operation         = ARGV[1]
local expected_job_id   = ARGV[2]
local trusted_user_id   = ARGV[3]
local trusted_workspace = ARGV[4]
local worker_id         = ARGV[5]
local attempt_id        = ARGV[6]
local workspace_ref     = ARGV[7]
local token_sha         = ARGV[8]

local function err(code, reason)
  return cjson.encode({ ok = false, code = code, reason = reason or cjson.null })
end

local function okRes(job, state, reason, replayed, server_time_ms)
  return cjson.encode({
    ok = true,
    record = job,
    server_time_ms = server_time_ms,
    state = state,
    reason = reason or cjson.null,
    replayed = replayed,
  })
end

-- 1. Key type check: allow none/string only; anything else is a corrupt record.
local t = redis.call('TYPE', KEYS[1])
local tt = type(t) == 'table' and t.ok or tostring(t)
if tt ~= 'none' and tt ~= 'string' then
  return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
end
if tt == 'none' then return err('JOB_NOT_FOUND', cjson.null) end

local raw = redis.call('GET', KEYS[1])
if not raw then return err('JOB_NOT_FOUND', cjson.null) end
local okj, job = pcall(cjson.decode, raw)
if not okj or type(job) ~= 'table' then
  return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
end

-- 4. Ownership + job identity FIRST (uniform not-found; no leak by error diff).
if job.job_id ~= expected_job_id
   or job.user_id ~= trusted_user_id
   or job.workspace_id ~= trusted_workspace then
  return err('JOB_NOT_FOUND', cjson.null)
end

-- Structural validation (core scalars for BOTH preparing and queued records).
if job.schema_version ~= 1 then return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD') end
if type(job.request_id) ~= 'string' then return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD') end
if type(job.request_digest) ~= 'string' then return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD') end
if type(job.status) ~= 'string' then return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD') end
if job.status ~= 'preparing' and job.status ~= 'queued' then
  return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
end
local streamOk = (job.stream_entry_id == nil or job.stream_entry_id == cjson.null)
  and true or (type(job.stream_entry_id) == 'string')
if not streamOk then return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD') end
if type(job.workspace_ref) ~= 'string' then return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD') end
if type(job.prompt) ~= 'string' then return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD') end
if type(job.acceptance) ~= 'string' then return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD') end
local toc = job.execution_timeout_seconds
if type(toc) ~= 'number' or toc % 1 ~= 0 or toc < 60 or toc > 7200 then
  return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
end
local cr = job.created_at_ms
local cd = job.claim_deadline_ms
if type(cr) ~= 'number' or cr % 1 ~= 0 then return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD') end
if type(cd) ~= 'number' or cd % 1 ~= 0 then return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD') end
if job.resource_id ~= nil and job.resource_id ~= cjson.null and type(job.resource_id) ~= 'string' then
  return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
end

-- Validate an existing execution whenever present.
local ex = job.execution
if ex ~= nil and ex ~= cjson.null then
  if type(ex) ~= 'table' then return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD') end
  if ex.phase ~= 'claimed' and ex.phase ~= 'running' then
    return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
  end
  if type(ex.worker_id) ~= 'string' then return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD') end
  if type(ex.attempt_id) ~= 'string' then return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD') end
  if type(ex.lease_token_sha256) ~= 'string'
     or string.len(ex.lease_token_sha256) ~= 64
     or string.find(ex.lease_token_sha256, '[^0-9a-f]') then
    return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
  end
  if type(ex.claimed_at_ms) ~= 'number' or ex.claimed_at_ms % 1 ~= 0 then
    return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
  end
  if type(ex.start_deadline_ms) ~= 'number' or ex.start_deadline_ms % 1 ~= 0 then
    return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
  end
  if type(ex.lease_expires_at_ms) ~= 'number' or ex.lease_expires_at_ms % 1 ~= 0 then
    return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
  end
  if ex.phase == 'claimed' then
    local sa = ex.started_at_ms
    local ed = ex.execution_deadline_ms
    local nullOK = (sa == nil or sa == cjson.null) and (ed == nil or ed == cjson.null)
    if not nullOK then return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD') end
    if ex.lease_expires_at_ms > ex.start_deadline_ms then
      return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
    end
  else
    if type(ex.started_at_ms) ~= 'number' or ex.started_at_ms % 1 ~= 0 then
      return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
    end
    if type(ex.execution_deadline_ms) ~= 'number' or ex.execution_deadline_ms % 1 ~= 0 then
      return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
    end
    if ex.lease_expires_at_ms > ex.execution_deadline_ms then
      return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
    end
  end
end

-- 5. Full-commit requirement (queued AND a committed stream entry).
local committed = job.status == 'queued'
  and type(job.stream_entry_id) == 'string'
  and job.stream_entry_id ~= ''
if not committed then
  return err('QUEUE_UNAVAILABLE', 'INCOMPLETE_SUBMISSION')
end

-- 6. Redis TIME drives every deadline decision (never client-supplied).
local ttime = redis.call('TIME')
local now = tonumber(ttime[1]) * 1000 + math.floor(tonumber(ttime[2]) / 1000)

-- Shared state derivation. Order matters:
--   no execution:       now>=claim_deadline -> expired ; else queued
--   phase=claimed:      now>=start_deadline -> interrupted(START_DEADLINE_EXCEEDED)
--                       ; now>=lease_expires -> interrupted(LEASE_EXPIRED) ; else claimed
--   phase=running:      now>=execution_deadline -> interrupted(EXECUTION_DEADLINE_EXCEEDED)
--                       ; now>=lease_expires    -> interrupted(LEASE_EXPIRED) ; else running
local function derive(j, n)
  local e = j.execution
  if e == nil or e == cjson.null then
    if n >= j.claim_deadline_ms then return 'expired', cjson.null end
    return 'queued', cjson.null
  end
  if e.phase == 'claimed' then
    if n >= e.start_deadline_ms then return 'interrupted', 'START_DEADLINE_EXCEEDED' end
    if n >= e.lease_expires_at_ms then return 'interrupted', 'LEASE_EXPIRED' end
    return 'claimed', cjson.null
  end
  if n >= e.execution_deadline_ms then return 'interrupted', 'EXECUTION_DEADLINE_EXCEEDED' end
  if n >= e.lease_expires_at_ms then return 'interrupted', 'LEASE_EXPIRED' end
  return 'running', cjson.null
end

-- 7. Operation preconditions + in-memory mutation; 8/9. one final SET only when
--    the record changed; 10. structured result.
if operation == 'inspect' then
  local st, rs = derive(job, now)
  return okRes(job, st, rs, false, now)
end

if operation == 'claim' then
  local e = job.execution
  if e == nil or e == cjson.null then
    -- Fresh claim: workspace_ref must match; 7-day claim window must not be up.
    if job.workspace_ref ~= workspace_ref then return err('WORKSPACE_MISMATCH', cjson.null) end
    if now >= job.claim_deadline_ms then return err('JOB_EXPIRED', cjson.null) end
    local nex = {
      worker_id = worker_id,
      attempt_id = attempt_id,
      lease_token_sha256 = token_sha,
      phase = 'claimed',
      claimed_at_ms = now,
      start_deadline_ms = now + START_WINDOW,
      lease_expires_at_ms = now + LEASE_DURATION,
      started_at_ms = cjson.null,
      execution_deadline_ms = cjson.null,
    }
    job.execution = nex
    redis.call('SET', KEYS[1], cjson.encode(job))
    return okRes(job, 'claimed', cjson.null, false, now)
  end
  -- Existing execution: replay/conflict handling (never reconsider 7-day window).
  if e.attempt_id ~= attempt_id then return err('JOB_ALREADY_CLAIMED', cjson.null) end
  if e.worker_id ~= worker_id or e.lease_token_sha256 ~= token_sha
     or job.workspace_ref ~= workspace_ref then
    return err('IDEMPOTENCY_CONFLICT', cjson.null)
  end
  local st, rs = derive(job, now)
  if st == 'interrupted' then return err('LEASE_EXPIRED', rs) end
  -- Full match and still valid: return the original task/execution; no write.
  return okRes(job, st, rs, true, now)
end

if operation == 'start' then
  local e = job.execution
  if e == nil or e == cjson.null then return err('JOB_NOT_CLAIMED', cjson.null) end
  if e.worker_id ~= worker_id or e.attempt_id ~= attempt_id or e.lease_token_sha256 ~= token_sha then
    return err('LEASE_MISMATCH', cjson.null)
  end
  local st, rs = derive(job, now)
  if st == 'interrupted' then return err('LEASE_EXPIRED', rs) end
  if e.phase == 'claimed' then
    e.phase = 'running'
    e.started_at_ms = now
    e.execution_deadline_ms = now + toc * 1000
    local cand = now + LEASE_DURATION
    if cand > e.execution_deadline_ms then cand = e.execution_deadline_ms end
    e.lease_expires_at_ms = cand
    job.execution = e
    redis.call('SET', KEYS[1], cjson.encode(job))
    return okRes(job, 'running', cjson.null, false, now)
  end
  -- Already running with valid credentials: replay; leave fields untouched.
  return okRes(job, st, rs, true, now)
end

if operation == 'heartbeat' then
  local e = job.execution
  if e == nil or e == cjson.null then return err('JOB_NOT_CLAIMED', cjson.null) end
  if e.worker_id ~= worker_id or e.attempt_id ~= attempt_id or e.lease_token_sha256 ~= token_sha then
    return err('LEASE_MISMATCH', cjson.null)
  end
  local st, rs = derive(job, now)
  if st == 'interrupted' then return err('LEASE_EXPIRED', rs) end
  local absDeadline = e.execution_deadline_ms
  if e.phase == 'claimed' then absDeadline = e.start_deadline_ms end
  local cand = now + LEASE_DURATION
  if cand > absDeadline then cand = absDeadline end
  if cand ~= e.lease_expires_at_ms then
    e.lease_expires_at_ms = cand
    job.execution = e
    redis.call('SET', KEYS[1], cjson.encode(job))
  end
  local st2, rs2 = derive(job, now)
  return okRes(job, st2, rs2, false, now)
end

return err('QUEUE_UNAVAILABLE', 'UNSUPPORTED_OPERATION')
`;

export const LEASE_OPERATIONS = ["inspect", "claim", "start", "heartbeat"] as const;
