import log from "../../log";

export const sendWhatsAppMessage = async (
  phoneNumber: number,
  message: string
) => {
  const url = `https://graph.facebook.com/v22.0/${process.env.WA_PHONE_NUMBER_ID}/messages`;
  log.debug(
    `Send whatsapp message to ${phoneNumber} with message ${message.slice(0, 10)}...`
  );
  console.log(process.env.CLOUD_API_ACCESS_TOKEN?.slice(0, 3) + "...");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CLOUD_API_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phoneNumber.toString(),
      type: "text",
      text: { body: message },
    }),
  });
  try {
    const r = await response.json();
    if (response.status !== 200) {
      log.error("Error sending whatsapp message", {
        status: response.status,
        message: r,
      });
      throw new Error(`Error sending whatsapp message: ${r}`);
    }
  } catch (error) {
    log.error("Error sending whatsapp message", {
      status: response.status,
      message: error,
    });
    throw new Error(`Error sending whatsapp message: ${error}`);
  }
  return true;
};
