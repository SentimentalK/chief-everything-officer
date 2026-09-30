/**
 * Lua scripts for Job V2 submission and Attempt lifecycle coordination.
 * All state mutations use Redis TIME as the authoritative source of clock time.
 */

export const V2_CREATE_JOB_SCRIPT = `
local function badtype(key, ok)
  local t = redis.call('TYPE', key)
  local tt = type(t) == 'table' and t.ok or tostring(t)
  if (tt ~= 'none') and (tt ~= ok) then return true end
  return false
end

if badtype(KEYS[1], 'string') then
  return redis.error_reply('WRONGTYPE_REQ_KEY')
end

local existing_job_id = redis.call('GET', KEYS[1])
if existing_job_id then
  return cjson.encode({ status = 'existing_request', job_id = existing_job_id })
end

if badtype(KEYS[2], 'string') then
  return redis.error_reply('WRONGTYPE_JOB_KEY')
end
if badtype(KEYS[3], 'stream') then
  return redis.error_reply('WRONGTYPE_STREAM_KEY')
end
if badtype(KEYS[4], 'zset') then
  return redis.error_reply('WRONGTYPE_TARGET_QUEUE')
end

-- New submission: verify Key 2 does not already exist (job_id collision protection)
local t2 = redis.call('TYPE', KEYS[2])
local tt2 = type(t2) == 'table' and t2.ok or tostring(t2)
if tt2 ~= 'none' then
  return cjson.encode({ error = 'JOB_ID_COLLISION' })
end

local okp, prep = pcall(cjson.decode, ARGV[8])
if not okp then
  return cjson.encode({ error = 'MALFORMED_JOB_RECORD' })
end

-- Validations complete. Begin atomic writes:
redis.call('SET', KEYS[1], ARGV[1])
prep.status = 'preparing'
prep.stream_entry_id = cjson.null
prep.latest_attempt_id = cjson.null
redis.call('SET', KEYS[2], cjson.encode(prep))

local entry = redis.call('XADD', KEYS[3], '*',
  'schema_version', '2',
  'job_id', ARGV[1],
  'user_id', ARGV[2],
  'workspace_id', ARGV[3],
  'target_id', ARGV[4],
  'created_at_ms', ARGV[5])

redis.call('ZADD', KEYS[4], ARGV[5], ARGV[1])

prep.status = 'queued'
prep.stream_entry_id = entry
prep.latest_attempt_id = cjson.null
redis.call('SET', KEYS[2], cjson.encode(prep))

return cjson.encode({ status = 'created', job_id = ARGV[1], stream_entry_id = entry })
`;

