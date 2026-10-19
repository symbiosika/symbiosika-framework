import type { EmailTemplateFunction } from "../types";
import {
  escapeHtml,
  formatDuration,
  renderEmail,
  strong,
  truncateSubject,
} from "../lib/email/render";

/**
 * The server config, read when a mail is rendered. Imported lazily because
 * `./index` imports this module to fill in the default templates.
 */
const serverConfig = async () =>
  (await import("./index"))._GLOBAL_SERVER_CONFIG;

/**
 * The framework's default mails, all in the look of `lib/email/render.ts`.
 * Each one can be replaced through `emailTemplates` in `defineServer`.
 */

const IGNORE_NOTE =
  "Nicht angefordert? Dann ignorieren Sie diese E-Mail einfach.";
const UNEXPECTED_NOTE =
  "Nicht erwartet? Dann ignorieren Sie diese E-Mail einfach.";

const magicLinkValidity = async () =>
  formatDuration((await serverConfig()).magicLinkTtl);

// ----- sign-in ----------------------------------------------------------------

export const stdTemplateMagicLink: EmailTemplateFunction = async (data) => {
  const valid = await magicLinkValidity();
  return {
    subject: truncateSubject(`Ihr Login-Link für ${data.appName}`),
    html: renderEmail({
      appName: data.appName,
      logoUrl: data.logoUrl,
      de: {
        heading: "Anmelden",
        lines: [
          `Klicken Sie auf den Button, um sich anzumelden. Der Link ist ${valid.de} gültig.`,
        ],
      },
      button: { link: data.link, text: "Jetzt anmelden" },
      note: IGNORE_NOTE,
      en: `Click the button to sign in. The link is valid for ${valid.en}.`,
    }),
  };
};

export const stdTemplateEmailLoginCode: EmailTemplateFunction = async (
  data,
) => {
  const valid = formatDuration(
    (await serverConfig()).oauth2?.emailLoginCodeTtl ?? 60 * 10,
  );
  return {
    subject: truncateSubject(`Ihr Login-Code für ${data.appName}`),
    html: renderEmail({
      appName: data.appName,
      logoUrl: data.logoUrl,
      de: {
        heading: "Ihr Login-Code",
        lines: [
          `Geben Sie diesen Code ein, um die Anmeldung abzuschließen. Der Code ist ${valid.de} gültig.`,
        ],
      },
      code: data.code ?? "",
      note: IGNORE_NOTE,
      en: `Enter this code to finish signing in. The code is valid for ${valid.en}.`,
    }),
  };
};

// ----- account ----------------------------------------------------------------

export const stdTemplateVerifyEmail: EmailTemplateFunction = async (data) => {
  const valid = await magicLinkValidity();
  return {
    subject: truncateSubject(`E-Mail-Adresse bestätigen – ${data.appName}`),
    html: renderEmail({
      appName: data.appName,
      logoUrl: data.logoUrl,
      de: {
        heading: "E-Mail-Adresse bestätigen",
        lines: [
          `Bitte bestätigen Sie Ihre E-Mail-Adresse. Der Link ist ${valid.de} gültig.`,
        ],
      },
      button: { link: data.link, text: "Bestätigen" },
      note: IGNORE_NOTE,
      en: `Please confirm your email address. The link is valid for ${valid.en}.`,
    }),
  };
};

/**
 * Confirmation mail for an e-mail *change*. Goes to the NEW address: clicking
 * the link is the proof that the requester actually owns that mailbox, and
 * only then is the address written to the account.
 */
export const stdTemplateVerifyEmailChange: EmailTemplateFunction = async (
  data,
) => {
  const newEmail = escapeHtml(data.newEmail ?? "");
  const valid = formatDuration((await serverConfig()).emailChangeTtl);
  return {
    subject: truncateSubject(
      `Neue E-Mail-Adresse bestätigen – ${data.appName}`,
    ),
    html: renderEmail({
      appName: data.appName,
      logoUrl: data.logoUrl,
      de: {
        heading: "Neue E-Mail-Adresse bestätigen",
        lines: [
          `Ihr Konto soll künftig ${strong(newEmail)} verwenden. Bis zur Bestätigung bleibt die alte Adresse aktiv. Der Link ist ${valid.de} gültig.`,
        ],
      },
      button: { link: data.link, text: "Adresse bestätigen" },
      note: IGNORE_NOTE,
      en: `Confirm ${newEmail} as the new address of your account. The link is valid for ${valid.en}.`,
    }),
  };
};

