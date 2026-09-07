import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  IdentityStore,
  provisionEmptyIdentityDatabase,
  sha256Hex,
  IDENTITY_DB_USER_VERSION,
} from "../src/identity/store.js";
import { IdentityService } from "../src/identity/service.js";

const cleanupDirs: string[] = [];
const cleanupStores: IdentityStore[] = [];
const cleanupServices: IdentityService[] = [];

afterEach(async () => {
  for (const s of cleanupServices.splice(0)) s.close();
  for (const st of cleanupStores.splice(0)) st.close();
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Ctx {
  dir: string;
  dbPath: string;
  remoteUrl: string;
  branch: string;
}

async function tempCtx(): Promise<Ctx> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-identity-test-"));
  cleanupDirs.push(dir);
  return {
    dir,
    dbPath: path.join(dir, "identity", "identity.sqlite"),
    remoteUrl: "git@example.com:org/repo.git",
    branch: "main",
  };
}

function provision(ctx: Ctx, apiKey = "key-1") {
  return provisionEmptyIdentityDatabase(ctx.dbPath, {
    remoteUrl: ctx.remoteUrl,
    branch: ctx.branch,
    apiKeyDigest: sha256Hex(apiKey),
  });
}

function openRaw(ctx: Ctx): IdentityStore {
  const store = IdentityStore.open(ctx.dbPath);
  cleanupStores.push(store);
  return store;
}

function openService(ctx: Ctx, apiKey: string): IdentityService {
  const svc = IdentityService.open(
    { remoteUrl: ctx.remoteUrl, branch: ctx.branch, envApiKey: apiKey },
    ctx.dbPath,
  );
  cleanupServices.push(svc);
  return svc;
}

describe("Identity store: schema, invariants and permissions", () => {
  it("sets user_version and dir/file permissions on provisioning", async () => {
    const ctx = await tempCtx();
    const id = provision(ctx, "key-1");
    expect(id.user_id).toMatch(/^usr_/);
    expect(id.workspace_id).toMatch(/^ws_/);

    expect(fs.statSync(path.dirname(ctx.dbPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(ctx.dbPath).mode & 0o777).toBe(0o600);

    openRaw(ctx);
    const raw = new DatabaseSync(ctx.dbPath);
    const ver = raw.prepare("PRAGMA user_version;").get() as { user_version: number };
    raw.close();
    expect(Number(ver.user_version)).toBe(IDENTITY_DB_USER_VERSION);
  });

  it("declines a missing database at startup (fail-fast, no silent creation)", async () => {
    const ctx = await tempCtx();
    const missing = path.join(ctx.dir, "nope", "identity.sqlite");
    expect(() =>
      IdentityService.open({ remoteUrl: ctx.remoteUrl, branch: ctx.branch, envApiKey: "key-1" }, missing),
    ).toThrow(/not found/);
    // The server must not have created the file.
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("rejects a structurally invalid database (wrong user_version)", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const raw = new DatabaseSync(ctx.dbPath);
    raw.exec("PRAGMA user_version = 99;");
    raw.close();
    expect(() => IdentityStore.open(ctx.dbPath)).toThrow(/user_version/);
  });

  it("rules out multiple active keys at startup", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const raw = new DatabaseSync(ctx.dbPath);
    raw.exec(
      "INSERT INTO api_keys (id, user_id, key_digest, created_at, revoked_at) " +
        `VALUES ('ak_extra', (SELECT id FROM users), '${sha256Hex("extra")}', ${Date.now()}, NULL);`,
    );
    raw.close();
    // Startup invariant validation (service-level) rejects the second active key.
    expect(() =>
      IdentityService.open({ remoteUrl: ctx.remoteUrl, branch: ctx.branch, envApiKey: "key-1" }, ctx.dbPath),
    ).toThrow(/exactly one active \(unrevoked\) key/);
  });
});

describe("Identity service: startup validation and key lifecycle", () => {
  it("keeps the same user/workspace across repeat starts and key rotation", async () => {
    const ctx = await tempCtx();
    provision(ctx);
    const first = openService(ctx, "key-1").workspaceIdentityValue;

    const same = openService(ctx, "key-1");
    expect(same.workspaceIdentityValue).toEqual(first);

    const rotated = openService(ctx, "key-2");
    expect(rotated.workspaceIdentityValue).toEqual(first);

    // Rotation invalidates the old key and activates the new one.
    expect(rotated.authenticateApiKey("key-1")).toBeNull();
    const auth = rotated.authenticateApiKey("key-2");
    expect(auth).not.toBeNull();
    expect(auth!.user_id).toBe(first.user_id);
    expect(auth!.workspace_id).toBe(first.workspace_id);
    expect(auth!.api_key_id).toMatch(/^ak_/);
  });

  it("refuses to revive a previously revoked key", async () => {
    const ctx = await tempCtx();
    provision(ctx);
    openService(ctx, "key-1");
    openService(ctx, "key-2"); // revokes key-1
    expect(() => IdentityService.open({ remoteUrl: ctx.remoteUrl, branch: ctx.branch, envApiKey: "key-1" }, ctx.dbPath))
      .toThrow(/revoked/);
  });

  it("refuses to bind an existing identity to a different remote/branch", async () => {
    const ctx = await tempCtx();
    provision(ctx);
    openService(ctx, "key-1");
    expect(() => IdentityService.open({ remoteUrl: "other.git", branch: "main", envApiKey: "key-1" }, ctx.dbPath))
      .toThrow(/remote/);
    expect(() => IdentityService.open({ remoteUrl: ctx.remoteUrl, branch: "dev", envApiKey: "key-1" }, ctx.dbPath))
      .toThrow(/branch/);
  });

  it("fails startup and refuses auth while the single user is disabled", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const raw = new DatabaseSync(ctx.dbPath);
    raw.exec(`UPDATE users SET disabled_at = ${Date.now()} WHERE disabled_at IS NULL;`);
    raw.close();

    // The identity's own user is disabled -> the server must not start.
    expect(() => IdentityService.open({ remoteUrl: ctx.remoteUrl, branch: ctx.branch, envApiKey: "key-1" }, ctx.dbPath))
      .toThrow(/disabled/);
  });

  it("revalidates earlier identities as false once the key is revoked", async () => {
    const ctx = await tempCtx();
    provision(ctx);
    const svc = openService(ctx, "key-1");
    const auth = svc.authenticateApiKey("key-1")!;
    expect(svc.revalidate(auth)).toBe(true);

    const rotated = openService(ctx, "key-2");
    expect(rotated.revalidate(auth)).toBe(false);
  });
});
