// services/server/src/jobs/assignment-script.ts
//
// Persistent, single-key Lua implementing inspect/claim/start for job assignments.
// Operates on KEYS[1] = ceo:job:<job_id>.
//
// ARGV layout (1-indexed in Lua):
//   [1] operation               'inspect' | 'claim' | 'start'
//   [2] expected_job_id
//   [3] trusted_user_id
//   [4] trusted_workspace_id
//   [5] worker_id
//   [6] attempt_id
//   [7] workspace_ref
//   [8] claim_token_sha256

export const ASSIGNMENT_SCRIPT = `
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

local function okRes(job, state, replayed, server_time_ms)
  return cjson.encode({
    ok = true,
    record = job,
    server_time_ms = server_time_ms,
    state = state,
    replayed = replayed,
  })
end

-- 1. Key type check
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

-- 2. Ownership + job identity FIRST (uniform not-found)
if job.job_id ~= expected_job_id
   or job.user_id ~= trusted_user_id
   or job.workspace_id ~= trusted_workspace then
  return err('JOB_NOT_FOUND', cjson.null)
end

-- 3. Schema version must be 2
if job.schema_version ~= 2 then
  return err('QUEUE_UNAVAILABLE', 'UNSUPPORTED_SCHEMA_VERSION')
end

-- 4. Structural validation of base job record
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
if cd < cr then return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD') end
if job.resource_id ~= nil and job.resource_id ~= cjson.null and type(job.resource_id) ~= 'string' then
  return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
end

-- Validate execution if present
local ex = job.execution
if ex ~= nil then
  if ex == cjson.null or type(ex) ~= 'table' then
    return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
  end
  -- Reject legacy lease fields in v2 execution
  if ex.lease_token_sha256 ~= nil or ex.lease_expires_at_ms ~= nil
     or ex.start_deadline_ms ~= nil or ex.execution_deadline_ms ~= nil then
    return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
  end
  if ex.phase ~= 'claimed' and ex.phase ~= 'running' then
    return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
  end
  if type(ex.worker_id) ~= 'string' or ex.worker_id == '' then
    return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
  end
  if type(ex.attempt_id) ~= 'string' or ex.attempt_id == '' then
    return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
  end
  if type(ex.claim_token_sha256) ~= 'string'
     or string.len(ex.claim_token_sha256) ~= 64
     or string.find(ex.claim_token_sha256, '[^0-9a-f]') then
    return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
  end
  if type(ex.claimed_at_ms) ~= 'number' or ex.claimed_at_ms % 1 ~= 0 or ex.claimed_at_ms < 0 then
    return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
  end
  if ex.phase == 'claimed' then
    if ex.started_at_ms ~= cjson.null then
      return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
    end
  else
    if type(ex.started_at_ms) ~= 'number' or ex.started_at_ms % 1 ~= 0 or ex.started_at_ms < ex.claimed_at_ms then
      return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
    end
  end
end

-- 5. Full-commit requirement (status 'queued' and non-empty stream_entry_id)
local committed = job.status == 'queued'
  and type(job.stream_entry_id) == 'string'
  and job.stream_entry_id ~= ''
if not committed then
  return err('QUEUE_UNAVAILABLE', 'INCOMPLETE_SUBMISSION')
end

-- 6. Validate operation inputs
local function validId(s)
  return type(s) == 'string' and string.len(s) > 0 and not string.find(s, '[^%w%-_]')
end
local function validSha(s)
  return type(s) == 'string' and string.len(s) == 64 and not string.find(s, '[^0-9a-f]')
end

if operation == 'claim' then
  if not validId(worker_id) or not validId(attempt_id) or not validSha(token_sha)
     or type(workspace_ref) ~= 'string' or string.len(workspace_ref) == 0 then
    return err('QUEUE_UNAVAILABLE', 'INVALID_ARGUMENT')
  end
elseif operation == 'start' then
  if not validId(worker_id) or not validId(attempt_id) or not validSha(token_sha) then
    return err('QUEUE_UNAVAILABLE', 'INVALID_ARGUMENT')
  end
elseif operation ~= 'inspect' then
  return err('QUEUE_UNAVAILABLE', 'UNSUPPORTED_OPERATION')
end

-- 7. Redis TIME
local ttime = redis.call('TIME')
local now = tonumber(ttime[1]) * 1000 + math.floor(tonumber(ttime[2]) / 1000)

local function deriveState(j, n)
  local e = j.execution
  if e == nil or e == cjson.null then
    if n >= j.claim_deadline_ms then return 'expired' end
    return 'queued'
  end
  return e.phase
end

-- 8. Operations
if operation == 'inspect' then
  local st = deriveState(job, now)
  return okRes(job, st, false, now)
end

if operation == 'claim' then
  local e = job.execution
  if e == nil or e == cjson.null then
    if job.workspace_ref ~= workspace_ref then return err('WORKSPACE_MISMATCH', cjson.null) end
    if now >= job.claim_deadline_ms then return err('JOB_EXPIRED', cjson.null) end
    local nex = {
      worker_id = worker_id,
      attempt_id = attempt_id,
      claim_token_sha256 = token_sha,
      phase = 'claimed',
      claimed_at_ms = now,
      started_at_ms = cjson.null,
    }
    job.execution = nex
    redis.call('SET', KEYS[1], cjson.encode(job))
    return okRes(job, 'claimed', false, now)
  end

  if e.attempt_id ~= attempt_id then return err('JOB_ALREADY_CLAIMED', cjson.null) end
  if e.worker_id ~= worker_id or e.claim_token_sha256 ~= token_sha
     or job.workspace_ref ~= workspace_ref then
    return err('IDEMPOTENCY_CONFLICT', cjson.null)
  end
  -- Identical match replay: keep current phase ('claimed' or 'running')
  return okRes(job, e.phase, true, now)
end

if operation == 'start' then
  local e = job.execution
  if e == nil or e == cjson.null then return err('JOB_NOT_CLAIMED', cjson.null) end
  if e.worker_id ~= worker_id or e.attempt_id ~= attempt_id or e.claim_token_sha256 ~= token_sha then
    return err('ASSIGNMENT_MISMATCH', cjson.null)
  end
  if now < e.claimed_at_ms then
    return err('QUEUE_UNAVAILABLE', 'CLOCK_REGRESSION')
  end
  if e.phase == 'claimed' then
    e.phase = 'running'
    e.started_at_ms = now
    job.execution = e
    redis.call('SET', KEYS[1], cjson.encode(job))
    return okRes(job, 'running', false, now)
  end
  -- Already running: replay
  return okRes(job, 'running', true, now)
end

return err('QUEUE_UNAVAILABLE', 'UNSUPPORTED_OPERATION')
`;
