import fs from "fs/promises";
import path from "path";
import type {
  DeleteFileFunction,
  GetFileFunction,
  SaveFileFunction,
} from "./types";

const ATTACHMENT_DIR = path.join(process.cwd(), "static/upload");
console.log("Server´s upload directory: ", ATTACHMENT_DIR);

/**
 * `bucket` and the file name come from the request path. Without validation a
 * caller could use "../" (or an absolute path / encoded separators) to read,
 * write, or delete files outside the upload directory or in another tenant's
 * bucket. We allow only a conservative character set per segment and, as a
 * second line of defence, verify the resolved path stays inside ATTACHMENT_DIR.
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

/**
 * Build a file path under ATTACHMENT_DIR for the given bucket/name, rejecting
 * any input that would escape the upload directory.
 */
const safeAttachmentPath = (bucket: string, name?: string): string => {
  assertSafeSegment(bucket, "bucket");
  if (name !== undefined) assertSafeSegment(name, "file name");
  const filePath =
    name !== undefined
      ? path.join(ATTACHMENT_DIR, bucket, name)
      : path.join(ATTACHMENT_DIR, bucket);
  const root = path.resolve(ATTACHMENT_DIR);
  const resolved = path.resolve(filePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("Resolved path escapes the upload directory");
  }
  return filePath;
};

export const saveFileToLocalDisc: SaveFileFunction = async (
  file,
  bucket,
  tenantId
) => {
  const id = crypto.randomUUID();
  const fileName = file.name;
  const fileExtension = fileName.includes(".")
    ? fileName.split(".").pop()!.toLowerCase()
    : "";

  // Generate the file path (bucket is request-controlled → validated; the file
  // name is a server-generated UUID).
  const publicName = fileExtension ? `${id}.${fileExtension}` : id;
  const filePath = safeAttachmentPath(bucket, publicName);

  // Save the file to the disk
  const fileBuffer = Buffer.from(await file.arrayBuffer());

  await fs.mkdir(safeAttachmentPath(bucket), { recursive: true });
  await fs.writeFile(filePath, fileBuffer);
  const publicFileName = fileExtension ? `${id}.${fileExtension}` : id;

  return {
    path: `/api/v1/tenant/${tenantId}/files/local/${bucket}/${publicFileName}`,
    id: id,
    name: fileName,
    tenantId: tenantId,
  };
};

export const getFileFromLocalDisc: GetFileFunction = async (
  name,
  bucket,
  tenantId
) => {
  // Generate the file path (bucket and name are request-controlled → validated)
  const filePath = safeAttachmentPath(bucket, name);
  // return the file
  try {
    const file = await fs.readFile(filePath);
    return new File([new Uint8Array(file)], name);
  } catch (error) {
    throw new Error("File not found");
  }
};

export const deleteFileFromLocalDisc: DeleteFileFunction = async (
  name,
  bucket,
  tenantId
) => {
  // Generate the file path (bucket and name are request-controlled → validated)
  const filePath = safeAttachmentPath(bucket, name);
  // Delete the file
  await fs.unlink(filePath);
};
