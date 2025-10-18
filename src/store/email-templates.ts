import type { EmailTemplateFunction } from "../types";

// HTML email wrapper to unify style and structure for all emails
function htmlEmailWrapper({
  appName,
  logoUrl,
  englishContent,
  germanContent,
  buttonLink,
  buttonText,
}: {
  appName: string;
  logoUrl?: string;
  englishContent: string;
  germanContent: string;
  buttonLink?: string;
  buttonText?: string;
}): string {
  // Button HTML if link and text are provided
  const buttonHtml =
    buttonLink && buttonText
      ? `<div style="text-align: center"><a href="${buttonLink}" class="button" style="display: inline-block; padding: 10px 20px; margin: 20px 0; background-color: #a7476f; color: white; text-decoration: none; border-radius: 4px;">${buttonText}</a></div>`
      : "";

  // Logo HTML if logoUrl is provided
  const logoHtml = logoUrl
    ? `<img src="${logoUrl}" alt="${appName} Logo" style="max-width: 100px; height: auto; margin-bottom: 15px;" />`
    : "";

  return `
    <!DOCTYPE html>
    <html lang="de">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${appName}</title>
        <style>
          body {
            font-family: Arial, Helvetica, sans-serif;
            margin: 0;
            padding: 0;
            background-color: #f4f4f4;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #ffffff;
          }
          .header {
            text-align: center;
            padding: 20px 0;
            border-bottom: 1px solid #eeeeee;
          }
          .content {
            padding: 30px 20px;
            line-height: 1.5;
          }
          .footer {
            text-align: center;
            padding: 20px;
            font-size: 12px;
            color: #777777;
            border-top: 1px solid #eeeeee;
          }
          .button {
            display: inline-block;
            padding: 10px 20px;
            margin: 20px 0;
            background-color: #a7476f;
            color: white;
            text-decoration: none;
            border-radius: 4px;
          }
          @media only screen and (max-width: 600px) {
            .container {
              width: 100%;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            ${logoHtml}
            <h1>${appName}</h1>
          </div>
          <div class="content">
            ${englishContent}
            <hr style="margin: 32px 0; border: none; border-top: 1px solid #eee;" />
            ${germanContent}
          </div>
          ${buttonHtml}
          <div class="footer">
            <p>© ${appName}. All rights reserved.</p>
          </div>
        </div>
      </body>
    </html>
  `;
}

export const stdTemplateMagicLink: EmailTemplateFunction = async (data) => {
  // English content for the magic link email
  const englishContent = `
    <h2>Login to ${data.appName}</h2>
    <p>Hello,</p>
    <p>You've requested to log in to your account. Click the button below to securely access your account:</p>
    <p style="text-align: center; font-weight: bold;">Login link is valid for 15 minutes.</p>
    <p>If you didn't request this login link, you can safely ignore this email.</p>
    <p>Best regards,<br>The ${data.appName} Team</p>
  `;

  // German content for the magic link email
  const germanContent = `
    <h2>Anmeldung bei ${data.appName}</h2>
    <p>Hallo,</p>
    <p>Sie haben einen Login-Link für Ihr Konto angefordert. Klicken Sie auf den Button unten, um sich sicher anzumelden:</p>
    <p style="text-align: center; font-weight: bold;">Der Link ist 15 Minuten gültig.</p>
    <p>Falls Sie diesen Login-Link nicht angefordert haben, können Sie diese E-Mail ignorieren.</p>
    <p>Viele Grüße,<br>Ihr ${data.appName}-Team</p>
  `;

  return {
    html: htmlEmailWrapper({
      appName: data.appName,
      logoUrl: data.logoUrl,
      englishContent,
      germanContent,
      buttonLink: data.link,
      buttonText: "Log In Now / Jetzt einloggen",
    }),
    subject: `Your Login Link for ${data.appName} / Ihr Login-Link für ${data.appName}`,
  };
};

