/**
 * Handing a stored file to something that is not the app: a temporary URL.
 *
 * A worker, an analysis service, a browser that should download a large file
 * without the request going through the API: all of them need the bytes, none
 * of them has a session. `shareFile` gives out a URL that carries its own
 * permission, works for anyone who holds it and stops working when the time is
 * up. Nothing is copied and nothing is made public: the link is the grant, and
 * it expires.
 *
 * It works for every backend, because a caller should not have to know where
 * the file lies:
 *
 *   s3          a presigned URL of the object store. The bytes never pass
 *               through this server.
 *   db, local   a URL of this server, `<basePath>/files/shared/<token>`,
 *               where the token is signed and carries what it grants and
 *               until when. Served by the route in
 *               routes/tenant/[tenantId]/files.
 *
 * The token is a JWT with a `purpose` of its own, so it can never be used as a
 * session token and a session token can never be used as a share. It names one
 * file: one tenant, one bucket, one name, one backend. Nothing else in the
 * installation can be read with it, and there is no way to widen it.
 *
 * Time is the only thing the caller decides, and it is bounded: a share lives
 * at most MAX_SHARE_TTL_SECONDS, whatever is asked for.
 */
import jwt from "jsonwebtoken";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { s3Client, s3Key } from "./s3";
import type { StorageType } from "./types";

/** Distinguishes a share from every other token this installation signs. */
export const SHARE_TOKEN_PURPOSE = "file_share";

/** Long enough for a large download over a slow line, short enough to be worth little if it leaks. */
export const DEFAULT_SHARE_TTL_SECONDS = 15 * 60;

/** The ceiling. A link that outlives a working day is not a share any more. */
export const MAX_SHARE_TTL_SECONDS = 24 * 60 * 60;

const getShareTokenKey = () => process.env.JWT_PRIVATE_KEY || "";

/** What a share names, and nothing more. */
export interface SharedFileRef {
  tenantId: string;
  bucket: string;
  name: string;
  storageType: StorageType;
}

export interface SharedFile {
  /** hand this to whoever needs the bytes */
  url: string;
  /** when it stops working, ISO 8601 */
  expiresAt: string;
  /** the seconds it was granted for, after the ceiling was applied */
  expiresIn: number;
}

export interface ShareFileOptions {
  /** seconds; the default is DEFAULT_SHARE_TTL_SECONDS, the ceiling MAX_SHARE_TTL_SECONDS */
  expiresInSeconds?: number;
}

/** Whatever was asked for, inside the bounds. A nonsense value falls back to the default. */
const ttlOf = (requested: number | undefined): number => {
  if (!Number.isFinite(requested) || !requested || requested <= 0) {
    return DEFAULT_SHARE_TTL_SECONDS;
  }
  return Math.min(Math.floor(requested), MAX_SHARE_TTL_SECONDS);
};

export const createFileShareToken = (
  ref: SharedFileRef,
  expiresInSeconds: number
): string =>
  jwt.sign(
    { ...ref, purpose: SHARE_TOKEN_PURPOSE },
    getShareTokenKey(),
    { expiresIn: expiresInSeconds }
  );

/**
 * Read a share token. Throws when it is not one, when it is expired, or when
 * the signature does not hold. The purpose is checked explicitly: a session
 * token signed with the same key must not open a file.
 */
export const verifyFileShareToken = (token: string): SharedFileRef => {
  const decoded = jwt.verify(token, getShareTokenKey()) as
    | (Partial<SharedFileRef> & { purpose?: string })
    | string;
  if (
    !decoded ||
    typeof decoded === "string" ||
    decoded.purpose !== SHARE_TOKEN_PURPOSE ||
    !decoded.tenantId ||
    !decoded.bucket ||
    !decoded.name ||
    !decoded.storageType
  ) {
    throw new Error("Invalid file share token");
  }
  return {
    tenantId: decoded.tenantId,
    bucket: decoded.bucket,
    name: decoded.name,
    storageType: decoded.storageType,
  };
};

/** `<baseUrl><basePath>/files/shared/<token>`, built the way the OAuth redirect URI is. */
export const fileShareUrl = (token: string): string => {
  const basePath = _GLOBAL_SERVER_CONFIG.basePath.replace(/\/$/, "");
  return `${_GLOBAL_SERVER_CONFIG.baseUrl}${basePath}/files/shared/${token}`;
};

/**
 * A temporary URL for one stored file. `name` is what the save handed back in
 * `path` (for `db` the bare id works too, as everywhere else).
 */
export async function shareFile(
  name: string,
  bucket: string,
  tenantId: string,
  storageType: StorageType,
  options: ShareFileOptions = {}
): Promise<SharedFile> {
  const expiresIn = ttlOf(options.expiresInSeconds);
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  if (storageType === "s3") {
    // the object store checks the signature itself, so the bytes go straight
    // from it to whoever holds the link and never through this server
    const url = s3Client()
      .file(s3Key(tenantId, bucket, name))
      .presign({ method: "GET", expiresIn });
    return { url, expiresAt, expiresIn };
  }

  if (storageType === "db" || storageType === "local") {
    const token = createFileShareToken(
      { tenantId, bucket, name, storageType },
      expiresIn
    );
    return { url: fileShareUrl(token), expiresAt, expiresIn };
  }

  throw new Error("Invalid storage type");
}
