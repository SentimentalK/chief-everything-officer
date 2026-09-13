// services/server/src/jobs/assignment-script.ts
//
// Persistent, single-key Lua implementing inspect/claim/start/report for job assignments.
// Operates on KEYS[1] = ceo:job:<job_id>.
//
// ARGV layout (1-indexed in Lua):
//   [1] operation               'inspect' | 'claim' | 'start' | 'report'
//   [2] expected_job_id
//   [3] trusted_user_id
//   [4] trusted_workspace_id
//   [5] worker_id
//   [6] attempt_id
//   [7] workspace_ref
//   [8] claim_token_sha256
//   [9] report_json             report operation only; empty otherwise

export const ASSIGNMENT_SCRIPT = `
local operation         = ARGV[1]
local expected_job_id   = ARGV[2]
local trusted_user_id   = ARGV[3]
local trusted_workspace = ARGV[4]
local worker_id         = ARGV[5]
local attempt_id        = ARGV[6]
local workspace_ref     = ARGV[7]
local token_sha         = ARGV[8]
local report_json       = ARGV[9]

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

local MAX_SAFE_INTEGER = 9007199254740991

local function validTimestamp(value)
  return type(value) == 'number'
    and value >= 0
    and value <= MAX_SAFE_INTEGER
    and value % 1 == 0
end

local function validUuid(s)
  if type(s) ~= 'string' or #s ~= 36 then
    return false
  end

  local a, b, c, d, e =
    s:match('^([0-9a-f]+)%-([0-9a-f]+)%-([0-9a-f]+)%-([0-9a-f]+)%-([0-9a-f]+)$')

  return a ~= nil
    and #a == 8
    and #b == 4
    and #c == 4
    and #d == 4
    and #e == 12
end

local function validWorkerId(s)
  return type(s) == 'string'
    and s:sub(1, 4) == 'wrk-'
    and validUuid(s:sub(5))
end

local function validSha(s)
  return type(s) == 'string' and #s == 64 and not s:find('[^0-9a-f]')
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

-- 3. Schema version must be 3
if job.schema_version ~= 3 then
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
if not validTimestamp(cr) or not validTimestamp(cd) then
  return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
end
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
  if not validWorkerId(ex.worker_id) or not validUuid(ex.attempt_id) then
    return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
  end
  if not validSha(ex.claim_token_sha256) then
    return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
  end
  if not validTimestamp(ex.claimed_at_ms) then
    return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
  end
  if ex.phase == 'claimed' then
    if ex.started_at_ms ~= cjson.null then
      return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
    end
  else
    if not validTimestamp(ex.started_at_ms) or ex.started_at_ms < ex.claimed_at_ms then
      return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
    end
  end
end

local function validStage(s)
  return type(s) == 'string' and #s >= 1 and #s <= 64 and not s:find('[^A-Za-z0-9_-]')
end

local function validErrCode(s)
  return type(s) == 'string' and #s >= 1 and #s <= 64 and not s:find('[^A-Z0-9_]')
end

local function validErrMessage(s)
  if type(s) ~= 'string' or #s == 0 or #s > 2048 then
    return false
  end
  if s:match('^%s*$') then
    return false
  end
  return true
end

local function countKeys(t)
  local n = 0
  for _ in pairs(t) do n = n + 1 end
  return n
end

local function validExecutorType(s)
  return type(s) == 'string' and #s >= 1 and #s <= 64 and not s:find('[^A-Za-z0-9_.-]')
end

local function validExecutorVersion(s)
  if type(s) ~= 'string' or #s == 0 or #s > 256 then
    return false
  end
  if s:match('^%s*$') then
    return false
  end
  return true
end

local function validExecutor(ex)
  if type(ex) ~= 'table' then return false end
  if countKeys(ex) ~= 2 then return false end
  return validExecutorType(ex.type) and validExecutorVersion(ex.version)
end

local function validDuration(d)
  return type(d) == 'number' and d >= 0 and d <= 9007199254740991 and math.floor(d) == d
end

local function validReportError(e)
  if e == cjson.null then return true end
  if type(e) ~= 'table' then return false end
  if countKeys(e) ~= 3 then return false end
  return validStage(e.stage) and validErrCode(e.code) and validErrMessage(e.message)
end

local REPORT_STATUSES = {
  COMPLETED = true,
  FAILED = true,
  TIMED_OUT = true,
  CANCELLED = true,
  BLOCKED = true,
  INTERRUPTED = true,
}

local REPORT_OUTCOMES = {
  UNVERIFIED = true,
  FAILED = true,
  NOT_STARTED = true,
}

local function validIncomingReport(r)
  if type(r) ~= 'table' then return false end
  if countKeys(r) ~= 9 then return false end
  if r.schema_version ~= 2 then return false end
  if not REPORT_STATUSES[r.execution_status] then return false end
  if not REPORT_OUTCOMES[r.business_outcome] then return false end
  if type(r.task_dispatched) ~= 'boolean' then return false end
  if not validTimestamp(r.finished_at_ms) then return false end
  if not validDuration(r.duration_ms) then return false end
  if not validExecutor(r.executor) then return false end
  if not validSha(r.receipt_sha256) then return false end
  if not validReportError(r.error) then return false end
  if r.execution_status == 'COMPLETED' and r.error ~= cjson.null then return false end
  if r.execution_status ~= 'COMPLETED' and r.error == cjson.null then return false end
  if not r.task_dispatched and r.business_outcome ~= 'NOT_STARTED' then return false end
  if r.business_outcome == 'UNVERIFIED' and not r.task_dispatched then return false end
  return true
end

local function validStoredReport(r)
  if type(r) ~= 'table' then return false end
  if countKeys(r) ~= 10 then return false end
  if not validIncomingReport({
    schema_version = r.schema_version,
    execution_status = r.execution_status,
    business_outcome = r.business_outcome,
    task_dispatched = r.task_dispatched,
    finished_at_ms = r.finished_at_ms,
    duration_ms = r.duration_ms,
    executor = r.executor,
    receipt_sha256 = r.receipt_sha256,
    error = r.error,
  }) then
    return false
  end
  return validTimestamp(r.received_at_ms)
end

local function reportsMatch(a, b)
  if a.schema_version ~= b.schema_version then return false end
  if a.execution_status ~= b.execution_status then return false end
  if a.business_outcome ~= b.business_outcome then return false end
  if a.task_dispatched ~= b.task_dispatched then return false end
  if a.finished_at_ms ~= b.finished_at_ms then return false end
  if a.duration_ms ~= b.duration_ms then return false end
  if type(a.executor) ~= 'table' or type(b.executor) ~= 'table' then return false end
  if a.executor.type ~= b.executor.type or a.executor.version ~= b.executor.version then return false end
  if a.receipt_sha256 ~= b.receipt_sha256 then return false end
  local ae, be = a.error, b.error
  if ae == cjson.null and be == cjson.null then return true end
  if type(ae) ~= 'table' or type(be) ~= 'table' then return false end
  return ae.stage == be.stage and ae.code == be.code and ae.message == be.message
end

local function reportPublicState(status)
  if status == 'COMPLETED' then return 'completed' end
  if status == 'FAILED' then return 'failed' end
  if status == 'TIMED_OUT' then return 'timed_out' end
  if status == 'CANCELLED' then return 'cancelled' end
  if status == 'BLOCKED' then return 'blocked' end
  if status == 'INTERRUPTED' then return 'interrupted' end
  return nil
end

-- Validate stored report if present. Absent is allowed; explicit null/malformed is corrupt.
-- A report without a valid execution assignment is also corrupt.
local stored_report = job.report
if stored_report ~= nil then
  if stored_report == cjson.null or not validStoredReport(stored_report) then
    return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
  end
  if ex == nil or ex == cjson.null then
    return err('QUEUE_UNAVAILABLE', 'CORRUPT_RECORD')
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
if operation == 'claim' then
  if not validWorkerId(worker_id) or not validUuid(attempt_id) or not validSha(token_sha)
     or type(workspace_ref) ~= 'string' or #workspace_ref == 0 then
    return err('QUEUE_UNAVAILABLE', 'INVALID_ARGUMENT')
  end
elseif operation == 'start' then
  if not validWorkerId(worker_id) or not validUuid(attempt_id) or not validSha(token_sha) then
    return err('QUEUE_UNAVAILABLE', 'INVALID_ARGUMENT')
  end
elseif operation == 'report' then
  if not validWorkerId(worker_id) or not validUuid(attempt_id) or not validSha(token_sha)
     or type(report_json) ~= 'string' or report_json == '' then
    return err('QUEUE_UNAVAILABLE', 'INVALID_ARGUMENT')
  end
elseif operation ~= 'inspect' then
  return err('QUEUE_UNAVAILABLE', 'UNSUPPORTED_OPERATION')
end

-- 7. Redis TIME
local ttime = redis.call('TIME')
local now = tonumber(ttime[1]) * 1000 + math.floor(tonumber(ttime[2]) / 1000)

local function deriveState(j, n)
  local r = j.report
  if r ~= nil and r ~= cjson.null then
    return reportPublicState(r.execution_status)
  end
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
  if stored_report ~= nil then return err('JOB_FINISHED', cjson.null) end
  -- Identical match replay: keep current phase ('claimed' or 'running')
  return okRes(job, e.phase, true, now)
end

if operation == 'start' then
  local e = job.execution
  if e == nil or e == cjson.null then return err('JOB_NOT_CLAIMED', cjson.null) end
  if e.worker_id ~= worker_id or e.attempt_id ~= attempt_id or e.claim_token_sha256 ~= token_sha then
    return err('ASSIGNMENT_MISMATCH', cjson.null)
  end
  if stored_report ~= nil then return err('JOB_FINISHED', cjson.null) end
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

if operation == 'report' then
  local e = job.execution
  if e == nil or e == cjson.null then return err('JOB_NOT_CLAIMED', cjson.null) end
  if e.worker_id ~= worker_id or e.attempt_id ~= attempt_id or e.claim_token_sha256 ~= token_sha then
    return err('ASSIGNMENT_MISMATCH', cjson.null)
  end
  local okp, incoming = pcall(cjson.decode, report_json)
  if not okp or not validIncomingReport(incoming) then
    return err('QUEUE_UNAVAILABLE', 'INVALID_ARGUMENT')
  end
  if stored_report ~= nil then
    if reportsMatch(stored_report, incoming) then
      return okRes(job, reportPublicState(stored_report.execution_status), true, stored_report.received_at_ms)
    end
    return err('REPORT_CONFLICT', cjson.null)
  end
  job.report = {
    schema_version = incoming.schema_version,
    execution_status = incoming.execution_status,
    business_outcome = incoming.business_outcome,
    task_dispatched = incoming.task_dispatched,
    finished_at_ms = incoming.finished_at_ms,
    duration_ms = incoming.duration_ms,
    executor = {
      type = incoming.executor.type,
      version = incoming.executor.version,
    },
    receipt_sha256 = incoming.receipt_sha256,
    error = incoming.error,
    received_at_ms = now,
  }
  local encoded_job = cjson.encode(job)
  local encoded_res = okRes(job, reportPublicState(incoming.execution_status), false, now)
  redis.call('SET', KEYS[1], encoded_job)
  return encoded_res
end

return err('QUEUE_UNAVAILABLE', 'UNSUPPORTED_OPERATION')
`;
