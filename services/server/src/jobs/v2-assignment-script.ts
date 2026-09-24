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
if badtype(KEYS[3], 'stream') then
  return redis.error_reply('WRONGTYPE_STREAM_KEY')
end
if badtype(KEYS[4], 'zset') then
  return redis.error_reply('WRONGTYPE_TARGET_QUEUE')
end

local req = redis.call('GET', KEYS[1])
if req then
  if badtype(KEYS[2], 'string') then
    return redis.error_reply('WRONGTYPE_JOB_KEY')
  end
  local job = redis.call('GET', KEYS[2])
  if not job then
    return cjson.encode({ error = 'CORRUPT_SUBMISSION_REFERENCE' })
  end
  local okjd, jd = pcall(cjson.decode, job)
  if not okjd then
    return cjson.encode({ error = 'MALFORMED_JOB_RECORD' })
  end
  if jd.user_id ~= ARGV[2] or jd.workspace_id ~= ARGV[3] or jd.request_id ~= ARGV[9] then
    return cjson.encode({ error = 'IDEMPOTENCY_CONFLICT' })
  end
  if jd.status == 'preparing' then
    return cjson.encode({ error = 'INCOMPLETE_SUBMISSION' })
  end
  if jd.request_digest == ARGV[7] then
    return cjson.encode({ status = 'replayed', job_id = jd.job_id })
  else
    return cjson.encode({ error = 'IDEMPOTENCY_CONFLICT' })
  end
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

if rep.execution_status == 'COMPLETED' and (rep.error ~= nil and rep.error ~= cjson.null) then
  return cjson.encode({ error = 'COMPLETED_REPORT_HAS_ERROR' })
end

if rep.execution_status ~= 'COMPLETED' and (rep.error == nil or rep.error == cjson.null) then
  return cjson.encode({ error = 'NON_COMPLETED_REPORT_MISSING_ERROR' })
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
