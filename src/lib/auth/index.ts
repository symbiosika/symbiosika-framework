import { eq, and, isNull } from "drizzle-orm";
import {
  invitationCodes,
  organisationMembers,
  sessions,
  users,
  type UserSelectBasic,
} from "../db/db-schema";
import { getDb } from "../db/db-connection";
import jwt from "jsonwebtoken";
import {
  sendMagicLink,
  sendVerificationEmail,
  verifyEmail,
  verifyMagicLink,
  sendResetPasswordLink,
} from "./magic-link";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { preRegisterCustomVerifications, postRegisterActions } from "./actions";
import log from "../log";
import { addOrganisationMember } from "../usermanagement/oganisations";
import { updateUser } from "../usermanagement/user";
import {
  acceptAllPendingInvitationsForUser,
  acceptOrganisationInvitation,
  getPendingInvitationsForEmail,
} from "../usermanagement/invitations";

const JWT_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY || "";

/**
 * Hashes a password
 */
export const saltAndHashPassword = async (
  password: string
): Promise<string> => {
  const hash = await Bun.password.hash(password);
  return hash;
};

/**
 * Gets a user from the database
 */
const getUserFromDb = async (
  email: string,
  password: string,
  sendMailIfUserNotVerified = true
): Promise<{
  id: string;
  email: string;
  emailVerified: boolean;
  password: string | null;
  firstname: string;
  surname: string;
}> => {
  // no-role-check necessary here
  try {
    const user = await getDb()
      .select({
        id: users.id,
        email: users.email,
        emailVerified: users.emailVerified,
        password: users.password,
        firstname: users.firstname,
        surname: users.surname,
      })
      .from(users)
      .where(eq(users.email, email));

    if (user.length === 0 || !user[0].password) {
      throw "user not found";
    }

    if (!user[0].emailVerified) {
      // send verification email again
      if (sendMailIfUserNotVerified) {
        await sendVerificationEmail(email);
      }
      throw "Email is not verified.";
    }

    const isMatch = await Bun.password.verify(password, user[0].password + "");

    if (isMatch) {
      return user[0];
    } else {
      throw "passwords do not match";
    }
  } catch (error) {
    console.log(error);
    throw error;
  }
};

/**
 * Sets a user in the database
 */
const setUserInDb = async (
  email: string,
  password: string,
  sendMailAfterRegister: boolean
) => {
  const hash = await saltAndHashPassword(password);

  const user = await getDb()
    .insert(users)
    .values({
      email: email,
      password: hash,
      firstname: "",
      surname: "",
      extUserId: "",
      salt: "",
      emailVerified: false,
    })
    .returning()
    .catch(() => {
      throw "This email address is already in use.";
    });

  // send verification email. no need to wait for it
  if (sendMailAfterRegister) {
    sendVerificationEmail(email).catch((err) => {
      throw "Error sending verification email. " + err;
    });
  }

  return user[0];
};

/**
 * Generates a JWT for a user
 */
export const generateJwt = async (
  user: {
    id: string;
    email: string;
    firstname: string;
    surname: string;
  },
  expiresIn: number,
  additionalClaims?: Record<string, any>
) => {
  const claims = {
    email: user.email,
    sub: user.id,
    symbiosika: { roles: [] },
    ...additionalClaims,
  };

  const token = jwt.sign(claims, JWT_PRIVATE_KEY, { expiresIn });

  return {
    token,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  };
};

/**
 * Checks if a user exists and creates a session
 */
const checkAndCreateSession = async (
  email: string,
  password: string,
  sendVerificationEmail = true
) => {
  const user = await getUserFromDb(email, password, sendVerificationEmail);

  const { token, expiresAt } = await generateJwt(
    user,
    _GLOBAL_SERVER_CONFIG.jwtExpiresAfter
  );
  const session = await getDb()
    .insert(sessions)
    .values({
      sessionToken: "",
      userId: user.id,
      expires: expiresAt.toISOString(),
    })
    .onConflictDoUpdate({
      target: sessions.sessionToken,
      set: {
        expires: expiresAt.toISOString(),
      },
    })
    .returning();
  return { token, expiresAt };
};

/**
 * Sets a new password for a user
 */
const setNewPassword = async (userId: string, newPassword: string) => {
  const hash = await saltAndHashPassword(newPassword);

  const updatedUser = await getDb()
    .update(users)
    .set({ password: hash })
    .where(eq(users.id, userId))
    .returning();

  if (updatedUser.length === 0) {
    throw "User not found";
  }

  return updatedUser[0];
};

/**
 * Changes a password for a user
 */
const changePassword = async (
  email: string,
  oldPassword: string,
  newPassword: string
) => {
  try {
    // Verify old password first
    const user = await getUserFromDb(email, oldPassword);
    // If verification successful, set new password
    return await setNewPassword(user.id, newPassword);
  } catch (error) {
    throw error;
  }
};

