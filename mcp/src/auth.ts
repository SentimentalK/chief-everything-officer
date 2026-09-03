import { timingSafeEqual as tsEqual } from "node:crypto";
import type { RequestHandler } from "express";

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Compare against self to keep constant time even on length mismatch
    tsEqual(bufA, bufA);
    return false;
  }
  return tsEqual(bufA, bufB);
}

export function createAuthMiddleware(apiKey: string | undefined): RequestHandler {
  if (apiKey === undefined) {
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      process.stderr.write("auth: rejected reason=missing\n");
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }

    if (!authHeader.startsWith("Bearer ")) {
      process.stderr.write("auth: rejected reason=invalid\n");
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }

    const token = authHeader.substring(7);
    if (!constantTimeEqual(token, apiKey)) {
      process.stderr.write("auth: rejected reason=bad_token\n");
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }

    next();
  };
}

export function createHostGuard(allowedHosts: string[]): RequestHandler {
  const hostSet = new Set(allowedHosts);
  return (req, res, next) => {
    if (!hostSet.has(req.hostname)) {
      res.status(421).json({ jsonrpc: "2.0", error: { code: -32000, message: "Misdirected request" }, id: null });
      return;
    }
    next();
  };
}

export function createOriginGuard(allowedOrigins: string[]): RequestHandler {
  const originSet = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }

    if (!originSet.has(origin)) {
      res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden" }, id: null });
      return;
    }

    next();
  };
}