export const V2_CLAIM_JOB_SCRIPT = `
local function badtype(key, ok)
  local t = redis.call('TYPE', key)
  local tt = type(t) == 'table' and t.ok or tostring(t)
  if (tt ~= 'none') and (tt ~= ok) then return true end
  return false
end

if badtype(KEYS[1], 'string') then
  return redis.error_reply('WRONGTYPE_JOB_KEY')
end
-- Target queue may be 'none' or 'zset' (ZREM of last item deletes the key)
if badtype(KEYS[2], 'zset') then
  return redis.error_reply('WRONGTYPE_TARGET_QUEUE')
end
if badtype(KEYS[3], 'zset') then
  return redis.error_reply('WRONGTYPE_JOB_ATTEMPTS')
end
if badtype(KEYS[4], 'string') then
  return redis.error_reply('WRONGTYPE_ATTEMPT_KEY')
end

local time_parts = redis.call('TIME')
local now_ms = tonumber(time_parts[1]) * 1000 + math.floor(tonumber(time_parts[2]) / 1000)

local job_raw = redis.call('GET', KEYS[1])
if not job_raw then
  return cjson.encode({ error = 'JOB_NOT_FOUND' })
end
local okj, job = pcall(cjson.decode, job_raw)
if not okj then
  return cjson.encode({ error = 'MALFORMED_JOB_RECORD' })
end

if job.job_id ~= ARGV[1] or job.workspace_id ~= ARGV[2] or job.target_id ~= ARGV[3] then
  return cjson.encode({ error = 'JOB_NOT_FOUND' })
end

-- Replay check
if job.latest_attempt_id == ARGV[6] then
  local att_raw = redis.call('GET', KEYS[4])
  if not att_raw then
    return cjson.encode({ error = 'CORRUPT_ATTEMPT_RECORD' })
  end
  local oka, attempt = pcall(cjson.decode, att_raw)
  if not oka then
    return cjson.encode({ error = 'CORRUPT_ATTEMPT_RECORD' })
  end
  if attempt.attempt_id ~= ARGV[6] or
     attempt.job_id ~= ARGV[1] or
     attempt.workspace_id ~= ARGV[2] or
     attempt.target_id ~= ARGV[3] or
     attempt.device_id ~= ARGV[4] or
     attempt.claim_token_sha256 ~= ARGV[7] then
    return cjson.encode({ error = 'IDEMPOTENCY_CONFLICT' })
  end
  if attempt.phase == 'claimed' or attempt.phase == 'running' then
    return cjson.encode({ status = 'replayed', attempt = attempt, server_time_ms = now_ms })
  end
  if attempt.phase == 'terminal' then
    return cjson.encode({ error = 'JOB_FINISHED' })
  end
  return cjson.encode({ error = 'IDEMPOTENCY_CONFLICT' })
end

-- New claim path
if ARGV[8] == '1' then
  return cjson.encode({ error = 'NOT_OWNER_REPLAY' })
end

if job.status ~= 'queued' then
  return cjson.encode({ error = 'JOB_ALREADY_CLAIMED' })
end

if job.claim_deadline_ms and job.claim_deadline_ms > 0 and now_ms >= job.claim_deadline_ms then
  redis.call('ZREM', KEYS[2], ARGV[1])
  return cjson.encode({ error = 'JOB_EXPIRED' })
end

local t4 = redis.call('TYPE', KEYS[4])
local tt4 = type(t4) == 'table' and t4.ok or tostring(t4)
if tt4 ~= 'none' then
  return cjson.encode({ error = 'ATTEMPT_ID_COLLISION' })
end

local attempt = {
  schema_version = 1,
  attempt_id = ARGV[6],
  job_id = job.job_id,
  user_id = job.user_id,
  workspace_id = job.workspace_id,
  target_id = job.target_id,
  device_id = ARGV[4],
  target_binding_id = ARGV[5],
  claim_token_sha256 = ARGV[7],
  phase = 'claimed',
  claimed_at_ms = now_ms,
  started_at_ms = cjson.null
}

redis.call('SET', KEYS[4], cjson.encode(attempt))
redis.call('ZADD', KEYS[3], now_ms, ARGV[6])

job.status = 'active'
job.latest_attempt_id = ARGV[6]
redis.call('SET', KEYS[1], cjson.encode(job))

redis.call('ZREM', KEYS[2], ARGV[1])

return cjson.encode({ status = 'claimed', attempt = attempt, server_time_ms = now_ms })
`;

