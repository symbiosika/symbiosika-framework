import { describe, it, expect } from "bun:test";
import { encryptAes, decryptAes } from "./aes";

describe("AES Encryption/Decryption", () => {
  it("should encrypt and decrypt text correctly", () => {
    const originalText = "Hello, World!";

    // Encrypt the text
    const encrypted = encryptAes(originalText);
    expect(encrypted.algorithm).toBe("aes-256-cbc");
    expect(encrypted.value).toContain(":"); // Should contain IV separator
    expect(encrypted.value).not.toBe(originalText);

    // Decrypt the text
    const decrypted = decryptAes(encrypted.value);
    expect(decrypted.algorithm).toBe("aes-256-cbc");
    expect(decrypted.value).toBe(originalText);
  });

  it("should work with different algorithms", () => {
    const originalText = "Test with different algorithm";
    const algorithm = "aes-256-gcm";

    // Encrypt with custom algorithm
    const encrypted = encryptAes(originalText, algorithm);
    expect(encrypted.algorithm).toBe(algorithm);

    // Decrypt with same algorithm
    const decrypted = decryptAes(encrypted.value, algorithm);
    expect(decrypted.algorithm).toBe(algorithm);
    expect(decrypted.value).toBe(originalText);
  });

  it("should handle empty strings", () => {
    const originalText = "";

    const encrypted = encryptAes(originalText);
    const decrypted = decryptAes(encrypted.value);

    expect(decrypted.value).toBe(originalText);
  });

  it("should handle special characters", () => {
    const originalText = "!@#$%^&*()_+-=[]{}|;:,.<>?`~";

    const encrypted = encryptAes(originalText);
    const decrypted = decryptAes(encrypted.value);

    expect(decrypted.value).toBe(originalText);
  });
});