/**
 * Heads-up mail for an e-mail change. Goes to the OLD (still active) address so
 * the legitimate owner notices a change they did not start. It deliberately
 * carries no confirmation link — only the new mailbox can confirm.
 */
export const stdTemplateEmailChangeNotice: EmailTemplateFunction = async (
  data,
) => {
  const newEmail = escapeHtml(data.newEmail ?? "");
  return {
    subject: truncateSubject(`E-Mail-Änderung angefordert – ${data.appName}`),
    html: renderEmail({
      appName: data.appName,
      logoUrl: data.logoUrl,
      de: {
        heading: "E-Mail-Änderung angefordert",
        lines: [
          `Für Ihr Konto wurde ein Wechsel auf ${strong(newEmail)} angefordert. Er wird erst nach Bestätigung der neuen Adresse wirksam.`,
        ],
      },
      note: "Das waren nicht Sie? Melden Sie sich an, brechen Sie die Anfrage ab und ändern Sie Ihr Passwort.",
      en: `A change of your account email to ${newEmail} was requested. Not you? Sign in, cancel the request and change your password.`,
    }),
  };
};

export const stdTemplatePasswordReset: EmailTemplateFunction = async (data) => {
  const valid = await magicLinkValidity();
  return {
    subject: truncateSubject(`Passwort zurücksetzen – ${data.appName}`),
    html: renderEmail({
      appName: data.appName,
      logoUrl: data.logoUrl,
      de: {
        heading: "Passwort zurücksetzen",
        lines: [
          `Über den Button legen Sie ein neues Passwort fest. Der Link ist ${valid.de} gültig.`,
        ],
      },
      button: { link: data.link, text: "Neues Passwort setzen" },
      note: IGNORE_NOTE,
      en: `Use the button to set a new password. The link is valid for ${valid.en}.`,
    }),
  };
};

export const stdTemplatePasswordResetWelcome: EmailTemplateFunction = async (
  data,
) => ({
  subject: truncateSubject(`Willkommen bei ${data.appName}`),
  html: renderEmail({
    appName: data.appName,
    logoUrl: data.logoUrl,
    de: {
      heading: "Willkommen",
      lines: ["Ihr Konto ist eingerichtet. Legen Sie jetzt Ihr Passwort fest."],
    },
    button: { link: data.link, text: "Passwort festlegen" },
    en: "Your account is ready. Set your password to get started.",
  }),
});

// ----- invitations --------------------------------------------------------------

const invitationHeading = (orgName?: string) =>
  orgName ? `Einladung zu ${escapeHtml(orgName)}` : "Sie wurden eingeladen";

export const stdTemplateInviteToOrganization: EmailTemplateFunction = async (
  data,
) => {
  const orgName = data.tenant?.name;
  const org = escapeHtml(orgName ?? data.appName);
  const app = escapeHtml(data.appName);
  return {
    subject: truncateSubject(
      orgName
        ? `Einladung zu ${orgName} – ${data.appName}`
        : `Einladung zu ${data.appName}`,
    ),
    html: renderEmail({
      appName: data.appName,
      logoUrl: data.logoUrl,
      de: {
        heading: invitationHeading(orgName),
        lines: [
          orgName
            ? `Sie wurden eingeladen, ${strong(org)} auf ${app} beizutreten. Registrieren Sie sich, um loszulegen.`
            : `Sie wurden eingeladen, ${strong(app)} beizutreten. Registrieren Sie sich, um loszulegen.`,
        ],
      },
      button: { link: data.link, text: "Einladung annehmen" },
      note: UNEXPECTED_NOTE,
      en: `You have been invited to join ${org}. Sign up to get started.`,
    }),
  };
};

export const stdTemplateInviteToOrganizationWhenUserExists: EmailTemplateFunction =
  async (data) => {
    const orgName = data.tenant?.name;
    const org = orgName ? escapeHtml(orgName) : "einer Organisation";
    return {
      subject: truncateSubject(
        `Einladung zu ${orgName ?? "einer Organisation"} – ${data.appName}`,
      ),
      html: renderEmail({
        appName: data.appName,
        logoUrl: data.logoUrl,
        de: {
          heading: invitationHeading(orgName),
          lines: [
            `Sie wurden eingeladen, ${strong(org)} beizutreten. Die Einladung ist 7 Tage gültig.`,
          ],
        },
        button: { link: data.link, text: "Einladung annehmen" },
        note: UNEXPECTED_NOTE,
        en: `You have been invited to join ${orgName ? org : "an organisation"}. The invitation is valid for 7 days.`,
      }),
    };
  };
