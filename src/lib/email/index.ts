import nodemailer from "nodemailer";
import * as v from "valibot";
import log from "../log";
import { _GLOBAL_SERVER_CONFIG } from "../../store";

/**
 * Console-mode DX shortcut: detect a magic login link inside the email content
 * by matching any URL that points at the configured magicLoginVerifyUrl path.
 * Returns the bare link (or null if none is found). Only used in console mode
 * so that a developer sees just the login URL instead of the whole email.
 */
function extractMagicLoginLink(content: string): string | null {
  const path = _GLOBAL_SERVER_CONFIG.magicLoginVerifyUrl;
  if (!path) return null;
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`https?://[^\\s"'<>]*${escapedPath}[^\\s"'<>]*`, "i");
  const match = content.match(re);
  if (!match) return null;
  return match[0].replace(/&amp;/g, "&");
}

/** Convert HTML to plain text for console so links (e.g. magic link) are visible. */
function htmlToPlainText(html: string): string {
  let s = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  // Preserve links as "text (url)" so URLs remain visible in plain text
  s = s.replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, url, text) => {
    const cleanUrl = url.replace(/&amp;/g, "&");
    const cleanText = text.replace(/<[^>]+>/g, "").trim();
    if (!cleanText || cleanText === cleanUrl) return cleanUrl + "\n";
    return `${cleanText} (${cleanUrl})\n`;
  });
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

const emailSchema = v.object({
  sender: v.optional(v.string()),
  recipients: v.array(v.pipe(v.string(), v.email())),
  subject: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  text: v.optional(v.string()),
  html: v.optional(v.string()),
});

export interface EmailOptions {
  sender?: string;
  recipients: string[];
  subject: string;
  text?: string;
  html?: string;
}

/**
 * Check if console mode is enabled (fake SMTP for development)
 * When SMTP_HOST is "console.localhost", emails are logged to console instead of being sent
 */
const isConsoleMode = (): boolean => {
  return process.env.SMTP_HOST === "console.localhost";
};

const getMailCredentials = () => {
  return {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  };
};

class SMTPService {
  private transporter: nodemailer.Transporter | null = null;
  private logEnabled: boolean = false;
  private consoleMode: boolean = false;

  constructor() {
    this.logEnabled = process.env.SMTP_DEBUG === "true";
    this.consoleMode = isConsoleMode();

    if (!this.consoleMode) {
      this.transporter = nodemailer.createTransport(getMailCredentials());
    } else {
      console.log(
        "📧 SMTP Console Mode enabled - emails will be logged to console"
      );
    }
  }

  private log(message: string): void {
    if (this.logEnabled) {
      log.logCustom({ name: "SMTPService" }, `Log: ${message}`);
    }
  }

  private error(message: string): void {
    if (this.logEnabled) {
      log.logCustom({ name: "SMTPService" }, `Error: ${message}`);
    }
  }

  async sendMail({
    sender,
    recipients,
    subject,
    text,
    html,
  }: EmailOptions): Promise<boolean> {
    // Validate email options first
    try {
      v.parse(emailSchema, {
        sender,
        recipients,
        subject,
        text,
        html,
      });

      if (!text && !html) {
        throw new Error("Text or HTML body is required");
      }
    } catch (error) {
      this.error(`Email validation failed: ${error}`);
      return false;
    }

    // Console mode: log email to console instead of sending
    if (this.consoleMode) {
      const from = sender || process.env.SMTP_DEFAULT_SENDER || "unknown";
      const to = recipients.join(", ");

      // Magic login shortcut: if the email contains a magic login link,
      // output ONLY the link (console + file) for a faster dev login flow.
      const magicLoginLink = extractMagicLoginLink(html || text || "");
      if (magicLoginLink) {
        console.log("\n" + "=".repeat(60));
        console.log("🔑 MAGIC LOGIN LINK (Console Mode)");
        console.log("=".repeat(60));
        console.log(`To: ${to}`);
        console.log(magicLoginLink);
        console.log("=".repeat(60) + "\n");

        const timestamp = new Date().toISOString();
        const filePath = await log.writeEmailFile({
          timestamp,
          from,
          to,
          subject,
          body: magicLoginLink,
        });
        if (filePath) {
          console.log(`📁 Login link saved to: ${filePath}`);
        }

        this.log(`[Console Mode] Magic login link logged: ${subject}`);
        return true;
      }

      const body = text || htmlToPlainText(html || "");

      console.log("\n" + "=".repeat(60));
      console.log("📧 EMAIL (Console Mode - Not Actually Sent)");
      console.log("=".repeat(60));
      console.log(`From:    ${from}`);
      console.log(`To:      ${to}`);
      console.log(`Subject: ${subject}`);
      console.log("-".repeat(60));
      console.log(body);
      console.log("=".repeat(60) + "\n");

      const timestamp = new Date().toISOString();
      const filePath = await log.writeEmailFile({ timestamp, from, to, subject, body, html });
      if (filePath) {
        console.log(`📁 Email saved to: ${filePath}`);
      }

      this.log(`[Console Mode] Email logged: ${subject}`);
      return true;
    }

    // Real SMTP mode: send email with retries
    const maxRetries = 3;
    const retryInterval = 15 * 60 * 1000; // 15 minutes in milliseconds
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        const info = await this.transporter!.sendMail({
          from: sender || process.env.SMTP_DEFAULT_SENDER,
          to: recipients.join(", "),
          subject,
          text,
          html,
        });

        this.log(`Message sent: ${info.messageId}`);
        this.log(JSON.stringify(info));
        return true;
      } catch (error) {
        attempt++;
        this.error(
          `Failed to send email (Attempt ${attempt}/${maxRetries}): ${error}`
        );
        this.error(
          JSON.stringify({ ...getMailCredentials(), auth: undefined })
        );

        if (attempt < maxRetries) {
          this.log(
            `Waiting ${retryInterval / 1000} seconds before next attempt...`
          );
          await new Promise((resolve) => setTimeout(resolve, retryInterval));
        }
      }
    }

    this.error(`Failed to send email after ${maxRetries} attempts`);
    return false;
  }

  async sendTestMail(recipient: string): Promise<boolean> {
    const testEmailOptions: EmailOptions = {
      recipients: [recipient],
      subject: "SMTP Test Email from symbiosika-framework",
      html: "<h1>SMTP Test Email</h1><p>This is a test email to verify SMTP configuration.</p>",
    };

    const result = await this.sendMail(testEmailOptions);
    if (result) {
      this.log("Test email sent successfully");
    } else {
      this.error("Failed to send test email");
    }
    return result;
  }

  async verifyConnection(): Promise<boolean> {
    // Console mode always returns true
    if (this.consoleMode) {
      this.log("[Console Mode] SMTP connection verification skipped");
      return true;
    }

    return new Promise((resolve) =>
      this.transporter!.verify((error) => {
        if (error) {
          this.error(`SMTP connection verification failed: ${error}`);
          this.error(
            JSON.stringify({ ...getMailCredentials(), auth: undefined })
          );
          resolve(false);
        } else {
          this.log("SMTP connection verified successfully");
          resolve(true);
        }
      })
    );
  }
}

export const smtpService = new SMTPService();