export const V2_START_JOB_SCRIPT = `
local function badtype(key, ok)
  local t = redis.call('TYPE', key)
  local tt = type(t) == 'table' and t.ok or tostring(t)
  if (tt ~= 'none') and (tt ~= ok) then return true end
  return false
end

if badtype(KEYS[1], 'string') then
  return redis.error_reply('WRONGTYPE_JOB_KEY')
end
if badtype(KEYS[2], 'string') then
  return redis.error_reply('WRONGTYPE_ATTEMPT_KEY')
end

local time_parts = redis.call('TIME')
local now_ms = tonumber(time_parts[1]) * 1000 + math.floor(tonumber(time_parts[2]) / 1000)

local job_raw = redis.call('GET', KEYS[1])
if not job_raw then
  return cjson.encode({ error = 'JOB_NOT_FOUND' })
end
local okj, job = pcall(cjson.decode, job_raw)
if not okj then
  return cjson.encode({ error = 'MALFORMED_JOB_RECORD' })
end

local att_raw = redis.call('GET', KEYS[2])
if not att_raw then
  return cjson.encode({ error = 'ATTEMPT_NOT_FOUND' })
end
local oka, attempt = pcall(cjson.decode, att_raw)
if not oka then
  return cjson.encode({ error = 'CORRUPT_ATTEMPT_RECORD' })
end

if attempt.schema_version ~= 1 or
   type(attempt.claimed_at_ms) ~= 'number' or
   type(attempt.target_binding_id) ~= 'string' or attempt.target_binding_id == '' or
   type(attempt.claim_token_sha256) ~= 'string' or string.len(attempt.claim_token_sha256) ~= 64 then
  return cjson.encode({ error = 'CORRUPT_ATTEMPT_RECORD' })
end

if attempt.phase == 'claimed' and (attempt.started_at_ms ~= nil and attempt.started_at_ms ~= cjson.null) then
  return cjson.encode({ error = 'CORRUPT_ATTEMPT_RECORD' })
end
if attempt.phase == 'running' and type(attempt.started_at_ms) ~= 'number' then
  return cjson.encode({ error = 'CORRUPT_ATTEMPT_RECORD' })
end

if job.status ~= 'active' or job.latest_attempt_id ~= ARGV[1] then
  return cjson.encode({ error = 'JOB_NOT_ACTIVE' })
end

if attempt.attempt_id ~= ARGV[1] or
   attempt.job_id ~= job.job_id or
   attempt.workspace_id ~= job.workspace_id or
   attempt.target_id ~= job.target_id or
   attempt.device_id ~= ARGV[2] or
   attempt.claim_token_sha256 ~= ARGV[3] then
  return cjson.encode({ error = 'IDENTITY_MISMATCH' })
end

if attempt.phase == 'running' then
  return cjson.encode({ status = 'replayed', attempt = attempt, server_time_ms = now_ms })
end

if attempt.phase ~= 'claimed' then
  return cjson.encode({ error = 'INVALID_ATTEMPT_PHASE', phase = attempt.phase })
end

attempt.phase = 'running'
attempt.started_at_ms = now_ms
redis.call('SET', KEYS[2], cjson.encode(attempt))

return cjson.encode({ status = 'started', attempt = attempt, server_time_ms = now_ms })
`;

