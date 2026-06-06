import type {
  ConnectionEstablishedContext,
  CustomPostConnectionAction,
} from "../../types";
import log from "../log";

/**
 * Server-wide post-connection actions, fired once a connection is established.
 */
export const postConnectionActions: CustomPostConnectionAction[] = [];

/**
 * Register a new server-wide post-connection action.
 */
export const registerPostConnectionAction = (
  action: CustomPostConnectionAction
) => {
  postConnectionActions.push(action);
};

/**
 * Run all registered post-connection actions. Failures are logged but never
 * break the connection flow.
 */
export const runPostConnectionActions = async (
  ctx: ConnectionEstablishedContext
): Promise<void> => {
  for (const action of postConnectionActions) {
    try {
      await action(ctx);
    } catch (error) {
      log.error("Post-connection action failed:", error as object);
    }
  }
};
