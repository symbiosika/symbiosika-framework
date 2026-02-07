/**
 * Generates RSA key pair for JWT signing/verification
 * Uses Bun's native crypto capabilities
 */
export async function generateJWTKeys(): Promise<{
  privateKey: string;
  publicKey: string;
}> {
  const { subtle } = globalThis.crypto;

  // Generate RSA key pair for JWT signing
  const keyPair = await subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true, // extractable
    ["sign", "verify"]
  );

  // Export private key in PKCS#8 format
  const privateKeyBuffer = await subtle.exportKey("pkcs8", keyPair.privateKey);
  const privateKey = Buffer.from(privateKeyBuffer).toString("base64");

  // Export public key in SPKI format
  const publicKeyBuffer = await subtle.exportKey("spki", keyPair.publicKey);
  const publicKey = Buffer.from(publicKeyBuffer).toString("base64");

  return { privateKey, publicKey };
}

/**
 * Checks if JWT keys exist and generates them if missing
 * Outputs keys to console for manual addition to .env file
 */
export async function ensureJWTKeys(): Promise<void> {
  const privateKey = process.env.JWT_PRIVATE_KEY;
  const publicKey = process.env.JWT_PUBLIC_KEY;

  if (!privateKey || !publicKey) {
    console.log("\n🔑 JWT Keys are missing from environment variables!");
    console.log("Generating new RSA key pair...\n");

    const { privateKey: newPrivateKey, publicKey: newPublicKey } =
      await generateJWTKeys();

    console.log("📋 Add these keys to your .env file:\n");
    console.log("JWT_PRIVATE_KEY=" + newPrivateKey);
    console.log("JWT_PUBLIC_KEY=" + newPublicKey);
    console.log(
      "\n⚠️  Keep these keys secure and never commit them to version control!\n"
    );

    process.exit(0);
  }
}
