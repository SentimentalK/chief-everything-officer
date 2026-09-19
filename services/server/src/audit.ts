import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response, type NextFunction, type Router } from "express";
import {
  type IdentityService,
  type WorkspaceIdentity,
  WorkspaceAccessDeniedError,
  WorkspaceSelectionRequiredError,
} from "./identity/service.js";
import {
  IdentityDbUnavailable,
  IdentityDbContextClosed,
  IdentityStructureError,
} from "./identity/store.js";
import type { UserSessionManager } from "./auth/user-session.js";

export class AuditSchemaIncompatibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditSchemaIncompatibleError";
  }
}

export interface TraceRecordInput {
  workspace_id: string;
  timestamp_ms: number;
  tool_name: string;
  status: "success" | "error";
  error_message?: string | null;
  operation_request_id?: string | null;
  input_json: string;
  output_json: string;
  semantic_output_json?: string | null;
  latency_ms: number;
  affected_paths?: string[] | null;
  resulting_commit?: string | null;
}

export interface TraceSummary {
  id: number;
  workspace_id: string;
  timestamp_ms: number;
  tool_name: string;
  status: string;
  error_message: string | null;
  operation_request_id: string | null;
  input_bytes: number;
  output_bytes: number;
  input_chars: number;
  output_chars: number;
  input_tokens_est: number;
  output_tokens_est: number;
  total_tokens_est: number;
  semantic_output_bytes: number | null;
  semantic_output_chars: number | null;
  semantic_output_tokens_est: number | null;
  latency_ms: number;
  affected_paths: string[] | null;
  resulting_commit: string | null;
}

export interface TraceDetail extends TraceSummary {
  input_json: string;
  output_json: string;
}

