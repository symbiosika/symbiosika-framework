import type { CustomPostEmailSendAction, EmailSentContext } from "../../types";
import log from "../log";

/**
 * Observers of the outgoing mail stream (see `customPostEmailSendActions` in
 * the server config). Same shape as the register and e-mail-change hooks in
 * `lib/auth/actions.ts`.
 */
export const postEmailSendActions: CustomPostEmailSendAction[] = [];

/** Register a new server-wide action for sent e-mails */
export const registerPostEmailSendAction = (
  action: CustomPostEmailSendAction
) => {
  postEmailSendActions.push(action);
};

/**
 * Run every registered action for one send attempt.
 *
 * Errors are logged and swallowed per action: an observer that throws must
 * neither stop the remaining observers nor turn a delivered mail into a failed
 * one for the caller. The mail is gone (or not) either way — nothing an action
 * does can change that.
 */
export const runPostEmailSendActions = async (
  context: EmailSentContext
): Promise<void> => {
  for (const action of postEmailSendActions) {
    try {
      await action(context);
    } catch (err) {
      log.error("Error in post-email-send action: " + err);
    }
  }
};
