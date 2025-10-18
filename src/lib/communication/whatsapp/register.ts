/**
 * Register a WhatsApp Business Account and Phone Number
 */
export const registerCompanyInWhatsAppAPI = async () => {
  if (!process.env.WA_BUSINESS_ACCOUNT_ID) {
    throw new Error(
      "WA_BUSINESS_ACCOUNT_ID is not set in the environment variables"
    );
  }
  const url = `https://graph.facebook.com/v22.0/${process.env.WA_BUSINESS_ACCOUNT_ID}/subscribed_apps`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CLOUD_API_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  return await response.json();
};

/**
 * Get the list of registered WhatsApp Business Accounts and Phone Numbers
 */
export const getRegistrationsForWhatsAppAPI = async () => {
  const url = `https://graph.facebook.com/v22.0/${process.env.WA_BUSINESS_ACCOUNT_ID}/subscribed_apps`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.CLOUD_API_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  return await response.json();
};

/**
 * Register a phone number in WhatsApp Business API
 */
export const registerPhoneNumerInWhatsAppAPI = async () => {
  const url = `https://graph.facebook.com/v22.0/${process.env.WA_PHONE_NUMBER_ID}/register`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CLOUD_API_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      pin: "000000",
      // cert: "CnMK...",
    }),
  });
  return await response.json();
};

/**
 * Get the list of phone numbers associated with a WhatsApp Business Account
 */
export const getTelephoneNumber = async () => {
  if (!process.env.WA_BUSINESS_ACCOUNT_ID) {
    throw new Error(
      "WA_BUSINESS_ACCOUNT_ID is not set in the environment variables"
    );
  }
  const url = `https://graph.facebook.com/v22.0/${process.env.WA_BUSINESS_ACCOUNT_ID}/phone_numbers`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.CLOUD_API_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  return await response.json();
};