export const V2_REPORT_JOB_SCRIPT = `
local function badtype(key, ok)
  local t = redis.call('TYPE', key)
  local tt = type(t) == 'table' and t.ok or tostring(t)
  if (tt ~= 'none') and (tt ~= ok) then return true end
  return false
end

if badtype(KEYS[1], 'string') then
  return redis.error_reply('WRONGTYPE_JOB_KEY')
end
if badtype(KEYS[2], 'string') then
  return redis.error_reply('WRONGTYPE_ATTEMPT_KEY')
end

local time_parts = redis.call('TIME')
local now_ms = tonumber(time_parts[1]) * 1000 + math.floor(tonumber(time_parts[2]) / 1000)

local job_raw = redis.call('GET', KEYS[1])
if not job_raw then
  return cjson.encode({ error = 'JOB_NOT_FOUND' })
end
local okj, job = pcall(cjson.decode, job_raw)
if not okj then
  return cjson.encode({ error = 'MALFORMED_JOB_RECORD' })
end

local att_raw = redis.call('GET', KEYS[2])
if not att_raw then
  return cjson.encode({ error = 'ATTEMPT_NOT_FOUND' })
end
local oka, attempt = pcall(cjson.decode, att_raw)
if not oka then
  return cjson.encode({ error = 'CORRUPT_ATTEMPT_RECORD' })
end

if attempt.schema_version ~= 1 or
   type(attempt.claimed_at_ms) ~= 'number' or
   type(attempt.target_binding_id) ~= 'string' or attempt.target_binding_id == '' or
   type(attempt.claim_token_sha256) ~= 'string' or string.len(attempt.claim_token_sha256) ~= 64 then
  return cjson.encode({ error = 'CORRUPT_ATTEMPT_RECORD' })
end

if attempt.phase == 'claimed' and (attempt.started_at_ms ~= nil and attempt.started_at_ms ~= cjson.null) then
  return cjson.encode({ error = 'CORRUPT_ATTEMPT_RECORD' })
end
if attempt.phase == 'running' and type(attempt.started_at_ms) ~= 'number' then
  return cjson.encode({ error = 'CORRUPT_ATTEMPT_RECORD' })
end

if job.latest_attempt_id ~= ARGV[1] then
  return cjson.encode({ error = 'ATTEMPT_MISMATCH' })
end
if job.status ~= 'active' and job.status ~= 'terminal' then
  return cjson.encode({ error = 'INVALID_JOB_STATUS', status = job.status })
end
if attempt.attempt_id ~= ARGV[1] or
   attempt.job_id ~= job.job_id or
   attempt.workspace_id ~= job.workspace_id or
   attempt.target_id ~= job.target_id or
   attempt.device_id ~= ARGV[2] or
   attempt.claim_token_sha256 ~= ARGV[3] then
  return cjson.encode({ error = 'IDENTITY_MISMATCH' })
end

local okr, rep = pcall(cjson.decode, ARGV[4])
if not okr or type(rep) ~= 'table' then
  return cjson.encode({ error = 'MALFORMED_REPORT' })
end

-- Validate report invariants
if rep.schema_version ~= 2 then
  return cjson.encode({ error = 'INVALID_REPORT_SCHEMA_VERSION' })
end

local valid_exec_statuses = {
  COMPLETED = true, FAILED = true, TIMED_OUT = true,
  CANCELLED = true, BLOCKED = true, INTERRUPTED = true
}
if not valid_exec_statuses[rep.execution_status] then
  return cjson.encode({ error = 'INVALID_EXECUTION_STATUS' })
end

local valid_outcomes = { UNVERIFIED = true, FAILED = true, NOT_STARTED = true }
if not valid_outcomes[rep.business_outcome] then
  return cjson.encode({ error = 'INVALID_BUSINESS_OUTCOME' })
end

if type(rep.task_dispatched) ~= 'boolean' then
  return cjson.encode({ error = 'INVALID_TASK_DISPATCHED' })
end

if type(rep.finished_at_ms) ~= 'number' or rep.finished_at_ms < 0 then
  return cjson.encode({ error = 'INVALID_REPORT_FINISHED_AT' })
end

if type(rep.duration_ms) ~= 'number' or rep.duration_ms < 0 then
  return cjson.encode({ error = 'INVALID_REPORT_DURATION' })
end

if type(rep.receipt_sha256) ~= 'string' or string.len(rep.receipt_sha256) ~= 64 then
  return cjson.encode({ error = 'INVALID_REPORT_RECEIPT_SHA256' })
end

if type(rep.executor) ~= 'table' or type(rep.executor.type) ~= 'string' or type(rep.executor.version) ~= 'string' then
  return cjson.encode({ error = 'INVALID_REPORT_EXECUTOR' })
end

if rep.execution_status == 'COMPLETED' and (rep.error ~= nil and rep.error ~= cjson.null) then
  return cjson.encode({ error = 'COMPLETED_REPORT_HAS_ERROR' })
end

if rep.execution_status ~= 'COMPLETED' then
  if type(rep.error) ~= 'table' or type(rep.error.stage) ~= 'string' or type(rep.error.code) ~= 'string' or type(rep.error.message) ~= 'string' then
    return cjson.encode({ error = 'INVALID_REPORT_ERROR_SHAPE' })
  end
end

if not rep.task_dispatched and rep.business_outcome ~= 'NOT_STARTED' then
  return cjson.encode({ error = 'UNDISPATCHED_REPORT_OUTCOME_INVALID' })
end

if rep.business_outcome == 'UNVERIFIED' and not rep.task_dispatched then
  return cjson.encode({ error = 'UNVERIFIED_OUTCOME_REQUIRES_DISPATCHED' })
end

-- Replay check for terminal attempt
if attempt.phase == 'terminal' then
  local ar = attempt.report
  if not ar then
    return cjson.encode({ error = 'CORRUPT_ATTEMPT_RECORD' })
  end
  local function error_match(e1, e2)
    if (e1 == nil or e1 == cjson.null) and (e2 == nil or e2 == cjson.null) then return true end
    if (e1 == nil or e1 == cjson.null) or (e2 == nil or e2 == cjson.null) then return false end
    return e1.stage == e2.stage and e1.code == e2.code and e1.message == e2.message
  end
  local function executor_match(ex1, ex2)
    if not ex1 or not ex2 then return false end
    return ex1.type == ex2.type and ex1.version == ex2.version
  end

  local sem_match = (
    ar.schema_version == rep.schema_version and
    ar.execution_status == rep.execution_status and
    ar.business_outcome == rep.business_outcome and
    ar.task_dispatched == rep.task_dispatched and
    ar.finished_at_ms == rep.finished_at_ms and
    ar.duration_ms == rep.duration_ms and
    ar.receipt_sha256 == rep.receipt_sha256 and
    executor_match(ar.executor, rep.executor) and
    error_match(ar.error, rep.error)
  )

  if sem_match then
    return cjson.encode({ status = 'replayed', server_time_ms = now_ms })
  else
    return cjson.encode({ error = 'REPORT_CONFLICT' })
  end
end

-- Transition validation
if job.status ~= 'active' then
  return cjson.encode({ error = 'INVALID_JOB_STATUS', status = job.status })
end

if not rep.task_dispatched then
  -- Allowed from claimed or running
  if attempt.phase ~= 'claimed' and attempt.phase ~= 'running' then
    return cjson.encode({ error = 'INVALID_ATTEMPT_PHASE', phase = attempt.phase })
  end
else
  -- Dispatched report requires running
  if attempt.phase ~= 'running' or attempt.started_at_ms == nil or attempt.started_at_ms == cjson.null then
    return cjson.encode({ error = 'DISPATCHED_REPORT_REQUIRES_RUNNING' })
  end
end

rep.received_at_ms = now_ms
attempt.phase = 'terminal'
attempt.report = rep
job.status = 'terminal'

redis.call('SET', KEYS[2], cjson.encode(attempt))
redis.call('SET', KEYS[1], cjson.encode(job))

return cjson.encode({ status = 'reported', server_time_ms = now_ms })
`;

