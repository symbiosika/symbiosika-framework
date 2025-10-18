export type FileSourceType =
  | "db"
  | "local"
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
import type {
  GeneralSaveFileFunction,
  GeneralDeleteFileFunction,
  GeneralGetFileFunction,
} from "./types";

export const saveFile: GeneralSaveFileFunction = async (
  file,
  bucket,
  organisationId,
  storageType
) => {
  if (storageType === "local") {
    const result = await saveFileToLocalDisc(file, bucket, organisationId);
    return { ...result, name: file.name };
  } else if (storageType === "db") {
    const result = await saveFileToDb(file, bucket, organisationId);
    return { ...result, name: file.name };
  } else {
    throw new Error("Invalid storage type");
  }
};

export const getFile: GeneralGetFileFunction = async (
  name,
  bucket,
  organisationId,
  storageType
) => {
  if (storageType === "local") {
    return await getFileFromLocalDisc(name, bucket, organisationId);
  } else if (storageType === "db") {
    return await getFileFromDb(name, bucket, organisationId);
  } else {
    throw new Error("Invalid storage type");
  }
};

export const deleteFile: GeneralDeleteFileFunction = async (
  name,
  bucket,
  organisationId,
  storageType
) => {
  if (storageType === "local") {
    await deleteFileFromLocalDisc(name, bucket, organisationId);
  } else if (storageType === "db") {
    await deleteFileFromDB(name, bucket, organisationId);
  } else {
    throw new Error("Invalid storage type");
  }
};
