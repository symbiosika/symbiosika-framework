/**
 * The S3 backend of the file storage, next to `db.ts` and `local.ts`.
 *
 * An installation that keeps its files in an object store instead of the
 * database or the disc of a container: any S3-compatible service works (AWS,
 * MinIO, Ceph, Cloudflare R2, Hetzner, Scaleway, ...). Built on Bun's own S3
 * client, so nothing is added to the dependencies.
 *
 * It is the backend a deployment with more than one replica wants: `local`
 * stores on the disc of one container, which the next replica does not see,
 * and `db` puts every byte into the database and its backup. `s3` keeps the
 * data outside both and is reached by every replica.
 *
 * Configuration:
 *
 *   S3_BUCKET                 required: the bucket everything is stored in
 *   S3_ACCESS_KEY_ID          credentials; both may be left out when the
 *   S3_SECRET_ACCESS_KEY      runtime provides them (an instance role, a
 *   S3_SESSION_TOKEN          mounted credentials file, AWS_* variables)
 *   S3_REGION                 the region of the bucket
 *   S3_ENDPOINT               only for a service that is not AWS,
 *                             e.g. http://minio:9000
 *   S3_PREFIX                 every key starts with it, so one bucket can hold
 *                             several installations
 *   S3_VIRTUAL_HOSTED_STYLE   "true" puts the bucket in the host name; the
 *                             default is the path style MinIO and Ceph want
 *
 * Object keys are `<prefix><tenantId>/<bucket>/<name>`, so the tenant is part
 * of the key: a caller never supplies that part and the file of one tenant
 * cannot be addressed from another. `assertS3Configured()` says at start-up
 * what is missing, so an installation hears it on the first boot and not on
 * the first upload.
 */
import type {
  DeleteFileFunction,
  GetFileFunction,
  SaveFileFunction,
} from "./types";

/**
 * What may become one segment of an object key. The bucket and the file name
 * reach the storage from a request path, so a "../" (or an absolute path, or
 * an encoded separator) must not be able to leave the prefix of the
 * installation or reach into another tenant. Same conservative set as the
 * local disc backend uses.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

const assertSafeSegment = (value: string, label: string): void => {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    !SAFE_SEGMENT.test(value)
  ) {
    throw new Error(`Invalid ${label}`);
  }
};

export interface S3Config {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** normalised to "" or "something/" */
  prefix: string;
  virtualHostedStyle: boolean;
}

const trimmed = (value: string | undefined): string | undefined =>
  value?.trim() || undefined;

/** "app" and "app/" and "/app/" all mean the same thing; keep it as "app/". */
const normalisePrefix = (raw: string | undefined): string => {
  const value = (raw ?? "").trim().replace(/^\/+|\/+$/g, "");
  return value ? `${value}/` : "";
};

/**
 * Read from the environment on every call. The process may be configured after
 * this module was imported, and reading a handful of variables costs nothing
 * next to the request that follows.
 */
export function s3Config(): S3Config {
  return {
    bucket: (process.env.S3_BUCKET ?? "").trim(),
    endpoint: trimmed(process.env.S3_ENDPOINT),
    region: trimmed(process.env.S3_REGION),
    accessKeyId: trimmed(process.env.S3_ACCESS_KEY_ID),
    secretAccessKey: trimmed(process.env.S3_SECRET_ACCESS_KEY),
    sessionToken: trimmed(process.env.S3_SESSION_TOKEN),
    prefix: normalisePrefix(process.env.S3_PREFIX),
    virtualHostedStyle:
      process.env.S3_VIRTUAL_HOSTED_STYLE === "true" ||
      process.env.S3_VIRTUAL_HOSTED_STYLE === "1",
  };
}

/** The configured store, or an error naming what is missing. */
export function s3Client(): Bun.S3Client {
  const config = s3Config();
  if (!config.bucket) {
    throw new Error(
      "S3 storage needs S3_BUCKET (and S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY, unless the runtime provides the credentials)"
    );
  }
  return new Bun.S3Client({
    bucket: config.bucket,
    endpoint: config.endpoint,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    sessionToken: config.sessionToken,
    virtualHostedStyle: config.virtualHostedStyle,
  });
}

/**
 * Check the configuration without touching the network. Call it at start-up
 * when the installation is set to `s3`, so a missing bucket is heard on the
 * first boot.
 */
export const assertS3Configured = (): void => {
  s3Client();
};

/** The key of one stored file. `name` carries the extension, as it does on the local disc. */
export const s3Key = (
  tenantId: string,
  bucket: string,
  name: string
): string => {
  assertSafeSegment(tenantId, "tenant");
  assertSafeSegment(bucket, "bucket");
  assertSafeSegment(name, "file name");
  return `${s3Config().prefix}${tenantId}/${bucket}/${name}`;
};

/**
 * `options` (chatId, workspaceId) is part of the shared signature but has no
 * meaning here: those belong to the metadata row the database backend keeps,
 * and an object store has no such row.
 */
export const saveFileToS3: SaveFileFunction = async (
  file,
  bucket,
  tenantId
) => {
  const id = crypto.randomUUID();
  const fileExtension = file.name.includes(".")
    ? file.name.split(".").pop()!.toLowerCase()
    : "";
  // the name is server-generated; the extension is kept so the content type
  // can be read back from the key, the way the local disc backend does it
  const publicName = fileExtension ? `${id}.${fileExtension}` : id;

  await s3Client()
    .file(s3Key(tenantId, bucket, publicName))
    .write(file, { type: file.type || "application/octet-stream" });

  return {
    path: `/api/v1/tenant/${tenantId}/files/s3/${bucket}/${publicName}`,
    id: id,
    name: file.name,
    tenantId: tenantId,
  };
};

export const getFileFromS3: GetFileFunction = async (
  name,
  bucket,
  tenantId
) => {
  const key = s3Key(tenantId, bucket, name);
  let bytes: ArrayBuffer;
  try {
    bytes = await s3Client().file(key).arrayBuffer();
  } catch (error) {
    throw new Error("File not found");
  }
  // The content type comes from the extension the save put into the key, not
  // from the object's own header: asking the store for that header is a second
  // request, on every read, for something the key already says. `name` has
  // been validated by s3Key above, so this only looks at its extension.
  return new File([bytes], name, {
    type: Bun.file(name).type || "application/octet-stream",
  });
};

export const deleteFileFromS3: DeleteFileFunction = async (
  name,
  bucket,
  tenantId
) => {
  await s3Client().file(s3Key(tenantId, bucket, name)).delete();
};
