import { log } from "../../..";
import { getUserIdByPhoneNumber, hasValidPhoneNumber } from "../../auth/phone";

/* -----------
A lib to handle whatsapp communication

Add a token:
https://developers.facebook.com/docs/whatsapp/business-management-api/get-started#systemnutzer-zugriffstoken

Example of a whatsapp webhook event "messages"
{
  object: "whatsapp_business_account",
  entry: [
    {
      id: "888888888888888",
      changes: [
        {
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "4988778877887",
              phone_number_id: "1234567890",
            },
            contacts: [
              {
                profile: {
                  name: "Some",
                },
                wa_id: "499999999999999",
              }
            ],
            messages: [
              {
                from: "499999999999999",
                id: "wamid.HBgNNDkxNjA5NzMyMjM1MBUCABIYIENENDJGRDk2NDc3M0U0NjY1MTY0RTA2RThGOENFMEQ2AA==",
                timestamp: "1745442749",
                text: {
                  body: "Hello world",
                },
                type: "text",
              },
              {
      from: "499999999999999",
      id: "wamid.HBgNNDkxNjA5NzMyMjM1MBUCABIYFjNFQjA1NTI0QzkyREYyMkI3RDIwMzEA",
      timestamp: "1745475039",
      type: "audio",
      audio: {
        mime_type: "audio/ogg; codecs=opus",
        sha256: "PI5YWCccMl8+BrjezPMEOzYKEfiKhfzzQpLOU2xjqm8=",
        id: "1032371052180248",
        voice: true,
      },
    }
            ],
          },
          field: "messages",
        }
      ],
    }
  ],
}
*/

// Types for WhatsApp webhook data
export interface WhatsAppWebhook {
  object: string;
  entry: Entry[];
}

interface Entry {
  id: string;
  changes: Change[];
}

interface Change {
  value: {
    messaging_product: string;
    metadata?: {
      display_phone_number: string;
      phone_number_id: string;
    };
    contacts?: Contact[];
    messages?: WhatsAppMessage[];
  };
  field: string;
}

interface Contact {
  profile: {
    name: string;
  };
  wa_id: string;
}

export interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: "text" | "image" | "audio" | string;
  text?: {
    body: string;
  };
  image?: {
    mime_type: string;
    sha256: string;
    id: string;
  };
  audio?: {
    mime_type: string;
    sha256: string;
    id: string;
    voice: boolean;
  };
}

// Types for processed messages
export interface MediaFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export interface ProcessedWhatsAppMessage {
  phoneNumber: number;
  userId: string;
  messageId: string;
  text?: string;
  audio?: MediaFile;
  image?: MediaFile;
}

const ACCESS_TOKEN = process.env.CLOUD_API_ACCESS_TOKEN || "";
const API_VERSION = "v22.0";

/**
 * Process incoming WhatsApp webhook data
 * @param webhookData The webhook payload from WhatsApp
 * @returns Array of processed messages with text or media content
 */
export const processWebhook = async (
  webhookData: WhatsAppWebhook
): Promise<ProcessedWhatsAppMessage[]> => {
  // first check if user is registered
  const userId = webhookData.entry[0]?.changes[0]?.value?.contacts?.[0]?.wa_id
    ? await getUserIdByPhoneNumber(
        webhookData.entry[0].changes[0].value.contacts[0].wa_id
      )
    : undefined;

  if (!userId) {
    log.debug(
      `User not registered: ${webhookData.entry[0]?.changes[0]?.value?.contacts?.[0]?.wa_id}`
    );
    throw new Error("User not registered");
  }

  const isValidPhoneNumber = await hasValidPhoneNumber(userId);

  if (!isValidPhoneNumber) {
    log.debug(`User has no valid phone number: ${userId}`);
    throw new Error("User has no valid phone number");
  }

  const processedMessages: ProcessedWhatsAppMessage[] = [];

  // Skip if not a WhatsApp business account object
  if (webhookData.object !== "whatsapp_business_account") {
    return processedMessages;
  }

  for (const entry of webhookData.entry) {
    for (const change of entry.changes) {
      // Skip if not a messages field or no messages
      if (change.field !== "messages" || !change.value.messages) {
        continue;
      }

      // Process each message
      for (const message of change.value.messages) {
        const processedMessage: ProcessedWhatsAppMessage = {
          phoneNumber: Number(message.from),
          userId,
          messageId: message.id,
        };

        switch (message.type) {
          case "text":
            if (message.text) {
              processedMessage.text = message.text.body;
              processedMessages.push(processedMessage);
            }
            break;

          case "image":
            if (message.image) {
              try {
                processedMessage.image = await downloadMedia(message.image.id);
                processedMessages.push(processedMessage);
              } catch (error) {
                log.error(`Failed to download image: ${error}`);
              }
            }
            break;

          case "audio":
            if (message.audio) {
              try {
                processedMessage.audio = await downloadMedia(message.audio.id);
                processedMessages.push(processedMessage);
              } catch (error) {
                log.error(`Failed to download audio: ${error}`);
              }
            }
            break;

          default:
            // Skip other message types
            continue;
        }
      }
    }
  }

  return processedMessages;
};

/**
 * Download media from WhatsApp servers
 * @param mediaId The ID of the media to download
 * @returns MediaFile object with buffer, filename and mimeType
 */
async function downloadMedia(mediaId: string): Promise<MediaFile> {
  try {
    // First, get the media URL
    const mediaUrlResponse = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${mediaId}`,
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
        },
      }
    );

    if (!mediaUrlResponse.ok) {
      throw new Error(`Failed to get media URL: ${mediaUrlResponse.status}`);
    }

    const mediaData = (await mediaUrlResponse.json()) as { url: string };

    // Now download the actual media
    const mediaResponse = await fetch(mediaData.url, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });

    if (!mediaResponse.ok) {
      throw new Error(`Failed to download media: ${mediaResponse.status}`);
    }

    const arrayBuffer = await mediaResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType =
      mediaResponse.headers.get("content-type") || "application/octet-stream";

    return {
      buffer,
      filename: `whatsapp_media_${mediaId}`,
      mimeType,
    };
  } catch (error) {
    log.error("Error downloading media:", error + "");
    throw error;
  }
}
