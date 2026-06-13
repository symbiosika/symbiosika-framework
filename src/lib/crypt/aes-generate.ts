import { randomBytes } from "crypto";

/**
 * Generates AES key and IV for secrets encryption
 * Key: 32 bytes (256 bits) for AES-256
 * IV: 16 bytes (128 bits) for AES block size
 */
export function generateAESSecrets(): { key: string; iv: string } {
    const key = randomBytes(32).toString("hex");
    const iv = randomBytes(16).toString("hex");
    return { key, iv };
}