export const stdTemplateVerifyEmail: EmailTemplateFunction = async (data) => {
  // English content for the verify email
  const englishContent = `
    <h2>Verify your Email</h2>
    <p>Hello,</p>
    <p>You've requested to verify your email. Click the button below to securely confirm your email address:</p>
    <p style="text-align: center; font-weight: bold;">Verification link is valid for 15 minutes.</p>
    <p>If you didn't request this verification link, you can safely ignore this email.</p>
    <p>Best regards,<br>The ${data.appName} Team</p>
  `;

  // German content for the verify email
  const germanContent = `
    <h2>Bestätigen Sie Ihre E-Mail-Adresse</h2>
    <p>Hallo,</p>
    <p>Sie haben darum gebeten, Ihre E-Mail-Adresse zu bestätigen. Klicken Sie auf den Button unten, um Ihre E-Mail-Adresse sicher zu bestätigen:</p>
    <p style="text-align: center; font-weight: bold;">Der Bestätigungslink ist 15 Minuten gültig.</p>
    <p>Falls Sie diesen Bestätigungslink nicht angefordert haben, können Sie diese E-Mail ignorieren.</p>
    <p>Viele Grüße,<br>Ihr ${data.appName}-Team</p>
  `;

  return {
    html: htmlEmailWrapper({
      appName: data.appName,
      logoUrl: data.logoUrl,
      englishContent,
      germanContent,
      buttonLink: data.link,
      buttonText: "Verify Email / E-Mail bestätigen",
    }),
    subject: `Verify your email for ${data.appName} / E-Mail-Bestätigung für ${data.appName}`,
  };
};

export const stdTemplatePasswordReset: EmailTemplateFunction = async (data) => {
  // English content for password reset
  const englishContent = `
    <h2>Reset Your Password</h2>
    <p>Hello,</p>
    <p>You (or someone else) requested a password reset. If this was you, please click the button below to set a new password:</p>
    <p style="text-align: center; font-weight: bold;">Password reset link is valid for 15 minutes.</p>
    <p>If you did not request this, you can ignore this email.</p>
    <p>Best regards,<br>The ${data.appName} Team</p>
  `;

  // German content for password reset
  const germanContent = `
    <h2>Setzen Sie Ihr Passwort zurück</h2>
    <p>Hallo,</p>
    <p>Sie (oder jemand anderes) haben eine Zurücksetzung Ihres Passworts angefordert. Wenn Sie das waren, klicken Sie bitte auf den Button unten, um ein neues Passwort zu setzen:</p>
    <p style="text-align: center; font-weight: bold;">Der Link zum Zurücksetzen ist 15 Minuten gültig.</p>
    <p>Falls Sie dies nicht angefordert haben, können Sie diese E-Mail ignorieren.</p>
    <p>Viele Grüße,<br>Ihr ${data.appName}-Team</p>
  `;

  return {
    html: htmlEmailWrapper({
      appName: data.appName,
      logoUrl: data.logoUrl,
      englishContent,
      germanContent,
      buttonLink: data.link,
      buttonText: "Reset Password / Passwort zurücksetzen",
    }),
    subject: `Reset your password for ${data.appName} / Passwort zurücksetzen für ${data.appName}`,
  };
};

export const stdTemplatePasswordResetWelcome: EmailTemplateFunction = async (
  data
) => {
  // English content for welcome password set
  const englishContent = `
    <h2>Welcome to ${data.appName}</h2>
    <p>Hello,</p>
    <p>Please click the button below to set your password for ${data.appName}.</p>
    <p>Best regards,<br>The ${data.appName} Team</p>
  `;

  // German content for welcome password set
  const germanContent = `
    <h2>Willkommen bei ${data.appName}</h2>
    <p>Hallo,</p>
    <p>Bitte klicken Sie auf den Button unten, um Ihr Passwort für ${data.appName} zu setzen.</p>
    <p>Viele Grüße,<br>Ihr ${data.appName}-Team</p>
  `;

  return {
    html: htmlEmailWrapper({
      appName: data.appName,
      logoUrl: data.logoUrl,
      englishContent,
      germanContent,
      buttonLink: data.link,
      buttonText: "Set Password / Passwort setzen",
    }),
    subject: `Welcome to ${data.appName} / Willkommen bei ${data.appName}`,
  };
};

