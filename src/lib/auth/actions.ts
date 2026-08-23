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
