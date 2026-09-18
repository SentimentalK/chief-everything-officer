export type OnboardingState =
  | "AWAITING_REPOSITORY_CHOICE"
  | "AWAITING_GITHUB_ACCESS"
  | "PROVISIONING"
  | "READY_TO_RESUME"
  | "RECOVERY_REQUIRED"
  | "COMPLETED";

export interface OnboardingFlow {
  id: string;
  user_id: string;
  provider_subject: string;
  mode: "create";
  desired_repository_name: string | null;
  installation_row_id: string | null;
  repository_id: string | null;
  workspace_id: string | null;
  state: OnboardingState;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  expires_at_ms: number;
}

export type OnboardingErrorCode =
  | "INSTALLATION_REQUIRED"
  | "INSTALLATION_SELECTION_REQUIRED"
  | "INSTALLATION_UNAVAILABLE"
  | "USER_AUTHORIZATION_REQUIRED"
  | "REPOSITORY_NAME_CONFLICT"
  | "PARTIAL_REPOSITORY_CREATION"
  | "BOOTSTRAP_RETRYABLE"
  | "BOOTSTRAP_MANUAL_RECOVERY"
  | "HOST_AUTHORIZATION_EXPIRED";

export class OnboardingError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, code: string = "ONBOARDING_ERROR", status: number = 400) {
    super(message);
    this.name = "OnboardingError";
    this.code = code;
    this.status = status;
  }
}
