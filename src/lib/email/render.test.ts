import { describe, it, expect } from "bun:test";
import { escapeHtml, formatDuration, renderEmail } from "./render";
import {
  stdTemplateEmailLoginCode,
  stdTemplateMagicLink,
  stdTemplateVerifyEmailChange,
} from "../../store/email-templates";
import { _GLOBAL_SERVER_CONFIG } from "../../store";

/**
 * The shared mail layout and the default templates built on it: the parts a
 * person sees (wordmark or logo, button, code, English line) end up in the
 * HTML, user-typed values are escaped, and validity periods follow the
 * configured TTLs instead of fixed copy.
 */
describe("renderEmail", () => {
  it("renders wordmark, heading, button, code, note and English line", () => {
    const html = renderEmail({
      appName: "Demo <App>",
      de: { heading: "Anmelden", lines: ["Zeile eins"] },
      button: { link: "https://example.com/go", text: "Los" },
      code: "123456",
      note: "Hinweis",
      en: "Sign in.",
    });
    expect(html).toContain("Demo &lt;App&gt;");
    expect(html).toContain("Anmelden");
    expect(html).toContain("Zeile eins");
    expect(html).toContain('href="https://example.com/go"');
    expect(html).toContain("123456");
    expect(html).toContain("Hinweis");
    expect(html).toContain("Sign in.");
  });

  it("shows the logo instead of the wordmark when set", () => {
    const html = renderEmail({
      appName: "Demo",
      logoUrl: "https://example.com/logo.png",
      de: { heading: "H", lines: [] },
      en: "E",
    });
    expect(html).toContain('<img src="https://example.com/logo.png"');
  });

  it("leaves the button out without a link", () => {
    const html = renderEmail({
      appName: "Demo",
      de: { heading: "H", lines: [] },
      button: { text: "Los" },
      en: "E",
    });
    expect(html).not.toContain("<a ");
  });
});

describe("formatDuration", () => {
  it("picks the largest whole unit", () => {
    expect(formatDuration(900)).toEqual({ de: "15 Minuten", en: "15 minutes" });
    expect(formatDuration(3600)).toEqual({ de: "1 Stunde", en: "1 hour" });
    expect(formatDuration(60 * 60 * 24 * 7)).toEqual({
      de: "7 Tage",
      en: "7 days",
    });
    expect(formatDuration(90)).toEqual({ de: "90 Sekunden", en: "90 seconds" });
  });
});

describe("default templates", () => {
  const base = { appName: "Demo", baseUrl: "https://example.com" };

  it("states the configured magic-link validity", async () => {
    const previous = _GLOBAL_SERVER_CONFIG.magicLinkTtl;
    _GLOBAL_SERVER_CONFIG.magicLinkTtl = 60 * 30;
    try {
      const mail = await stdTemplateMagicLink({
        ...base,
        link: "https://example.com/magic",
      });
      expect(mail.subject).toBe("Ihr Login-Link für Demo");
      expect(mail.html).toContain("30 Minuten");
      expect(mail.html).toContain("30 minutes");
      expect(mail.html).toContain('href="https://example.com/magic"');
    } finally {
      _GLOBAL_SERVER_CONFIG.magicLinkTtl = previous;
    }
  });

  it("shows the one-time code", async () => {
    const mail = await stdTemplateEmailLoginCode({ ...base, code: "987654" });
    expect(mail.html).toContain("987654");
  });

  it("escapes the new address of an e-mail change", async () => {
    const mail = await stdTemplateVerifyEmailChange({
      ...base,
      link: "https://example.com/confirm",
      newEmail: '<script>alert("x")</script>@example.com',
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain(escapeHtml("<script>"));
  });
});
