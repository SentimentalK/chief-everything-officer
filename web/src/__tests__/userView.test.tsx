import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { UserView } from "../components/UserView";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("UserView Component Tests", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.restoreAllMocks();
  });

  it("renders unauthenticated state with Continue with GitHub button", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ authenticated: false }),
    } as any);

    const root = createRoot(container);
    await act(async () => {
      root.render(<UserView />);
    });

    expect(container.textContent).toContain("Chief Everything Officer");
    expect(container.textContent).toContain("Continue with GitHub");

    const link = container.querySelector("a[href='/auth/github']");
    expect(link).not.toBeNull();

    const auditLink = container.querySelector("a[href='/audit']");
    expect(auditLink).not.toBeNull();
  });

  it("renders authenticated state when user session exists", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        authenticated: true,
        user: {
          id: "usr_mock_123",
          provider: "github",
          provider_login: "SentimentalK",
        },
      }),
    } as any);

    const root = createRoot(container);
    await act(async () => {
      root.render(<UserView />);
    });

    expect(container.textContent).toContain("Signed in with GitHub");
    expect(container.textContent).toContain("@SentimentalK");
    expect(container.textContent).toContain("usr_mock_123");
    expect(container.textContent).toContain("Active CEO User Session");
    expect(container.querySelector("a[href='/audit']")).not.toBeNull();

    const signOutBtn = container.querySelector("button");
    expect(signOutBtn).not.toBeNull();
    expect(signOutBtn?.textContent).toContain("Sign Out");
  });

  it("handles logout properly when clicking Sign Out", async () => {
    let authenticated = true;
    global.fetch = vi.fn(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/user/session/logout")) {
        authenticated = false;
        return { ok: true, json: async () => ({ ok: true }) } as any;
      }
      return {
        ok: true,
        json: async () => ({
          authenticated,
          user: authenticated
            ? { id: "usr_1", provider: "github", provider_login: "SentimentalK" }
            : undefined,
        }),
      } as any;
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(<UserView />);
    });

    expect(container.textContent).toContain("@SentimentalK");

    const signOutBtn = container.querySelector("button")!;
    await act(async () => {
      signOutBtn.click();
    });

    expect(container.textContent).toContain("Continue with GitHub");
  });
});
