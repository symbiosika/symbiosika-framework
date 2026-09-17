import { describe, it, expect, beforeEach } from "bun:test";
import { smtpService } from "./index";
import { postEmailSendActions, registerPostEmailSendAction } from "./actions";
import type { EmailSentContext } from "../../types";

/**
 * The post-send actions of the mailer.
 *
 * They exist because an app cannot reach the framework's own mails: the login
 * link, the one-time code, the address-verification and invitation mails are
 * sent from inside the framework. Every one of them goes through
 * `smtpService.sendMail`, so one action registered here sees all of them —
 * which is what an app needs to answer "what was this person sent, and when?".
 *
 * Covered here: an action sees the metadata of a sent mail, a rejected mail is
 * reported as not delivered, a throwing action neither breaks the send nor
 * stops the other actions, and the fire-and-forget path used by the login
 * mails triggers the actions as well.
 *
 * Runs in console mode (`SMTP_HOST=console.localhost`), so nothing leaves the
 * process; `delivered` is `true` there, as documented on `EmailSentContext`.
 */

/** Actions are process-wide; each test starts from an empty registry. */
beforeEach(() => {
  postEmailSendActions.length = 0;
});

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 2000
): Promise<boolean> => {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
};

describe("post email send actions", () => {
  it("sees recipients, subject and outcome of a sent mail", async () => {
    const seen: EmailSentContext[] = [];
    registerPostEmailSendAction(async (context) => {
      seen.push(context);
    });

    const before = new Date().toISOString();
    const sent = await smtpService.sendMail({
      recipients: ["hook-test@symbiosika.de"],
      subject: "Your login link",
      html: "<p>https://example.com/magic?token=secret</p>",
    });

    expect(sent).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.recipients).toEqual(["hook-test@symbiosika.de"]);
    expect(seen[0]!.subject).toBe("Your login link");
    expect(seen[0]!.delivered).toBe(true);
    expect(seen[0]!.sentAt >= before).toBe(true);

    // Metadata only — the body must not travel with the context.
    expect(JSON.stringify(seen[0])).not.toContain("secret");
  });

  it("reports a mail the mailer rejected as not delivered", async () => {
    const seen: EmailSentContext[] = [];
    registerPostEmailSendAction(async (context) => {
      seen.push(context);
    });

    // Neither text nor html: rejected before SMTP is reached.
    const sent = await smtpService.sendMail({
      recipients: ["hook-test@symbiosika.de"],
      subject: "Empty",
    });

    expect(sent).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.delivered).toBe(false);
  });

  it("keeps sending when an action throws, and runs the remaining ones", async () => {
    let secondRan = false;
    registerPostEmailSendAction(async () => {
      throw new Error("observer is broken");
    });
    registerPostEmailSendAction(async () => {
      secondRan = true;
    });

    const sent = await smtpService.sendMail({
      recipients: ["hook-test@symbiosika.de"],
      subject: "Still delivered",
      text: "body",
    });

    expect(sent).toBe(true);
    expect(secondRan).toBe(true);
  });

  it("also fires for the fire-and-forget path used by the login mails", async () => {
    const seen: EmailSentContext[] = [];
    registerPostEmailSendAction(async (context) => {
      seen.push(context);
    });

    smtpService.sendMailInBackground({
      recipients: ["hook-test@symbiosika.de"],
      subject: "Your one-time code",
      text: "123456",
    });

    expect(await waitFor(() => seen.length > 0)).toBe(true);
    expect(seen[0]!.subject).toBe("Your one-time code");
  });
});
