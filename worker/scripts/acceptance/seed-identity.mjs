#!/usr/bin/env node
/**
 * Test-only Worker acceptance fixture.
 *
 * Creates a production-valid empty control-plane DB, seeds one user /
 * workspace / owner membership / API key via a raw sqlite connection,
 * validates with IdentityStore.open, and writes an ephemeral GitHub App
 * RSA private key for Server constructor-only startup (no GitHub network).
 */
import { writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const base = process.env.SRV;
const dbPath = process.env.DB;
const key = process.env.KEY;
const idsPath = process.env.IDS;
const pemPath = process.env.PEM;

if (!base || !dbPath || !key || !idsPath || !pemPath) {
  throw new Error("seed-identity.mjs requires SRV, DB, KEY, IDS, PEM");
}

const storeMod = await import(pathToFileURL(path.join(base, "dist/identity/store.js")).href);
const {
  provisionEmptyControlPlaneDatabase,
  IdentityStore,
  newId,
  sha256Hex,
} = storeMod;

provisionEmptyControlPlaneDatabase(dbPath);

const userId = newId("usr");
const workspaceId = newId("ws");
const membershipId = newId("wsm");
const apiKeyId = newId("ak");
const nowMs = Date.now();

const db = new DatabaseSync(dbPath);
try {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.prepare("INSERT INTO users (id, created_at, disabled_at) VALUES (?, ?, NULL);").run(userId, nowMs);
    db.prepare(
      "INSERT INTO workspaces (id, owner_user_id, remote_url, branch, created_at) VALUES (?, ?, ?, ?, ?);",
    ).run(workspaceId, userId, "git@example.com:ceo/acceptance.git", "main", nowMs);
    db.prepare(
      "INSERT INTO workspace_memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?);",
    ).run(membershipId, workspaceId, userId, nowMs);
    db.prepare(
      "INSERT INTO api_keys (id, user_id, key_digest, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL);",
    ).run(apiKeyId, userId, sha256Hex(key), nowMs);
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      /* ignore */
    }
    throw error;
  }
} finally {
  db.close();
}

const store = IdentityStore.open(dbPath);
store.close();

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
writeFileSync(pemPath, privateKey, { mode: 0o600 });

const id = { user_id: userId, workspace_id: workspaceId };
writeFileSync(idsPath, JSON.stringify(id));
console.log("provisioned", id.user_id, id.workspace_id);