// ---------------------------------------------------------------------------
// Wave 2B: operator cancel.
//
// Server-authoritative, idempotent job cancel with explicit per-state
// semantics. No queue keys are deleted as a cancel mechanism: the queued
// branch performs the same orderly ZREM the claim path performs, and the
// active branch terminalizes the CURRENT attempt in place (never creates a
// second attempt).
//
// KEYS: [jobKey, attemptKey(latest attempt or sentinel), targetQueueKey]
// ARGS: [expectedAttemptId('' when job should have none), deviceId, reason, cancelReceiptSha256]
//
// Outcomes:
// - queued (+ expired-unclaimed): terminalize immediately, no attempt, attach cancel record.
// - active (claimed/running): terminalize the current attempt with a synthetic
//   CANCELLED report; attach cancel record. A late runner report deterministically
//   loses: the report script sees a terminal attempt with a different report and
//   returns REPORT_CONFLICT.
// - terminal: no mutation. already-cancelled replays as 'replayed'; any other
//   terminal outcome returns 'no_change' so history is never rewritten.
// - CANCEL_RACE: caller's pre-read of the job went stale (claim landed between
//   read and script). Caller re-reads and retries; no state was mutated.
// ---------------------------------------------------------------------------
export const V2_CANCEL_JOB_SCRIPT = `
local function badtype(key, ok)
  local t = redis.call('TYPE', key)
  local tt = type(t) == 'table' and t.ok or tostring(t)
  if (tt ~= 'none') and (tt ~= ok) then return true end
  return false
end

if badtype(KEYS[1], 'string') then
  return redis.error_reply('WRONGTYPE_JOB_KEY')
end
if badtype(KEYS[2], 'string') then
  return redis.error_reply('WRONGTYPE_ATTEMPT_KEY')
end
-- Target queue may be 'none' or 'zset' (ZREM of last item deletes the key)
if badtype(KEYS[3], 'zset') then
  return redis.error_reply('WRONGTYPE_TARGET_QUEUE')
end

local time_parts = redis.call('TIME')
local now_ms = tonumber(time_parts[1]) * 1000 + math.floor(tonumber(time_parts[2]) / 1000)

local job_raw = redis.call('GET', KEYS[1])
if not job_raw then
  return cjson.encode({ error = 'JOB_NOT_FOUND' })
end
local okj, job = pcall(cjson.decode, job_raw)
if not okj then
  return cjson.encode({ error = 'CORRUPT_JOB_RECORD' })
end

-- Normalize cjson.null to nil for optional fields
local latest_attempt = job.latest_attempt_id
if latest_attempt == cjson.null then latest_attempt = nil end
local existing_cancel = job.cancel
if existing_cancel == cjson.null then existing_cancel = nil end

-- Terminal: idempotent no-mutation outcomes
if job.status == 'terminal' then
  if latest_attempt then
    local att_raw = redis.call('GET', KEYS[2])
    if not att_raw then
      return cjson.encode({ error = 'CORRUPT_ATTEMPT_RECORD' })
    end
    local oka, attempt = pcall(cjson.decode, att_raw)
    if not oka or attempt.phase ~= 'terminal' or not attempt.report then
      return cjson.encode({ error = 'CORRUPT_ATTEMPT_RECORD' })
    end
    if attempt.report.execution_status == 'CANCELLED' then
      return cjson.encode({ status = 'replayed', result = 'already_cancelled', execution_status = 'CANCELLED', business_outcome = attempt.report.business_outcome, attempt_id = attempt.attempt_id, server_time_ms = now_ms })
    end
    return cjson.encode({ status = 'no_change', result = 'already_terminal', execution_status = attempt.report.execution_status, business_outcome = attempt.report.business_outcome, attempt_id = attempt.attempt_id, server_time_ms = now_ms })
  end
  if existing_cancel then
    return cjson.encode({ status = 'replayed', result = 'already_cancelled', execution_status = 'CANCELLED', business_outcome = 'NOT_STARTED', attempt_id = cjson.null, server_time_ms = now_ms })
  end
  return cjson.encode({ error = 'CORRUPT_JOB_RECORD' })
end

if job.status == 'preparing' then
  return cjson.encode({ error = 'INVALID_JOB_STATUS', status = job.status })
end

-- Race guard: the caller derived the attempt linkage from a pre-read. If the
-- linkage changed (e.g. a claim landed), retry with a fresh read instead of
-- acting on the wrong attempt key.
local expected_attempt_id = ARGV[1]
if (latest_attempt or '') ~= expected_attempt_id then
  return cjson.encode({ error = 'CANCEL_RACE' })
end

local cancel_record = {
  cancelled_at_ms = now_ms,
  requested_by_device_id = ARGV[2],
  reason = ARGV[3]
}

-- Claimed/running: authoritative operator terminalization of the CURRENT attempt.
if job.status == 'active' then
  local att_raw = redis.call('GET', KEYS[2])
  if not att_raw then
    return cjson.encode({ error = 'CORRUPT_ATTEMPT_RECORD' })
  end
  local oka, attempt = pcall(cjson.decode, att_raw)
  if not oka then
    return cjson.encode({ error = 'CORRUPT_ATTEMPT_RECORD' })
  end
  if attempt.job_id ~= job.job_id or attempt.attempt_id ~= job.latest_attempt_id then
    return cjson.encode({ error = 'CORRUPT_ATTEMPT_RECORD' })
  end
  if attempt.phase ~= 'claimed' and attempt.phase ~= 'running' then
    return cjson.encode({ error = 'INVALID_ATTEMPT_PHASE', phase = attempt.phase })
  end

  -- The server-visible attempt phase is the dispatch truth: 'running' means
  -- the runner already reported start (dispatch accepted); 'claimed' means
  -- execution had not started server-side.
  local task_dispatched = attempt.phase == 'running'
  local duration_ms = 0
  if task_dispatched then
    if type(attempt.started_at_ms) ~= 'number' then
      return cjson.encode({ error = 'CORRUPT_ATTEMPT_RECORD' })
    end
    duration_ms = now_ms - attempt.started_at_ms
    if duration_ms < 0 then duration_ms = 0 end
  end

  attempt.phase = 'terminal'
  attempt.report = {
    schema_version = 2,
    execution_status = 'CANCELLED',
    business_outcome = task_dispatched and 'UNVERIFIED' or 'NOT_STARTED',
    task_dispatched = task_dispatched,
    finished_at_ms = now_ms,
    duration_ms = duration_ms,
    executor = { type = 'operator', version = '1.0.0' },
    receipt_sha256 = ARGV[4],
    error = {
      stage = 'orchestration',
      code = 'OPERATOR_CANCELLED',
      message = 'Job cancelled by operator before completion.'
    },
    received_at_ms = now_ms
  }
  job.status = 'terminal'
  job.cancel = cancel_record

  redis.call('SET', KEYS[2], cjson.encode(attempt))
  redis.call('SET', KEYS[1], cjson.encode(job))

  return cjson.encode({ status = 'cancelled', result = 'cancelled', execution_status = 'CANCELLED', business_outcome = attempt.report.business_outcome, attempt_id = attempt.attempt_id, server_time_ms = now_ms })
end

-- Queued (including expired-unclaimed): immediate terminalization, no attempt.
if job.status == 'queued' then
  job.status = 'terminal'
  job.cancel = cancel_record

  redis.call('ZREM', KEYS[3], job.job_id)
  redis.call('SET', KEYS[1], cjson.encode(job))

  return cjson.encode({ status = 'cancelled', result = 'cancelled', execution_status = 'CANCELLED', business_outcome = 'NOT_STARTED', attempt_id = cjson.null, server_time_ms = now_ms })
end

return cjson.encode({ error = 'INVALID_JOB_STATUS', status = job.status })
`;

