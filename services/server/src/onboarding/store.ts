import type { DatabaseSync } from "node:sqlite";
import { IdentityStore, newId } from "../identity/store.js";
import type { OnboardingFlow, OnboardingState } from "./types.js";

const DEFAULT_ONBOARDING_TTL_MS = 60 * 60 * 1000; // 1 hour

export class OnboardingStore {
  constructor(private readonly identityStore: IdentityStore) {}

  private mapRow(row: any): OnboardingFlow {
    return {
      id: row.id,
      user_id: row.user_id,
      provider_subject: row.provider_subject,
      mode: row.mode,
      desired_repository_name: row.desired_repository_name ?? null,
      installation_row_id: row.installation_row_id ?? null,
      repository_id: row.repository_id ?? null,
      workspace_id: row.workspace_id ?? null,
      state: row.state as OnboardingState,
      last_error_code: row.last_error_code ?? null,
      last_error_message: row.last_error_message ?? null,
      created_at_ms: Number(row.created_at_ms),
      updated_at_ms: Number(row.updated_at_ms),
      expires_at_ms: Number(row.expires_at_ms),
    };
  }

  getOrCreateActiveFlowInTx(
    userId: string,
    providerSubject: string,
    ttlMs: number = DEFAULT_ONBOARDING_TTL_MS,
  ): OnboardingFlow {
    return this.identityStore.withDb((db: DatabaseSync) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const nowMs = Date.now();

        // Query active flow for this user
        const activeRow = db.prepare(
          `SELECT * FROM onboarding_flows
           WHERE user_id = ?
             AND state IN (
               'AWAITING_REPOSITORY_CHOICE',
               'AWAITING_GITHUB_ACCESS',
               'PROVISIONING',
               'READY_TO_RESUME',
               'RECOVERY_REQUIRED'
             )
           LIMIT 1;`,
        ).get(userId);

        if (activeRow) {
          const flow = this.mapRow(activeRow);
          // Check expiration
          if (nowMs > flow.expires_at_ms) {
            // Only prune if pure intent (no external side-effects)
            if (flow.repository_id === null && flow.workspace_id === null) {
              db.prepare(
                `UPDATE onboarding_flows
                 SET state = 'COMPLETED', updated_at_ms = ?
                 WHERE id = ?;`,
              ).run(nowMs, flow.id);
              // Fall through to insert fresh active flow below
            } else {
              // Side effect occurred (partial creation or workspace created).
              // Never prune; keep active and return for recovery.
              db.exec("COMMIT;");
              return flow;
            }
          } else {
            db.exec("COMMIT;");
            return flow;
          }
        }

        // Insert new active onboarding flow
        const flowId = newId("onb");
        const defaultRepoName = "ceo-data";
        const expiresAtMs = nowMs + ttlMs;

        db.prepare(
          `INSERT INTO onboarding_flows (
             id, user_id, provider_subject, mode, desired_repository_name,
             installation_row_id, repository_id, workspace_id, state,
             last_error_code, last_error_message, created_at_ms, updated_at_ms, expires_at_ms
           ) VALUES (?, ?, ?, 'create', ?, NULL, NULL, NULL, 'AWAITING_REPOSITORY_CHOICE', NULL, NULL, ?, ?, ?);`,
        ).run(
          flowId,
          userId,
          providerSubject,
          defaultRepoName,
          nowMs,
          nowMs,
          expiresAtMs,
        );

        db.exec("COMMIT;");

        return {
          id: flowId,
          user_id: userId,
          provider_subject: providerSubject,
          mode: "create",
          desired_repository_name: defaultRepoName,
          installation_row_id: null,
          repository_id: null,
          workspace_id: null,
          state: "AWAITING_REPOSITORY_CHOICE",
          last_error_code: null,
          last_error_message: null,
          created_at_ms: nowMs,
          updated_at_ms: nowMs,
          expires_at_ms: expiresAtMs,
        };
      } catch (error) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* ignore */
        }
        throw error;
      }
    });
  }

  getFlow(id: string): OnboardingFlow | null {
    return this.identityStore.withDb((db: DatabaseSync) => {
      const row = db.prepare("SELECT * FROM onboarding_flows WHERE id = ? LIMIT 1;").get(id);
      return row ? this.mapRow(row) : null;
    });
  }

  findActiveFlowForUser(userId: string): OnboardingFlow | null {
    return this.identityStore.withDb((db: DatabaseSync) => {
      const row = db.prepare(
        `SELECT * FROM onboarding_flows
         WHERE user_id = ?
           AND state IN (
             'AWAITING_REPOSITORY_CHOICE',
             'AWAITING_GITHUB_ACCESS',
             'PROVISIONING',
             'READY_TO_RESUME',
             'RECOVERY_REQUIRED'
           )
         LIMIT 1;`,
      ).get(userId);
      return row ? this.mapRow(row) : null;
    });
  }

  updateFlow(id: string, patch: Partial<Omit<OnboardingFlow, "id" | "user_id" | "provider_subject" | "mode" | "created_at_ms">>): OnboardingFlow {
    return this.identityStore.withDb((db: DatabaseSync) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const existingRow = db.prepare("SELECT * FROM onboarding_flows WHERE id = ? LIMIT 1;").get(id);
        if (!existingRow) {
          throw new Error(`Onboarding flow '${id}' not found`);
        }

        const nowMs = Date.now();
        const current = this.mapRow(existingRow);

        const updated: OnboardingFlow = {
          ...current,
          desired_repository_name: patch.desired_repository_name !== undefined ? patch.desired_repository_name : current.desired_repository_name,
          installation_row_id: patch.installation_row_id !== undefined ? patch.installation_row_id : current.installation_row_id,
          repository_id: patch.repository_id !== undefined ? patch.repository_id : current.repository_id,
          workspace_id: patch.workspace_id !== undefined ? patch.workspace_id : current.workspace_id,
          state: patch.state !== undefined ? patch.state : current.state,
          last_error_code: patch.last_error_code !== undefined ? patch.last_error_code : current.last_error_code,
          last_error_message: patch.last_error_message !== undefined ? patch.last_error_message : current.last_error_message,
          updated_at_ms: nowMs,
          expires_at_ms: patch.expires_at_ms !== undefined ? patch.expires_at_ms : current.expires_at_ms,
        };

        db.prepare(
          `UPDATE onboarding_flows
           SET desired_repository_name = ?,
               installation_row_id = ?,
               repository_id = ?,
               workspace_id = ?,
               state = ?,
               last_error_code = ?,
               last_error_message = ?,
               updated_at_ms = ?,
               expires_at_ms = ?
           WHERE id = ?;`,
        ).run(
          updated.desired_repository_name,
          updated.installation_row_id,
          updated.repository_id,
          updated.workspace_id,
          updated.state,
          updated.last_error_code,
          updated.last_error_message,
          updated.updated_at_ms,
          updated.expires_at_ms,
          id,
        );

        db.exec("COMMIT;");
        return updated;
      } catch (error) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* ignore */
        }
        throw error;
      }
    });
  }

  deleteFlow(id: string): boolean {
    return this.identityStore.withDb((db: DatabaseSync) => {
      const res = db.prepare("DELETE FROM onboarding_flows WHERE id = ?;").run(id);
      return Number(res.changes) > 0;
    });
  }

  cleanupExpired(nowMs: number = Date.now()): number {
    return this.identityStore.withDb((db: DatabaseSync) => {
      // Invariant: ONLY clean up expired flows with NO durable side-effects (both repository_id and workspace_id are NULL)
      const res = db.prepare(
        `DELETE FROM onboarding_flows
         WHERE expires_at_ms <= ?
           AND repository_id IS NULL
           AND workspace_id IS NULL;`,
      ).run(nowMs);
      return Number(res.changes);
    });
  }
}
