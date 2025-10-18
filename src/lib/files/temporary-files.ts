/*
A library to store files temporary on the disc to do some processing with it etc.
*/
import { nanoid } from "nanoid";
import fs from "fs/promises";
import log from "../../lib/log";

const temporaryStoragePath = process.env.TEMPORARY_STORAGE_PATH || "./tmp";

/**
 * Save file to temporary storage
 */
export const saveFileToTemporaryStorage = async (file: File) => {
  // create a unique id
  const id = nanoid(16);

  // get the file extension
  const extension = file.name.split(".").pop();

  // save file to temporary storage
  const filename = `${id}.${extension}`;
  const path = `${temporaryStoragePath}/${filename}`;

  // Convert File to ArrayBuffer
  const buffer = await file.arrayBuffer();

  // Save file to path
  await fs.writeFile(path, Buffer.from(buffer));

  return { path, filename };
};

/**
 * Remove temporary file
 */
export const removeTemporaryFile = async (path: string) => {
  log.debug(`Removing temporary file: ${path}`);
  await fs.unlink(path);
};