export const V2_RECORD_RESULT_SCRIPT = `
local function badtype(key, ok)
  local t = redis.call('TYPE', key)
  local tt = type(t) == 'table' and t.ok or tostring(t)
  if (tt ~= 'none') and (tt ~= ok) then return true end
  return false
end

if badtype(KEYS[1], 'string') then
  return redis.error_reply('WRONGTYPE_JOB_KEY')
end
if badtype(KEYS[2], 'string') then
  return redis.error_reply('WRONGTYPE_ATTEMPT_KEY')
end

local job_raw = redis.call('GET', KEYS[1])
if not job_raw then
  return cjson.encode({ error = 'JOB_NOT_FOUND' })
end
local okj, job = pcall(cjson.decode, job_raw)
if not okj then
  return cjson.encode({ error = 'CORRUPT_JOB_RECORD' })
end

local att_raw = redis.call('GET', KEYS[2])
if not att_raw then
  return cjson.encode({ error = 'ATTEMPT_NOT_FOUND' })
end
local oka, attempt = pcall(cjson.decode, att_raw)
if not oka then
  return cjson.encode({ error = 'CORRUPT_ATTEMPT_RECORD' })
end

-- Key correlation & ownership checks
if attempt.job_id ~= job.job_id or job.latest_attempt_id ~= attempt.attempt_id then
  return cjson.encode({ error = 'ATTEMPT_MISMATCH' })
end

if attempt.device_id ~= ARGV[2] or attempt.claim_token_sha256 ~= ARGV[3] then
  return cjson.encode({ error = 'IDENTITY_MISMATCH' })
end

local okr, incoming_result = pcall(cjson.decode, ARGV[4])
if not okr then
  return cjson.encode({ error = 'MALFORMED_RESULT' })
end

local time_parts = redis.call('TIME')
local now_ms = tonumber(time_parts[1]) * 1000 + math.floor(tonumber(time_parts[2]) / 1000)

local delivery_mode = ARGV[5]
if not delivery_mode or delivery_mode == "" then
  delivery_mode = "automatic"
end

-- Check if attempt already has a result
if attempt.result and attempt.result ~= cjson.null then
  local existing = attempt.result
  if existing.payload_sha256 == incoming_result.payload_sha256 and
     existing.resource_id == incoming_result.resource_id and
     existing.target == incoming_result.target then
    return cjson.encode({
      status = 'replayed',
      server_time_ms = now_ms,
      commit = existing.commit,
      resource_id = existing.resource_id,
    })
  elseif delivery_mode ~= "explicit_redelivery" then
    return cjson.encode({ error = 'STALE_RESULT_SUBMISSION' })
  end
end

-- Set attempt.result (terminal jobs and attempts can record/replace results)
incoming_result.received_at_ms = now_ms
attempt.result = incoming_result

redis.call('SET', KEYS[2], cjson.encode(attempt))

return cjson.encode({
  status = 'recorded',
  server_time_ms = now_ms,
  commit = incoming_result.commit,
  resource_id = incoming_result.resource_id,
})
`;