export const stdTemplateInviteToOrganization: EmailTemplateFunction = async (
  data
) => {
  // Determine organisation name if present
  const orgName = data.organisation?.name;

  // English content for organization invite
  const englishContent = orgName
    ? `
      <h2>Invitation to Join ${orgName} on ${data.appName}</h2>
      <p>Hello,</p>
      <p>You have been invited to join <strong>${orgName}</strong> on ${data.appName}. Please click the button below to register and join:</p>
      <p>Best regards,<br>The ${data.appName} Team</p>
    `
    : `
      <h2>Invitation to Join ${data.appName}</h2>
      <p>Hello,</p>
      <p>You have been invited to join ${data.appName}. Please click the button below to register and join:</p>
      <p>Best regards,<br>The ${data.appName} Team</p>
    `;

  // German content for organization invite
  const germanContent = orgName
    ? `
      <h2>Einladung zu ${orgName} auf ${data.appName}</h2>
      <p>Hallo,</p>
      <p>Sie wurden eingeladen, <strong>${orgName}</strong> auf ${data.appName} beizutreten. Bitte klicken Sie auf den Button unten, um sich zu registrieren und beizutreten:</p>
      <p>Viele Grüße,<br>Ihr ${data.appName}-Team</p>
    `
    : `
      <h2>Einladung zu ${data.appName}</h2>
      <p>Hallo,</p>
      <p>Sie wurden eingeladen, ${data.appName} beizutreten. Bitte klicken Sie auf den Button unten, um sich zu registrieren und beizutreten:</p>
      <p>Viele Grüße,<br>Ihr ${data.appName}-Team</p>
    `;

  // Subject with organisation name if present
  const subject = orgName
    ? `Invitation to Join ${orgName} on ${data.appName} / Einladung zu ${orgName} auf ${data.appName}`
    : `Invitation to Join ${data.appName} / Einladung zu ${data.appName}`;

  return {
    html: htmlEmailWrapper({
      appName: data.appName,
      logoUrl: data.logoUrl,
      englishContent,
      germanContent,
      buttonLink: data.link,
      buttonText: "Register Now / Jetzt registrieren",
    }),
    subject,
  };
};

export const stdTemplateInviteToOrganizationWhenUserExists: EmailTemplateFunction =
  async (data) => {
    // Determine organisation name if present
    const orgName = data.organisation?.name;

    // English content for existing user organization invite
    const englishContent = orgName
      ? `
        <h2>You've Been Invited to Join ${orgName} on ${data.appName}</h2>
        <p>Hello,</p>
        <p>You have been invited to join <strong>${orgName}</strong> on ${data.appName}. Click the button below to accept the invitation:</p>
        <p style="text-align: center; font-weight: bold;">This invitation link will expire in 7 days.</p>
        <p>If you did not expect this invitation, you can safely ignore this email.</p>
        <p>Best regards,<br>The ${data.appName} Team</p>
      `
      : `
        <h2>You've Been Invited to Join an Organization</h2>
        <p>Hello,</p>
        <p>You have been invited to join an organization on ${data.appName}. Click the button below to accept the invitation:</p>
        <p style="text-align: center; font-weight: bold;">This invitation link will expire in 7 days.</p>
        <p>If you did not expect this invitation, you can safely ignore this email.</p>
        <p>Best regards,<br>The ${data.appName} Team</p>
      `;

    // German content for existing user organization invite
    const germanContent = orgName
      ? `
        <h2>Sie wurden zu ${orgName} auf ${data.appName} eingeladen</h2>
        <p>Hallo,</p>
        <p>Sie wurden eingeladen, <strong>${orgName}</strong> auf ${data.appName} beizutreten. Klicken Sie auf den Button unten, um die Einladung anzunehmen:</p>
        <p style="text-align: center; font-weight: bold;">Der Einladungslink ist 7 Tage gültig.</p>
        <p>Falls Sie diese Einladung nicht erwartet haben, können Sie diese E-Mail ignorieren.</p>
        <p>Viele Grüße,<br>Ihr ${data.appName}-Team</p>
      `
      : `
        <h2>Sie wurden zu einer Organisation eingeladen</h2>
        <p>Hallo,</p>
        <p>Sie wurden eingeladen, einer Organisation auf ${data.appName} beizutreten. Klicken Sie auf den Button unten, um die Einladung anzunehmen:</p>
        <p style="text-align: center; font-weight: bold;">Der Einladungslink ist 7 Tage gültig.</p>
        <p>Falls Sie diese Einladung nicht erwartet haben, können Sie diese E-Mail ignorieren.</p>
        <p>Viele Grüße,<br>Ihr ${data.appName}-Team</p>
      `;

    // Subject with organisation name if present
    const subject = orgName
      ? `Invitation to Join ${orgName} on ${data.appName} / Einladung zu ${orgName} auf ${data.appName}`
      : `Invitation to Join an Organization on ${data.appName} / Einladung zu einer Organisation auf ${data.appName}`;

    return {
      html: htmlEmailWrapper({
        appName: data.appName,
        logoUrl: data.logoUrl,
        englishContent,
        germanContent,
        buttonLink: data.link,
        buttonText: "Accept Invitation / Einladung annehmen",
      }),
      subject,
    };
  };
