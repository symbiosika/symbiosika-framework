# Fastapp Framework Webserver - Get Started

This guide explains how to quickly set up a webserver using the `fastapp-framework`.

## Quick Start

1. **Install dependencies** (if not already):

   ```sh
   bun install fastapp-framework
   ```

2. **Create your server entry file** (e.g., `src/index.ts`):

   ```typescript
   import { defineServer } from "fastapp-framework";
   import fs from "fs";

   const server = defineServer({
     // ...other options
     staticPrivateDataPath: "./static", // Path for private static files (visible to users after login)
     staticPublicDataPath: "./public", // Path for public static files (visible to users without login)
     useLicenseSystem: true, // Enable license key validation. If enabled, you need to provide license key files (private and public key)
     publicKey: fs.readFileSync("./license-keys/public.pem").toString(), // Public key for license validation
   });

   export default server;
   console.log(`...server is running on port http://localhost:3000`);
   ```

3. **Run the server:**
   ```sh
   bun run src/index.ts
   ```
---

## Property Reference

- **staticPrivateDataPath**

  - Path to a directory for private static files (not exposed to the public).
  - Example: `./static`

- **staticPublicDataPath**

  - Path to a directory for public static files (served to clients).
  - Example: `./public`

- **useLicenseSystem**

  - Set to `true` to enable license key validation for your server.

- **publicKey**
  - The public key (as a string) used to verify license keys. Typically loaded from a `.pem` file.

---