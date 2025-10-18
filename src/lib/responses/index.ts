/**
 * Default responses to be used inside routes
 */
import * as v from "valibot";

export const RESPONSES = {
  SUCCESS: { success: true },
};

export const RESPONSE_VALIDATORS = {
  SUCCESS: v.object({ success: v.boolean() }),
};
