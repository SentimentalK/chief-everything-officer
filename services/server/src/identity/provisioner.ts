import { IdentityStore } from "./store.js";

export interface AccountResolution {
  userId: string;
  createdUser: boolean;
  provider: string;
  providerSubject: string;
  providerLogin?: string;
  providerEmail?: string;
}

export interface AccountProvisioner {
  resolveOrCreate(
    provider: string,
    providerSubject: string,
    providerLogin?: string,
    providerEmail?: string | null,
  ): AccountResolution;
}

/**
 * Resolves or creates CEO users from verified external identities.
 * Has no knowledge of runtime workspace selection.
 */
export class IdentityAccountProvisioner implements AccountProvisioner {
  private readonly store: IdentityStore;

  constructor(store: IdentityStore) {
    this.store = store;
  }

  resolveOrCreate(
    provider: string,
    providerSubject: string,
    providerLogin?: string,
    providerEmail?: string | null,
  ): AccountResolution {
    const row = this.store.resolveOrCreateExternalUser({
      provider,
      providerSubject,
      providerLogin,
      providerEmail,
    });
    return {
      userId: row.user_id,
      createdUser: row.created,
      provider: row.provider,
      providerSubject: row.provider_subject,
      providerLogin: row.provider_login ?? undefined,
      providerEmail: row.provider_email ?? undefined,
    };
  }
}
