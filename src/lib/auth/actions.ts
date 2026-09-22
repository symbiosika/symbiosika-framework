import type {
  CustomPostEmailChangeAction,
  CustomPostRegisterAction,
  CustomPreEmailChangeVerification,
  CustomPreRegisterVerification,
} from "../../types";

/**
 * Pre-register custom verification
 */
export const preRegisterCustomVerifications: CustomPreRegisterVerification[] = [];
export const postRegisterActions: CustomPostRegisterAction[] = [];

/**
 * Register a new server-wide verification
 */
export const registerPreRegisterCustomVerification = (
  verification: CustomPreRegisterVerification
) => {
  preRegisterCustomVerifications.push(verification);
};

/**
 * Thrown when a pre-register verification refuses a sign-up. `reason` is the
 * verification's own `message`, meant to be shown to the user as is.
 */
export class PreRegisterVerificationError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super("Custom verification failed: " + reason);
    this.name = "PreRegisterVerificationError";
    this.reason = reason;
  }
}

const DEFAULT_REFUSAL_REASON = "Registration is not allowed for this address";

/**
 * Run all registered pre-register verifications for a new account. Every
 * sign-up path (password, magic link, social login, hanko) calls this BEFORE
 * the user row is written, so a refused address never gets an account and no
 * post-register action runs for it. Without registered verifications this is
 * a no-op.
 */
export const runPreRegisterVerifications = async (
  email: string,
  meta: any
): Promise<void> => {
  for (const verification of preRegisterCustomVerifications) {
    const r = await verification(email, meta);
    if (!r.success) {
      throw new PreRegisterVerificationError(
        r.message || DEFAULT_REFUSAL_REASON
      );
    }
  }
};

/**
 * Register a new server-wide post-register action
 */
export const registerPostRegisterAction = (
  action: CustomPostRegisterAction
) => {
  postRegisterActions.push(action);
};

/**
 * Hooks of the e-mail change flow (see lib/auth/email-change.ts). Same shape as
 * the register hooks above: the verifications can refuse a request, the actions
 * only observe a completed change.
 */
export const preEmailChangeVerifications: CustomPreEmailChangeVerification[] =
  [];
export const postEmailChangeActions: CustomPostEmailChangeAction[] = [];

/** Register a new server-wide verification for e-mail change requests */
export const registerPreEmailChangeVerification = (
  verification: CustomPreEmailChangeVerification
) => {
  preEmailChangeVerifications.push(verification);
};

/** Register a new server-wide action for confirmed e-mail changes */
export const registerPostEmailChangeAction = (
  action: CustomPostEmailChangeAction
) => {
  postEmailChangeActions.push(action);
};
