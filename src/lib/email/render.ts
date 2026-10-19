/**
 * The look of every mail the framework sends: white background, the app name
 * as a text wordmark (or the configured logo), one heading, one or two short
 * lines, an optional one-time code, a single dark button and a muted closing
 * note. German first, a compact English line below a hairline.
 *
 * Inline styles and a table layout only, since mail clients strip most CSS.
 *
 * Apps use the same renderer for their own mails so that everything a person
 * receives from the server looks alike:
 *
 * ```ts
 * import { renderEmail, escapeHtml } from "@framework/lib/email/render";
 *
 * await smtpService.sendMail({
 *   recipients: [user.email],
 *   subject: "Export fertig",
 *   html: renderEmail({
 *     appName,
 *     de: { heading: "Export fertig", lines: [`${escapeHtml(name)} ist bereit.`] },
 *     button: { link, text: "Herunterladen" },
 *     en: "Your export is ready.",
 *   }),
 * });
 * ```
 */

export const EMAIL_COLORS = {
  text: "#18181b",
  muted: "#71717a",
  hairline: "#e4e4e7",
  codeBg: "#f4f4f5",
  button: "#18181b",
  buttonText: "#ffffff",
};

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, Helvetica, sans-serif";

/**
 * Escape a value interpolated into the HTML body of a mail (names, addresses,
 * anything a user typed). Text passed to {@link renderEmail} as `heading`,
 * `lines` or `note` is NOT escaped, so it may carry trusted inline markup.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Emphasise a (already escaped) value inside a line, e.g. an address. */
export const strong = (html: string) =>
  `<strong style="color: ${EMAIL_COLORS.text};">${html}</strong>`;

/** Email validation caps subjects at 100 characters. */
export function truncateSubject(subject: string, maxLength = 100): string {
  return subject.length <= maxLength
    ? subject
    : subject.substring(0, maxLength - 3) + "...";
}

export interface EmailBlock {
  heading: string;
  /** Short lines; may contain trusted inline markup (escape user values). */
  lines: string[];
}

export interface RenderEmailOptions {
  appName: string;
  /** Shown instead of the text wordmark when set. */
  logoUrl?: string;
  de: EmailBlock;
  /** One-sentence English summary below the German text. */
  en: string;
  button?: { link?: string; text: string };
  /** One-time code, shown large. */
  code?: string;
  /** Muted closing hint, e.g. "ignore this mail if …". */
  note?: string;
}

export function renderEmail({
  appName,
  logoUrl,
  de,
  en,
  button,
  code,
  note,
}: RenderEmailOptions): string {
  const p = (text: string, size = "15px", color = EMAIL_COLORS.muted) =>
    `<p style="margin: 0 0 12px; font-size: ${size}; line-height: 1.6; color: ${color};">${text}</p>`;

  const brandHtml = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(appName)}" height="28" style="display: block; height: 28px; width: auto; margin: 0 0 32px; border: 0;" />`
    : `<p style="margin: 0 0 32px; font-size: 14px; font-weight: 700; letter-spacing: -0.1px; color: ${EMAIL_COLORS.text};">${escapeHtml(appName)}</p>`;

  const codeHtml = code
    ? `<p style="margin: 8px 0 20px; padding: 14px 0; background: ${EMAIL_COLORS.codeBg}; border-radius: 8px; text-align: center; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 30px; font-weight: 700; letter-spacing: 8px; color: ${EMAIL_COLORS.text};">${escapeHtml(code)}</p>`
    : "";

  const buttonHtml = button?.link
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 8px 0 24px;">
        <tr>
          <td bgcolor="${EMAIL_COLORS.button}" style="border-radius: 6px;">
            <a href="${button.link}" style="display: inline-block; padding: 12px 22px; font-size: 14px; font-weight: 600; color: ${EMAIL_COLORS.buttonText}; text-decoration: none; border-radius: 6px;">${button.text}</a>
          </td>
        </tr>
      </table>`
    : "";

  return `<!DOCTYPE html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light" />
    <title>${escapeHtml(appName)}</title>
  </head>
  <body style="margin: 0; padding: 0; background-color: #ffffff;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #ffffff;">
      <tr>
        <td align="center" style="padding: 40px 20px;">
          <table role="presentation" width="440" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 440px; font-family: ${FONT}; text-align: left;">
            <tr>
              <td>
                ${brandHtml}
                <h1 style="margin: 0 0 12px; font-size: 22px; font-weight: 700; line-height: 1.3; color: ${EMAIL_COLORS.text};">${de.heading}</h1>
                ${de.lines.map((line) => p(line)).join("")}
                ${codeHtml}
                ${buttonHtml}
                ${note ? p(note, "13px") : ""}
                <hr style="border: none; border-top: 1px solid ${EMAIL_COLORS.hairline}; margin: 28px 0 16px;" />
                ${p(en, "12px")}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * A validity period for the mail copy, e.g. 900 → "15 Minuten" / "15 minutes".
 * Picks the largest whole unit so configured TTLs read naturally.
 */
export function formatDuration(seconds: number): { de: string; en: string } {
  const units: [number, string, string, string, string][] = [
    [86400, "Tag", "Tage", "day", "days"],
    [3600, "Stunde", "Stunden", "hour", "hours"],
    [60, "Minute", "Minuten", "minute", "minutes"],
    [1, "Sekunde", "Sekunden", "second", "seconds"],
  ];
  for (const [size, deOne, deMany, enOne, enMany] of units) {
    if (seconds >= size && seconds % size === 0) {
      const n = seconds / size;
      return {
        de: `${n} ${n === 1 ? deOne : deMany}`,
        en: `${n} ${n === 1 ? enOne : enMany}`,
      };
    }
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return {
    de: `${minutes} ${minutes === 1 ? "Minute" : "Minuten"}`,
    en: `${minutes} ${minutes === 1 ? "minute" : "minutes"}`,
  };
}
