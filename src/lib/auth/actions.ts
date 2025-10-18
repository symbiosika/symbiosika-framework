import type {
  CustomPostRegisterAction,
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
