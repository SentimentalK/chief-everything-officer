import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { runGit, redactSecrets } from "../src/git.js";
import { GitHubAppGitCredentialProvider } from "../src/runtime/credentials.js";
import type { GitCredentialProvider } from "../src/runtime/types.js";
import type { GitHubAppClient } from "../src/github/app-client.js";
import { fixture } from "./helpers.js";
import { CeoWorkspace } from "../src/workspace.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("WorkspaceRuntime Git Credentials & Redaction", () => {
  it("GitHubAppGitCredentialProvider resolves x-access-token and token from appClient", async () => {
    let capturedReq: any;
    const mockAppClient = {
      getScopedInstallationToken: async (req: any) => {
        capturedReq = req;
        return `ghs_scoped_token_${req.githubInstallationId}_${req.repositoryIds[0]}`;
      },
    } as unknown as GitHubAppClient;

    const provider = new GitHubAppGitCredentialProvider(mockAppClient, "987654", "112233");
    const cred = await provider.getCredential();

    expect(capturedReq).toEqual({
      githubInstallationId: "987654",
      repositoryIds: ["112233"],
      permissions: { contents: "write" },
    });
    expect(cred).toEqual({
      username: "x-access-token",
      token: "ghs_scoped_token_987654_112233",
    });
  });

  it("throws error when sshKeyPath and credentialProvider are both configured (mutually exclusive) without calling credentialProvider", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    let credentialCalled = false;
    const mockProvider: GitCredentialProvider = {
      getCredential: async () => {
        credentialCalled = true;
        return {
          username: "x-access-token",
          token: "secret-token",
        };
      },
    };

    const config = {
      ...item.config,
      sshKeyPath: "/path/to/id_rsa",
      credentialProvider: mockProvider,
    };

    await expect(runGit(config, item.config.repoDir, ["status"])).rejects.toThrow(
      /sshKeyPath and credentialProvider are mutually exclusive/,
    );
    expect(credentialCalled).toBe(false);
  });

  it("throws error when knownHostsPath and credentialProvider are both configured without calling credentialProvider", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    let credentialCalled = false;
    const mockProvider: GitCredentialProvider = {
      getCredential: async () => {
        credentialCalled = true;
        return {
          username: "x-access-token",
          token: "secret-token",
        };
      },
    };

    const config = {
      ...item.config,
      knownHostsPath: "/path/to/known_hosts",
      credentialProvider: mockProvider,
    };

    await expect(runGit(config, item.config.repoDir, ["status"])).rejects.toThrow(
      /sshKeyPath and credentialProvider are mutually exclusive/,
    );
    expect(credentialCalled).toBe(false);
  });

  it("fails closed when only sshKeyPath is provided without knownHostsPath", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const config = {
      ...item.config,
      sshKeyPath: "/path/to/id_rsa",
      knownHostsPath: undefined,
      credentialProvider: undefined,
    };

    await expect(runGit(config, item.config.repoDir, ["status"])).rejects.toThrow(
      /sshKeyPath and knownHostsPath must both be provided/,
    );
  });

  it("fails closed when only knownHostsPath is provided without sshKeyPath", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const config = {
      ...item.config,
      sshKeyPath: undefined,
      knownHostsPath: "/path/to/known_hosts",
      credentialProvider: undefined,
    };

    await expect(runGit(config, item.config.repoDir, ["status"])).rejects.toThrow(
      /sshKeyPath and knownHostsPath must both be provided/,
    );
  });

  it("executes git commands successfully with credentialProvider", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    let providerCalled = false;
    const mockProvider: GitCredentialProvider = {
      getCredential: async () => {
        providerCalled = true;
        return {
          username: "x-access-token",
          token: "ghs_ephemeral_token_12345",
        };
      },
    };

    const config = {
      ...item.config,
      credentialProvider: mockProvider,
    };

    const res = await runGit(config, item.config.repoDir, ["status", "--porcelain"]);
    expect(providerCalled).toBe(true);
    expect(res.stdout).toBeDefined();

    // Verify token was not written to .git/config
    const gitConfigFile = path.join(item.config.repoDir, ".git", "config");
    const gitConfigContent = await readFile(gitConfigFile, "utf8").catch(() => "");
    expect(gitConfigContent).not.toContain("ghs_ephemeral_token_12345");
  });

  it("redacts token from stdout, stderr, and exception messages", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const secretToken = "ghs_super_secret_token_abcdef123456";
    const mockProvider: GitCredentialProvider = {
      getCredential: async () => ({
        username: "x-access-token",
        token: secretToken,
      }),
    };

    const config = {
      ...item.config,
      credentialProvider: mockProvider,
    };

    // 1. Redaction in error message when git command fails
    // Pass an invalid argument containing the token to trigger stderr output containing the token
    let caughtError: Error | null = null;
    try {
      await runGit(config, item.config.repoDir, [`--invalid-flag=${secretToken}`]);
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).not.toContain(secretToken);
    expect(caughtError!.message).toContain("[REDACTED]");

    // 2. Redaction when allowFailure = true (stderr/stdout returned in result)
    const failResult = await runGit(
      config,
      item.config.repoDir,
      [`--invalid-flag=${secretToken}`],
      true,
    );
    expect(failResult.stderr).not.toContain(secretToken);
    expect(failResult.stderr).toContain("[REDACTED]");

    // 3. Redact secrets unit function check
    const textWithSecret = `error: failed to push to https://x-access-token:${secretToken}@github.com/repo.git`;
    const redacted = redactSecrets(textWithSecret, [secretToken]);
    expect(redacted).not.toContain(secretToken);
    expect(redacted).toBe("error: failed to push to https://[REDACTED]@github.com/repo.git");
  });
});
