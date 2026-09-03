import { describe, expect, it, vi } from "vitest";
import { createAuthMiddleware, createHostGuard, createOriginGuard } from "../src/auth.js";

function fakeReq(headers: Record<string, string> = {}, hostname = "localhost") {
  return { headers, hostname } as any;
}

function fakeRes() {
  let code = 0;
  let body: any;
  const res = {
    status(c: number) { code = c; return res; },
    json(b: any) { body = b; return res; },
  };
  return { res: res as any, getCode: () => code, getBody: () => body };
}

describe("createAuthMiddleware", () => {
  it("passes through when apiKey is undefined (local dev)", () => {
    const mw = createAuthMiddleware(undefined);
    const next = vi.fn();
    mw(fakeReq(), fakeRes().res, next);
    expect(next).toHaveBeenCalled();
  });

  it("rejects when no Authorization header", () => {
    const mw = createAuthMiddleware("secret-key");
    const next = vi.fn();
    const { res, getCode } = fakeRes();
    mw(fakeReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getCode()).toBe(401);
  });

  it("rejects when Authorization is not Bearer scheme", () => {
    const mw = createAuthMiddleware("secret-key");
    const next = vi.fn();
    const { res, getCode } = fakeRes();
    mw(fakeReq({ authorization: "Basic abc123" }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getCode()).toBe(401);
  });

  it("rejects when Bearer token is wrong", () => {
    const mw = createAuthMiddleware("secret-key");
    const next = vi.fn();
    const { res, getCode } = fakeRes();
    mw(fakeReq({ authorization: "Bearer wrong-key" }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getCode()).toBe(401);
  });

  it("allows when Bearer token is correct", () => {
    const mw = createAuthMiddleware("secret-key");
    const next = vi.fn();
    const { res } = fakeRes();
    mw(fakeReq({ authorization: "Bearer secret-key" }), res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe("createHostGuard", () => {
  it("rejects unknown host with 421", () => {
    const mw = createHostGuard(["localhost"]);
    const next = vi.fn();
    const { res, getCode } = fakeRes();
    mw(fakeReq({}, "evil.com"), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getCode()).toBe(421);
  });

  it("allows known host", () => {
    const mw = createHostGuard(["localhost", "agent.sentimentalk.com"]);
    const next = vi.fn();
    mw(fakeReq({}, "agent.sentimentalk.com"), fakeRes().res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe("createOriginGuard", () => {
  it("allows requests with no Origin header (server-to-server)", () => {
    const mw = createOriginGuard([]);
    const next = vi.fn();
    mw(fakeReq(), fakeRes().res, next);
    expect(next).toHaveBeenCalled();
  });

  it("rejects requests with unknown Origin", () => {
    const mw = createOriginGuard([]);
    const next = vi.fn();
    const { res, getCode } = fakeRes();
    mw(fakeReq({ origin: "https://evil.com" }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getCode()).toBe(403);
  });

  it("allows requests with known Origin", () => {
    const mw = createOriginGuard(["https://trusted.com"]);
    const next = vi.fn();
    mw(fakeReq({ origin: "https://trusted.com" }), fakeRes().res, next);
    expect(next).toHaveBeenCalled();
  });
});
