import { customAlphabet } from "nanoid";
import { getDb } from "../db/db-connection";
import { users } from "../db/schema/users";
import { sendWhatsAppMessage } from "../communication/whatsapp/send";
import log from "../log";
import { and, eq } from "drizzle-orm";

const nanoid = customAlphabet("1234567890", 6);

/**
 * Start phone number validation process by sending a PIN code via WhatsApp
 */
export async function setPhonePinNumber(
  userId: string
): Promise<{ pin: string }> {
  // Generate 6-digit PIN
  const pin = nanoid();

  try {
    // Update or create user with PIN
    await getDb()
      .update(users)
      .set({
        phonePinNumber: pin,
        phoneNumberVerified: false,
      })
      .where(eq(users.id, userId));

    return {
      pin,
    };
  } catch (error) {
    log.error("Error starting phone number validation", { error });
    throw error;
  }
}

/**
 * Start phone number validation process by sending a PIN code via WhatsApp
 */
export async function sendValidationPin(userId: string): Promise<{
  message: string;
}> {
  try {
    // Get the users user with PIN
    const usersReq = await getDb()
      .select()
      .from(users)
      .where(eq(users.id, userId));
    if (usersReq.length === 0) {
      throw new Error("User not found");
    }
    const user = usersReq[0];

    // check if already verified
    if (user.phoneNumberVerified) {
      return { message: "Phone number already verified" };
    }

    if (!user.phoneNumberAsNumber) {
      throw new Error("User has no phone number");
    }

    let pin = user.phonePinNumber;
    if (!pin) {
      const { pin: newPin } = await setPhonePinNumber(userId);
      pin = newPin;
    }

    // Send PIN via WhatsApp
    const message = `Your verification code is: ${pin}`;
    log.debug("Sending WhatsApp message", {
      phoneNumber: user.phoneNumberAsNumber,
      message,
    });
    await sendWhatsAppMessage(user.phoneNumberAsNumber, message);

    return { message: "Pin was sent via WhatsApp" };
  } catch (error) {
    log.error("Error starting phone number validation", { error });
    throw error;
  }
}

/**
 * Validate phone number with PIN
 */
export async function validatePhoneNumber(
  userId: string,
  pin: string
): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    // Find user with matching phone number and PIN
    const result = await getDb()
      .select()
      .from(users)
      .where(eq(users.id, userId));

    if (result.length === 0) {
      log.debug("User to validate phone number not found", {
        userId,
        pin,
      });
      throw new Error("User to validate phone number not found");
    }
    const user = result[0];

    if (!user.phonePinNumber || !user.phoneNumberAsNumber) {
      throw new Error("No PIN or phone number set for user");
    }

    // Verify PIN
    if (user.phonePinNumber !== pin) {
      log.debug("Invalid PIN Validation", { userId, pin });
      throw new Error("Invalid PIN");
    }

    // Update verification status
    await getDb()
      .update(users)
      .set({
        phoneNumberVerified: true,
        phonePinNumber: null, // Clear PIN after successful verification
      })
      .where(eq(users.id, user.id));

    return {
      success: true,
      message: "Phone number verified successfully",
    };
  } catch (error) {
    log.error("Error validating phone number", { userId, error });
    throw error;
  }
}

/**
 * Find user ID by phone number
 */
export async function getUserIdByPhoneNumber(
  phoneNumber: number | string
): Promise<string | null> {
  try {
    const phoneNumberAsNumber = Number(phoneNumber);
    const result = await getDb()
      .select({
        id: users.id,
      })
      .from(users)
      .where(eq(users.phoneNumberAsNumber, phoneNumberAsNumber));

    if (result.length === 0) {
      return null;
    }

    return result[0].id;
  } catch (error) {
    log.error("Error finding user by phone number", { phoneNumber, error });
    throw error;
  }
}

/**
 * A simple function to check if a user has a valid phone number
 */
export async function hasValidPhoneNumber(userId: string): Promise<boolean> {
  const user = await getDb().select().from(users).where(eq(users.id, userId));

  if (user.length === 0) {
    return false;
  }

  return user[0].phoneNumberVerified;
}