export class AuditStore {
  private db: DatabaseSync | null = null;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.init();
  }

  private init(): void {
    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      } else {
        try { fs.chmodSync(dir, 0o700); } catch {}
      }

      this.db = new DatabaseSync(this.dbPath);
      try { fs.chmodSync(this.dbPath, 0o600); } catch {}

      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA busy_timeout = 100;");

      const tableExists = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='traces';",
      ).get() as { name: string } | undefined;

      if (tableExists) {
        const columns = this.db.prepare("PRAGMA table_info(traces);").all() as Array<{ name: string }>;
        const columnNames = new Set(columns.map((c) => c.name));
        if (!columnNames.has("workspace_id")) {
          throw new AuditSchemaIncompatibleError(
            "Audit database schema incompatible: traces table lacks 'workspace_id'. Delete local audit database to allow fresh initialization.",
          );
        }
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS traces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id TEXT NOT NULL,
          timestamp_ms INTEGER NOT NULL,
          tool_name TEXT NOT NULL,
          status TEXT NOT NULL,
          error_message TEXT,
          operation_request_id TEXT,
          input_json TEXT NOT NULL,
          output_json TEXT NOT NULL,
          input_bytes INTEGER NOT NULL,
          output_bytes INTEGER NOT NULL,
          input_chars INTEGER NOT NULL,
          output_chars INTEGER NOT NULL,
          input_tokens_est INTEGER NOT NULL,
          output_tokens_est INTEGER NOT NULL,
          total_tokens_est INTEGER NOT NULL,
          semantic_output_bytes INTEGER,
          semantic_output_chars INTEGER,
          semantic_output_tokens_est INTEGER,
          latency_ms INTEGER NOT NULL,
          affected_paths_json TEXT,
          resulting_commit TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_traces_workspace_time
        ON traces(workspace_id, timestamp_ms DESC);
      `);

      const columns = this.db.prepare("PRAGMA table_info(traces)").all() as Array<{ name: string }>;
      const columnNames = new Set(columns.map((c) => c.name));

      if (!columnNames.has("semantic_output_bytes")) {
        this.db.exec("ALTER TABLE traces ADD COLUMN semantic_output_bytes INTEGER;");
      }
      if (!columnNames.has("semantic_output_chars")) {
        this.db.exec("ALTER TABLE traces ADD COLUMN semantic_output_chars INTEGER;");
      }
      if (!columnNames.has("semantic_output_tokens_est")) {
        this.db.exec("ALTER TABLE traces ADD COLUMN semantic_output_tokens_est INTEGER;");
      }
    } catch (error) {
      if (error instanceof AuditSchemaIncompatibleError) throw error;
      process.stderr.write(`audit: failed to initialize database at ${this.dbPath}: ${error}\n`);
      this.db = null;
    }
  }

  public recordTrace(record: TraceRecordInput): void {
    if (!this.db) {
      try { this.init(); } catch {}
      if (!this.db) return;
    }

    try {
      const inputBytes = Buffer.byteLength(record.input_json, "utf8");
      const outputBytes = Buffer.byteLength(record.output_json, "utf8");
      const inputChars = record.input_json.length;
      const outputChars = record.output_json.length;
      const inputTokensEst = Math.ceil(inputChars / 4);
      const outputTokensEst = Math.ceil(outputChars / 4);
      const totalTokensEst = inputTokensEst + outputTokensEst;

      let semanticOutputBytes: number | null = null;
      let semanticOutputChars: number | null = null;
      let semanticOutputTokensEst: number | null = null;

      if (record.semantic_output_json != null) {
        semanticOutputBytes = Buffer.byteLength(record.semantic_output_json, "utf8");
        semanticOutputChars = record.semantic_output_json.length;
        semanticOutputTokensEst = Math.ceil(semanticOutputChars / 4);
      }

      const affectedPathsJson = record.affected_paths && record.affected_paths.length > 0
        ? JSON.stringify(record.affected_paths)
        : null;

      const insert = this.db.prepare(`
        INSERT INTO traces (
          workspace_id, timestamp_ms, tool_name, status, error_message, operation_request_id,
          input_json, output_json, input_bytes, output_bytes,
          input_chars, output_chars, input_tokens_est, output_tokens_est,
          total_tokens_est, semantic_output_bytes, semantic_output_chars,
          semantic_output_tokens_est, latency_ms, affected_paths_json, resulting_commit
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?
        )
      `);

      insert.run(
        record.workspace_id,
        record.timestamp_ms,
        record.tool_name,
        record.status,
        record.error_message ?? null,
        record.operation_request_id ?? null,
        record.input_json,
        record.output_json,
        inputBytes,
        outputBytes,
        inputChars,
        outputChars,
        inputTokensEst,
        outputTokensEst,
        totalTokensEst,
        semanticOutputBytes,
        semanticOutputChars,
        semanticOutputTokensEst,
        record.latency_ms,
        affectedPathsJson,
        record.resulting_commit ?? null,
      );
    } catch (error) {
      process.stderr.write(`audit: failed to record trace for tool ${record.tool_name}: ${error}\n`);
    }
  }

  public listSummaries(workspaceId: string, options: { from?: number; to?: number; limit?: number } = {}): TraceSummary[] {
    if (!this.db) return [];

    try {
      const limit = Math.min(Math.max(Number(options.limit ?? 200), 1), 200);
      let query = `
        SELECT
          id, workspace_id, timestamp_ms, tool_name, status, error_message, operation_request_id,
          input_bytes, output_bytes, input_chars, output_chars,
          input_tokens_est, output_tokens_est, total_tokens_est,
          semantic_output_bytes, semantic_output_chars, semantic_output_tokens_est,
          latency_ms, affected_paths_json, resulting_commit
        FROM traces
      `;
      const conditions: string[] = ["workspace_id = ?"];
      const params: (number | string)[] = [workspaceId];

      if (options.from !== undefined && !Number.isNaN(options.from)) {
        conditions.push("timestamp_ms >= ?");
        params.push(options.from);
      }
      if (options.to !== undefined && !Number.isNaN(options.to)) {
        conditions.push("timestamp_ms <= ?");
        params.push(options.to);
      }

      query += ` WHERE ${conditions.join(" AND ")}`;
      query += " ORDER BY timestamp_ms DESC LIMIT ?";
      params.push(limit);

      const stmt = this.db.prepare(query);
      const rows = stmt.all(...params) as Record<string, unknown>[];

      return rows.map((row) => ({
        id: Number(row.id),
        workspace_id: String(row.workspace_id),
        timestamp_ms: Number(row.timestamp_ms),
        tool_name: String(row.tool_name),
        status: String(row.status),
        error_message: row.error_message ? String(row.error_message) : null,
        operation_request_id: row.operation_request_id ? String(row.operation_request_id) : null,
        input_bytes: Number(row.input_bytes),
        output_bytes: Number(row.output_bytes),
        input_chars: Number(row.input_chars),
        output_chars: Number(row.output_chars),
        input_tokens_est: Number(row.input_tokens_est),
        output_tokens_est: Number(row.output_tokens_est),
        total_tokens_est: Number(row.total_tokens_est),
        semantic_output_bytes: row.semantic_output_bytes == null ? null : Number(row.semantic_output_bytes),
        semantic_output_chars: row.semantic_output_chars == null ? null : Number(row.semantic_output_chars),
        semantic_output_tokens_est: row.semantic_output_tokens_est == null ? null : Number(row.semantic_output_tokens_est),
        latency_ms: Number(row.latency_ms),
        affected_paths: row.affected_paths_json ? JSON.parse(String(row.affected_paths_json)) : null,
        resulting_commit: row.resulting_commit ? String(row.resulting_commit) : null,
      }));
    } catch (error) {
      process.stderr.write(`audit: failed to list trace summaries: ${error}\n`);
      return [];
    }
  }

  public getDetail(workspaceId: string, id: number): TraceDetail | null {
    if (!this.db) return null;

    try {
      const stmt = this.db.prepare(`
        SELECT
          id, workspace_id, timestamp_ms, tool_name, status, error_message, operation_request_id,
          input_json, output_json, input_bytes, output_bytes, input_chars, output_chars,
          input_tokens_est, output_tokens_est, total_tokens_est,
          semantic_output_bytes, semantic_output_chars, semantic_output_tokens_est,
          latency_ms, affected_paths_json, resulting_commit
        FROM traces
        WHERE workspace_id = ? AND id = ?
      `);
      const row = stmt.get(workspaceId, id) as Record<string, unknown> | undefined;
      if (!row) return null;

      return {
        id: Number(row.id),
        workspace_id: String(row.workspace_id),
        timestamp_ms: Number(row.timestamp_ms),
        tool_name: String(row.tool_name),
        status: String(row.status),
        error_message: row.error_message ? String(row.error_message) : null,
        operation_request_id: row.operation_request_id ? String(row.operation_request_id) : null,
        input_json: String(row.input_json),
        output_json: String(row.output_json),
        input_bytes: Number(row.input_bytes),
        output_bytes: Number(row.output_bytes),
        input_chars: Number(row.input_chars),
        output_chars: Number(row.output_chars),
        input_tokens_est: Number(row.input_tokens_est),
        output_tokens_est: Number(row.output_tokens_est),
        total_tokens_est: Number(row.total_tokens_est),
        semantic_output_bytes: row.semantic_output_bytes == null ? null : Number(row.semantic_output_bytes),
        semantic_output_chars: row.semantic_output_chars == null ? null : Number(row.semantic_output_chars),
        semantic_output_tokens_est: row.semantic_output_tokens_est == null ? null : Number(row.semantic_output_tokens_est),
        latency_ms: Number(row.latency_ms),
        affected_paths: row.affected_paths_json ? JSON.parse(String(row.affected_paths_json)) : null,
        resulting_commit: row.resulting_commit ? String(row.resulting_commit) : null,
      };
    } catch (error) {
      process.stderr.write(`audit: failed to get trace detail for id ${id}: ${error}\n`);
      return null;
    }
  }

  public close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {}
      this.db = null;
    }
  }
}

function expireLegacyAuditCookie(res: Response, secure: boolean): void {
  const cookieParts = [
    "ceo_audit_session=",
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (secure) {
    cookieParts.push("Secure");
  }
  res.append("Set-Cookie", cookieParts.join("; "));
}

function isSecureRequest(req: Request): boolean {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

/**
 * Whether an identity-enforcement error reflects an unavailable/closed store
 * (503) rather than ordinary auth semantics handled by null/ownership checks.
 */
function isIdentityUnavailable(error: unknown): boolean {
  return (
    error instanceof IdentityDbUnavailable ||
    error instanceof IdentityDbContextClosed ||
    error instanceof IdentityStructureError
  );
}

export function createAuditRouter(options: {
  auditStore: AuditStore;
  identityService: IdentityService;
  sessionManager: UserSessionManager;
}): Router {
  const { auditStore, identityService, sessionManager } = options;
  const store = identityService.storeInstance;
  const router = express.Router();
  router.use(express.json());

  function clearBrowserSessions(req: Request, res: Response): void {
    const session = sessionManager.getSession(req);
    if (session) {
      sessionManager.destroySession(session.sessionId);
    }
    sessionManager.clearCookie(res);
    expireLegacyAuditCookie(res, isSecureRequest(req));
  }

  function auditAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
    const session = sessionManager.getSession(req);
    if (!session) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    try {
      if (!store.isUserActive(session.userId)) {
        sessionManager.destroySession(session.sessionId);
        sessionManager.clearCookie(res);
        expireLegacyAuditCookie(res, isSecureRequest(req));
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (!store.isUserAdmin(session.userId)) {
        res.status(403).json({ error: "Audit access denied" });
        return;
      }
      const workspace: WorkspaceIdentity = identityService.resolveUserWorkspace(session.userId);
      res.locals.auditWorkspace = workspace;
      next();
    } catch (error) {
      if (isIdentityUnavailable(error)) {
        res.status(503).json({ error: "Identity service unavailable" });
        return;
      }
      if (error instanceof WorkspaceAccessDeniedError || error instanceof WorkspaceSelectionRequiredError) {
        res.status(403).json({ error: error.message });
        return;
      }
      throw error;
    }
  }

  router.post("/api/audit/session", (_req: Request, res: Response) => {
    res.status(410).json({ error: "Audit API-key login has been removed. Sign in with GitHub." });
  });

  router.get("/api/audit/session", (req: Request, res: Response) => {
    try {
      const session = sessionManager.getSession(req);
      if (!session) {
        res.status(200).json({ authenticated: false, authorized: false });
        return;
      }
      if (!store.isUserActive(session.userId)) {
        sessionManager.destroySession(session.sessionId);
        sessionManager.clearCookie(res);
        expireLegacyAuditCookie(res, isSecureRequest(req));
        res.status(200).json({ authenticated: false, authorized: false });
        return;
      }
      const authorized = store.isUserAdmin(session.userId);
      res.status(200).json({
        authenticated: true,
        authorized,
        user: { id: session.userId },
      });
    } catch (error) {
      if (isIdentityUnavailable(error)) {
        res.status(503).json({ error: "Identity service unavailable" });
        return;
      }
      throw error;
    }
  });

  router.delete("/api/audit/session", (req: Request, res: Response) => {
    clearBrowserSessions(req, res);
    res.status(200).json({ ok: true });
  });

  router.get("/api/audit/traces", auditAuthMiddleware, (req: Request, res: Response) => {
    const from = req.query.from ? Number(req.query.from) : undefined;
    const to = req.query.to ? Number(req.query.to) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 200;
    const workspaceId = (res.locals.auditWorkspace as WorkspaceIdentity).workspace_id;

    const traces = auditStore.listSummaries(workspaceId, { from, to, limit });
    res.status(200).json({ ok: true, traces });
  });

  router.get("/api/audit/traces/:id", auditAuthMiddleware, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid trace ID" });
      return;
    }
    const workspaceId = (res.locals.auditWorkspace as WorkspaceIdentity).workspace_id;

    const trace = auditStore.getDetail(workspaceId, id);
    if (!trace) {
      res.status(404).json({ error: "Trace not found" });
      return;
    }

    res.status(200).json({ ok: true, trace });
  });

  return router;
}
