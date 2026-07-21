import { describe, test, expect } from "bun:test";
import {
  computeSignature,
  buildSignatureHeaders,
  verifySignature,
  generateSigningSecret,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  SIGNING_SECRET_PREFIX,
} from "./signature";

describe("webhook signature", () => {
  const secret = "whsec_testsecret";
  const payload = JSON.stringify({ event: "knowledge_text.created", data: { id: "1" } });
  const ts = 1_700_000_000;

  test("sign → verify round-trip succeeds", () => {
    const headers = buildSignatureHeaders(secret, payload, ts);
    expect(headers[TIMESTAMP_HEADER]).toBe(String(ts));
    expect(headers[SIGNATURE_HEADER]).toMatch(/^v1=[0-9a-f]{64}$/);

    const ok = verifySignature({
      secret,
      payload,
      signatureHeader: headers[SIGNATURE_HEADER],
      timestampHeader: headers[TIMESTAMP_HEADER],
      nowSeconds: ts,
    });
    expect(ok).toBe(true);
  });

  test("computeSignature is deterministic and binds the timestamp", () => {
    expect(computeSignature(secret, payload, ts)).toBe(
      computeSignature(secret, payload, ts)
    );
    // a different timestamp yields a different signature
    expect(computeSignature(secret, payload, ts)).not.toBe(
      computeSignature(secret, payload, ts + 1)
    );
  });

  test("a tampered payload fails verification", () => {
    const headers = buildSignatureHeaders(secret, payload, ts);
    const ok = verifySignature({
      secret,
      payload: payload + "x", // body changed after signing
      signatureHeader: headers[SIGNATURE_HEADER],
      timestampHeader: headers[TIMESTAMP_HEADER],
      nowSeconds: ts,
    });
    expect(ok).toBe(false);
  });

  test("a wrong secret fails verification", () => {
    const headers = buildSignatureHeaders(secret, payload, ts);
    const ok = verifySignature({
      secret: "whsec_other",
      payload,
      signatureHeader: headers[SIGNATURE_HEADER],
      timestampHeader: headers[TIMESTAMP_HEADER],
      nowSeconds: ts,
    });
    expect(ok).toBe(false);
  });

  test("a stale timestamp (replay) is rejected", () => {
    const headers = buildSignatureHeaders(secret, payload, ts);
    const ok = verifySignature({
      secret,
      payload,
      signatureHeader: headers[SIGNATURE_HEADER],
      timestampHeader: headers[TIMESTAMP_HEADER],
      toleranceSeconds: 300,
      nowSeconds: ts + 301, // just outside the tolerance window
    });
    expect(ok).toBe(false);
  });

  test("missing headers fail closed", () => {
    expect(
      verifySignature({
        secret,
        payload,
        signatureHeader: null,
        timestampHeader: null,
      })
    ).toBe(false);
  });

  test("generateSigningSecret produces a prefixed, unique secret", () => {
    const a = generateSigningSecret();
    const b = generateSigningSecret();
    expect(a.startsWith(SIGNING_SECRET_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(SIGNING_SECRET_PREFIX.length + 20);
  });
});
