import { createPublicKey, createVerify } from "crypto";
import { getDb } from "./lib/db/db-connection";
import { serverSettings } from "./lib/db/schema/server";
import { eq } from "drizzle-orm";
import { _GLOBAL_SERVER_CONFIG } from "./store";
import { html } from "hono/html";
import type { FastAppHono } from "./types";
import log from "./lib/log";

interface License {
  baseUrl: string;
  validUntil: string;
  features: string[];
  signature: string;
}

class LicenseManager {
  private publicKey: string;
  private isEnabled: boolean;

  constructor() {}

  public init() {
    this.isEnabled = _GLOBAL_SERVER_CONFIG.useLicenseSystem ?? false;
    this.publicKey = _GLOBAL_SERVER_CONFIG.publicKey ?? "";
    this.publicKey = this.publicKey.replaceAll("\r\n", "\n");
  }

  private async getLicenseFromDb(): Promise<string | null> {
    if (!this.isEnabled) return null;

    const result = await getDb()
      .select()
      .from(serverSettings)
      .where(eq(serverSettings.key, "LICENSE"))
      .limit(1);

    return result[0]?.value ?? null;
  }

  private verifyLicense(licenseData: string): boolean {
    try {
      const license: License = JSON.parse(licenseData);
      const verifier = createVerify("RSA-SHA256");

      // Ensure public key is in PEM format
      const publicKey = this.publicKey.includes("-----BEGIN PUBLIC KEY-----")
        ? this.publicKey
        : `-----BEGIN PUBLIC KEY-----\n${this.publicKey}\n-----END PUBLIC KEY-----`;

      // Validate the license data
      const dataToVerify = `${license.baseUrl};${license.validUntil};${license.features.join(",")}`;
      verifier.update(dataToVerify);
      verifier.end(); // Ensure the verifier is finalized

      const signatureBuffer = Buffer.from(license.signature, "base64");
      const verified = verifier.verify(publicKey, signatureBuffer);
      const isExpired =
        new Date(license.validUntil).getTime() < new Date().getTime();

      const baseUrlIsCorrect =
        license.baseUrl === _GLOBAL_SERVER_CONFIG.baseUrl;

      log.info(
        "license verified",
        verified + "",
        isExpired + "",
        baseUrlIsCorrect + ""
      );
      return verified && !isExpired && baseUrlIsCorrect;
    } catch (error) {
      log.error("License verification failed:", error + "");
      return false;
    }
  }

  async isValid(): Promise<boolean> {
    if (!this.isEnabled) return true;

    const licenseData = await this.getLicenseFromDb();
    if (!licenseData) return false;

    return this.verifyLicense(licenseData);
  }

  async setLicense(licenseKey: string): Promise<boolean> {
    if (!this.isEnabled) return true;

    if (!this.verifyLicense(licenseKey)) {
      return false;
    }

    await getDb()
      .insert(serverSettings)
      .values({
        key: "LICENSE",
        value: licenseKey,
      })
      .onConflictDoUpdate({
        target: [serverSettings.key],
        set: { value: licenseKey },
      });

    return true;
  }

  async getLicenseInfo(): Promise<License | null> {
    if (!this.isEnabled) return null;

    const licenseData = await this.getLicenseFromDb();
    if (!licenseData) return null;

    try {
      return JSON.parse(licenseData);
    } catch {
      return null;
    }
  }
}

export const licenseManager = new LicenseManager();

export const defineLicenseRoutes = (app: FastAppHono) => {
  if (!licenseManager.isValid()) return;

  app.get("/license", async (c) => {
    const licenseInfo = await licenseManager.getLicenseInfo();
    const isValid = await licenseManager.isValid();

    return c.html(html`
      <!DOCTYPE html>
      <html>
        <head>
          <title>License Management</title>
          <style>
            body {
              font-family:
                system-ui,
                -apple-system,
                sans-serif;
              max-width: 800px;
              margin: 2rem auto;
              padding: 0 1rem;
              line-height: 1.5;
            }
            .license-info {
              background: #f8f9fa;
              border-radius: 8px;
              padding: 1.5rem;
              margin-bottom: 2rem;
              box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
            }
            .status-valid {
              color: #198754;
            }
            .status-invalid {
              color: #dc3545;
            }
            textarea {
              width: 100%;
              padding: 0.5rem;
              border: 1px solid #dee2e6;
              border-radius: 4px;
              margin-bottom: 1rem;
            }
            button {
              background: #0d6efd;
              color: white;
              border: none;
              padding: 0.5rem 1rem;
              border-radius: 4px;
              cursor: pointer;
            }
            button:hover {
              background: #0b5ed7;
            }
          </style>
        </head>
        <body>
          <h1>License Management</h1>

          ${licenseInfo
            ? html`
                <div class="license-info">
                  <h2>Current License Status</h2>
                  <p>Base URL: ${licenseInfo.baseUrl}</p>
                  <p>Valid until: ${licenseInfo.validUntil}</p>
                  <p>
                    License status:
                    ${isValid
                      ? html`<span class="status-valid">Valid</span>`
                      : html`<span class="status-invalid">Invalid</span>`}
                  </p>
                  <p>Features: ${licenseInfo.features.join(", ")}</p>
                </div>
              `
            : html`<p>No license installed</p>`}

          <form action="/license" method="POST">
            <textarea
              name="license"
              rows="10"
              placeholder="Paste your license key here"
            ></textarea>
            <br />
            <button type="submit">Set License</button>
          </form>
        </body>
      </html>
    `);
  });

  app.post("/license", async (c) => {
    const body = await c.req.parseBody();
    const success = await licenseManager.setLicense(body.license as string);

    if (success) {
      return c.redirect("/license");
    } else {
      return c.html(html`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Invalid License</title>
          </head>
          <body>
            <h1>Invalid License</h1>
            <p>The provided license key is invalid.</p>
            <a href="/license">Try again</a>
          </body>
        </html>
      `);
    }
  });
};
