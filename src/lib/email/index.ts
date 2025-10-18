import nodemailer from "nodemailer";
import * as v from "valibot";
import log from "../log";

const emailSchema = v.object({
  sender: v.optional(v.string()),
  recipients: v.array(v.pipe(v.string(), v.email())),
  subject: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
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
  private transporter: nodemailer.Transporter;
  private logEnabled: boolean = false;

  constructor() {
    this.logEnabled = process.env.SMTP_DEBUG === "true";
    this.transporter = nodemailer.createTransport(getMailCredentials());
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
    const maxRetries = 3;
    const retryInterval = 15 * 60 * 1000; // 15 minutes in milliseconds
    let attempt = 0;

    while (attempt < maxRetries) {
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

        const info = await this.transporter.sendMail({
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
      subject: "SMTP Test Email from FastApp-Framework",
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
    return new Promise((resolve) =>
      this.transporter.verify((error) => {
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
