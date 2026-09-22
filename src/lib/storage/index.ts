export type FileSourceType =
  | "db"
  | "local"
  | "s3"
  | "url"
  | "text"
  | "plugin"
  | "external";

import {
  saveFileToLocalDisc,
  getFileFromLocalDisc,
  deleteFileFromLocalDisc,
} from "./local";
import { saveFileToDb, getFileFromDb, deleteFileFromDB } from "./db";
import { saveFileToS3, getFileFromS3, deleteFileFromS3 } from "./s3";
import type {
  GeneralSaveFileFunction,
  GeneralDeleteFileFunction,
  GeneralGetFileFunction,
  StorageType,
} from "./types";

export type { StorageType };

/** The backends this framework carries, in the order they are offered. */
export const STORAGE_TYPES: readonly StorageType[] = ["db", "local", "s3"];

export const isStorageType = (value: unknown): value is StorageType =>
  typeof value === "string" && STORAGE_TYPES.includes(value as StorageType);

export const saveFile: GeneralSaveFileFunction = async (
  file,
  bucket,
  tenantId,
  storageType
) => {
  if (storageType === "local") {
    const result = await saveFileToLocalDisc(file, bucket, tenantId);
    return { ...result, name: file.name };
  } else if (storageType === "db") {
    const result = await saveFileToDb(file, bucket, tenantId);
    return { ...result, name: file.name };
  } else if (storageType === "s3") {
    const result = await saveFileToS3(file, bucket, tenantId);
    return { ...result, name: file.name };
  } else {
    throw new Error("Invalid storage type");
  }
};

export const getFile: GeneralGetFileFunction = async (
  name,
  bucket,
  tenantId,
  storageType
) => {
  if (storageType === "local") {
    return await getFileFromLocalDisc(name, bucket, tenantId);
  } else if (storageType === "db") {
    return await getFileFromDb(name, bucket, tenantId);
  } else if (storageType === "s3") {
    return await getFileFromS3(name, bucket, tenantId);
  } else {
    throw new Error("Invalid storage type");
  }
};

export const deleteFile: GeneralDeleteFileFunction = async (
  name,
  bucket,
  tenantId,
  storageType
) => {
  if (storageType === "local") {
    await deleteFileFromLocalDisc(name, bucket, tenantId);
  } else if (storageType === "db") {
    await deleteFileFromDB(name, bucket, tenantId);
  } else if (storageType === "s3") {
    await deleteFileFromS3(name, bucket, tenantId);
  } else {
    throw new Error("Invalid storage type");
  }
};
