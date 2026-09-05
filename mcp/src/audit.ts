import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express, { type Request, type Response, type NextFunction, type Router } from "express";

export interface TraceRecordInput {
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

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS traces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
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

        CREATE INDEX IF NOT EXISTS idx_traces_timestamp
        ON traces(timestamp_ms DESC);
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
          timestamp_ms, tool_name, status, error_message, operation_request_id,
          input_json, output_json, input_bytes, output_bytes,
          input_chars, output_chars, input_tokens_est, output_tokens_est,
          total_tokens_est, semantic_output_bytes, semantic_output_chars,
          semantic_output_tokens_est, latency_ms, affected_paths_json, resulting_commit
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?
        )
      `);

      insert.run(
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

  public listSummaries(options: { from?: number; to?: number; limit?: number } = {}): TraceSummary[] {
    if (!this.db) return [];

    try {
      const limit = Math.min(Math.max(Number(options.limit ?? 200), 1), 200);
      let query = `
        SELECT
          id, timestamp_ms, tool_name, status, error_message, operation_request_id,
          input_bytes, output_bytes, input_chars, output_chars,
          input_tokens_est, output_tokens_est, total_tokens_est,
          semantic_output_bytes, semantic_output_chars, semantic_output_tokens_est,
          latency_ms, affected_paths_json, resulting_commit
        FROM traces
      `;
      const conditions: string[] = [];
      const params: (number | string)[] = [];

      if (options.from !== undefined && !Number.isNaN(options.from)) {
        conditions.push("timestamp_ms >= ?");
        params.push(options.from);
      }
      if (options.to !== undefined && !Number.isNaN(options.to)) {
        conditions.push("timestamp_ms <= ?");
        params.push(options.to);
      }

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
      }

      query += " ORDER BY timestamp_ms DESC LIMIT ?";
      params.push(limit);

      const stmt = this.db.prepare(query);
      const rows = stmt.all(...params) as Record<string, unknown>[];

      return rows.map((row) => ({
        id: Number(row.id),
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

  public getDetail(id: number): TraceDetail | null {
    if (!this.db) return null;

    try {
      const stmt = this.db.prepare(`
        SELECT
          id, timestamp_ms, tool_name, status, error_message, operation_request_id,
          input_json, output_json, input_bytes, output_bytes, input_chars, output_chars,
          input_tokens_est, output_tokens_est, total_tokens_est,
          semantic_output_bytes, semantic_output_chars, semantic_output_tokens_est,
          latency_ms, affected_paths_json, resulting_commit
        FROM traces
        WHERE id = ?
      `);
      const row = stmt.get(id) as Record<string, unknown> | undefined;
      if (!row) return null;

      return {
        id: Number(row.id),
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

interface Session {
  expiresAt: number;
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function getSessionCookie(req: Request): string | null {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  const match = cookie.match(/(?:^|;\s*)ceo_audit_session=([^;]+)/);
  const token = match?.[1];
  return token ? decodeURIComponent(token) : null;
}

export function createAuditRouter(options: {
  auditStore: AuditStore;
  apiKey?: string;
  auditWebDir?: string;
}): Router {
  const { auditStore, apiKey, auditWebDir } = options;
  const router = express.Router();
  router.use(express.json());

  const sessions = new Map<string, Session>();

  function isSessionValid(sessionId: string | null): boolean {
    if (!sessionId) return false;
    const session = sessions.get(sessionId);
    if (!session) return false;
    if (Date.now() > session.expiresAt) {
      sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  function auditAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!apiKey) {
      res.status(401).json({ error: "Audit authentication is not configured on server" });
      return;
    }

    const sessionId = getSessionCookie(req);
    if (isSessionValid(sessionId)) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.substring(7);
      if (constantTimeEqual(token, apiKey)) {
        next();
        return;
      }
    }

    res.status(401).json({ error: "Unauthorized" });
  }

  router.post("/api/audit/session", (req: Request, res: Response) => {
    if (!apiKey) {
      res.status(401).json({ error: "Audit authentication is not configured on server" });
      return;
    }

    const { token } = req.body ?? {};
    if (typeof token !== "string" || !constantTimeEqual(token, apiKey)) {
      res.status(401).json({ error: "Invalid access token" });
      return;
    }

    const sessionId = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
    sessions.set(sessionId, { expiresAt });

    if (sessions.size > 1000) {
      const now = Date.now();
      for (const [id, s] of sessions.entries()) {
        if (now > s.expiresAt) sessions.delete(id);
      }
    }

    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
    const cookieParts = [
      `ceo_audit_session=${encodeURIComponent(sessionId)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${12 * 60 * 60}`,
    ];
    if (isSecure) {
      cookieParts.push("Secure");
    }

    res.setHeader("Set-Cookie", cookieParts.join("; "));
    res.status(200).json({ ok: true });
  });

  router.get("/api/audit/session", (req: Request, res: Response) => {
    const sessionId = getSessionCookie(req);
    res.status(200).json({ authenticated: isSessionValid(sessionId) });
  });

  router.delete("/api/audit/session", (req: Request, res: Response) => {
    const sessionId = getSessionCookie(req);
    if (sessionId) {
      sessions.delete(sessionId);
    }
    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
    const cookieParts = [
      "ceo_audit_session=",
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=0",
    ];
    if (isSecure) {
      cookieParts.push("Secure");
    }
    res.setHeader("Set-Cookie", cookieParts.join("; "));
    res.status(200).json({ ok: true });
  });

  router.get("/api/audit/traces", auditAuthMiddleware, (req: Request, res: Response) => {
    const from = req.query.from ? Number(req.query.from) : undefined;
    const to = req.query.to ? Number(req.query.to) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 200;

    const traces = auditStore.listSummaries({ from, to, limit });
    res.status(200).json({ ok: true, traces });
  });

  router.get("/api/audit/traces/:id", auditAuthMiddleware, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid trace ID" });
      return;
    }

    const trace = auditStore.getDetail(id);
    if (!trace) {
      res.status(404).json({ error: "Trace not found" });
      return;
    }

    res.status(200).json({ ok: true, trace });
  });

  if (auditWebDir && fs.existsSync(auditWebDir) && fs.existsSync(path.join(auditWebDir, "index.html"))) {
    router.use("/audit", express.static(auditWebDir));
    router.get(/^\/audit(?:\/.*)?$/, (_req, res) => {
      res.sendFile(path.join(auditWebDir, "index.html"));
    });
  } else {
    router.get(/^\/audit(?:\/.*)?$/, (_req, res) => {
      res.status(503).send("Audit Console web frontend is building or not available yet.");
    });
  }

  return router;
}