/**
 * Check if a general invitation code is valid
 * This will check if there are any general invitation codes and if the provided code is valid
 * If the code is valid, it will return the organisationId to set if a organisation is provided
 */
const checkGeneralInvitationCode = async (
  code: string | undefined
): Promise<{
  usedInvitationCode: boolean;
  check: boolean;
  setOrganisationId: string | null;
}> => {
  const codes = await getDb()
    .select()
    .from(invitationCodes)
    .where(eq(invitationCodes.isActive, true));

  if (codes.length === 0) {
    return { usedInvitationCode: false, check: true, setOrganisationId: null }; // no general invitation codes active, so we can register without one
  } else if (!code) {
    throw "No invitation code provided but is required";
  } else {
    const found = codes.find((c) => c.code === code);
    if (!found) {
      throw "Invitation code not found";
    }
    return {
      usedInvitationCode: true,
      check: true,
      setOrganisationId: found.organisationId,
    };
  }
};

/**
 * Local authentication
 */
export const LocalAuth = {
  async authorize(email: string, password: string) {
    return await getUserFromDb(email, password);
  },

  async register(
    email: string,
    password: string,
    sendVerificationEmail: boolean,
    meta: {
      invitationCode?: string;
    }
  ) {
    log.info(`Registering user: ${email}`);
    
    // go through all pre-register custom verifications
    for (const verification of preRegisterCustomVerifications) {
      log.info(`Running pre-register custom verification`);
      const r = await verification(email, meta);
      if (!r.success) {
        throw "Custom verification failed: " + r.message;
      }
    }

    // check if the user has pending invitations
    const { invitedInOrganisationIds } =
      await getPendingInvitationsForEmail(email);

    // check if we can register without an invitation code
    // then we can skip the invitation code check
    let firstOrganisationId: string | null = null;
    if (invitedInOrganisationIds.length < 1) {
      const { usedInvitationCode, setOrganisationId } =
        await checkGeneralInvitationCode(meta?.invitationCode);
      firstOrganisationId = setOrganisationId;
    }

    // add user to db
    const user = await setUserInDb(email, password, sendVerificationEmail);
    log.info(`New user registered: ${user.id}`);

    // check if an organisation was provided via invitation code
    if (firstOrganisationId) {
      // check if the organisation has already members
      const members = await getDb()
        .select()
        .from(organisationMembers)
        .where(eq(organisationMembers.organisationId, firstOrganisationId));

      let role: "member" | "owner" = "member";
      if (members.length === 0) {
        role = "owner";
      }
      await addOrganisationMember(firstOrganisationId, user.id, role);
      await updateUser(user.id, {
        lastOrganisationId: firstOrganisationId,
      });
    }

    // accept all pending invitations if there are any
    if (invitedInOrganisationIds.length > 0) {
      for (const organisationId of invitedInOrganisationIds) {
        await acceptAllPendingInvitationsForUser(user.id, organisationId);
      }
    }

    // go through all post-register actions
    for (const action of postRegisterActions) {
      log.info(`Running post-register action`);
      await action(user.id, user.email);
    }

    return user;
  },

  async login(email: string, password: string, sendVerificationEmail = true) {
    return await checkAndCreateSession(email, password, sendVerificationEmail);
  },

  async loginWithMagicLink(token: string) {
    return await verifyMagicLink(token);
  },

  async sendMagicLink(email: string) {
    return await sendMagicLink(email);
  },

  async sendVerificationEmail(email: string) {
    return await sendVerificationEmail(email);
  },

  async verifyEmail(token: string) {
    return await verifyEmail(token);
  },

  async setNewPassword(userId: string, newPassword: string) {
    return await setNewPassword(userId, newPassword);
  },

  async changePassword(
    email: string,
    oldPassword: string,
    newPassword: string
  ) {
    return await changePassword(email, oldPassword, newPassword);
  },

  async refreshToken(userId: string) {
    const user = await getDb()
      .select({
        id: users.id,
        email: users.email,
        firstname: users.firstname,
        surname: users.surname,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (!user || user.length === 0) {
      throw "User not found";
    }
    const { token, expiresAt } = await generateJwt(
      user[0],
      _GLOBAL_SERVER_CONFIG.jwtExpiresAfter
    );
    return { token, expiresAt };
  },

  async forgotPasswort(email: string, sendWelcomeText = false) {
    // Check if user exists in DB (optional check for clarity)
    const user = await getDb()
      .select({
        id: users.id,
        email: users.email,
      })
      .from(users)
      .where(eq(users.email, email));
    if (!user || user.length === 0) {
      throw "User not found";
    }
    // Send password-reset link
    await sendResetPasswordLink(email, sendWelcomeText);
    return { message: "Reset password link has been sent to your email." };
  },
};
