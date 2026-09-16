import { describe, expect, it } from "vitest";
import {
  classifyOAuthClientKind,
  formatOAuthFlowLog,
  oauthClientRef,
  oauthRedirectHost,
} from "../src/oauth/observability.js";

describe("OAuth flow observability helpers", () => {
  it("classifies DCR vs CIMD without requiring the raw client id in logs", () => {
    expect(classifyOAuthClientKind("dcr_BsYJ7dX_k2qpch0SiIci7nVpn6CO23xUFoiqbj78rxY")).toBe("dcr");
    expect(classifyOAuthClientKind("https://chatgpt.com/.well-known/oauth-client")).toBe("cimd");
    expect(classifyOAuthClientKind(undefined)).toBe("unknown");
  });

  it("formats semantic events without embedding secrets or full client identifiers", () => {
    const clientId = "dcr_BsYJ7dX_k2qpch0SiIci7nVpn6CO23xUFoiqbj78rxY";
    const line = formatOAuthFlowLog("oauth: decision", {
      outcome: "approved",
      request_id: "oar_flow_obs",
      client_kind: classifyOAuthClientKind(clientId),
      client_ref: oauthClientRef(clientId),
      redirect_host: oauthRedirectHost(
        "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-ceo",
      ),
      status: 302,
    });

    expect(line).toContain("oauth: decision outcome=approved");
    expect(line).toContain("request_id=oar_flow_obs");
    expect(line).toContain("client_kind=dcr");
    expect(line).toContain("redirect_host=oauth-redirect.googleusercontent.com");
    expect(line).toContain(`client_ref=${oauthClientRef(clientId)}`);
    expect(line).not.toContain(clientId);
    expect(line).not.toContain("user_bound_custom-mcp-ceo");
    expect(line).not.toContain("consent_nonce");
    expect(line).not.toContain("code=");
    expect(line).not.toContain("code_verifier");
    expect(line).not.toContain("access_token");
    expect(line).not.toContain("refresh_token");
  });
});
