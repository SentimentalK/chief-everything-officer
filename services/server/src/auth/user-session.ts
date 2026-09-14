import crypto from "node:crypto";
import type { Request, Response } from "express";

export interface UserSession {
  sessionId: string;
  userId: string;
  workspaceId: string;
  provider: string;
  providerSubject: string;
  providerLogin?: string;
  expiresAt: number;
}

export interface UserSessionManagerOptions {
  secureCookies?: boolean;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const COOKIE_NAME = "ceo_user_session";

export class UserSessionManager {
  private readonly sessions = new Map<string, UserSession>();
  private readonly secureCookies: boolean;
  private readonly ttlMs: number;

  constructor(options: UserSessionManagerOptions = {}) {
    this.secureCookies = options.secureCookies ?? false;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  createSession(input: {
    userId: string;
    workspaceId: string;
    provider: string;
    providerSubject: string;
    providerLogin?: string;
  }): UserSession {
    const sessionId = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + this.ttlMs;

    const session: UserSession = {
      sessionId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      provider: input.provider,
      providerSubject: input.providerSubject,
      providerLogin: input.providerLogin,
      expiresAt,
    };

    this.sessions.set(sessionId, session);

    // Housekeeping if map grows large
    if (this.sessions.size > 1000) {
      const now = Date.now();
      for (const [id, s] of this.sessions.entries()) {
        if (now > s.expiresAt) {
          this.sessions.delete(id);
        }
      }
    }

    return session;
  }

  getSessionFromToken(sessionId: string | null): UserSession | null {
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      return null;
    }
    return session;
  }

  getSession(req: Request): UserSession | null {
    const token = this.getCookieToken(req);
    return this.getSessionFromToken(token);
  }

  destroySession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  setCookie(res: Response, sessionId: string): void {
    const maxAgeSeconds = Math.floor(this.ttlMs / 1000);
    const cookieParts = [
      `${COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (this.secureCookies) {
      cookieParts.push("Secure");
    }
    res.setHeader("Set-Cookie", cookieParts.join("; "));
  }

  clearCookie(res: Response): void {
    const cookieParts = [
      `${COOKIE_NAME}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=0",
    ];
    if (this.secureCookies) {
      cookieParts.push("Secure");
    }
    res.setHeader("Set-Cookie", cookieParts.join("; "));
  }

  private getCookieToken(req: Request): string | null {
    const cookie = req.headers.cookie;
    if (!cookie) return null;
    const regex = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`);
    const match = cookie.match(regex);
    const token = match?.[1];
    return token ? decodeURIComponent(token) : null;
  }
}
