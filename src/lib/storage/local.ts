import fs from "fs/promises";
import path from "path";
import type {
  DeleteFileFunction,
  GetFileFunction,
  SaveFileFunction,
} from "./types";

const ATTACHMENT_DIR = path.join(process.cwd(), "static/upload");
console.log("Server´s upload directory: ", ATTACHMENT_DIR);

export const saveFileToLocalDisc: SaveFileFunction = async (
  file,
  bucket,
  organisationId
) => {
  const id = crypto.randomUUID();
  const fileName = file.name;
  const fileExtension = fileName.includes(".")
    ? fileName.split(".").pop()!.toLowerCase()
    : "";

  // Generate the file path
  const filePath = path.join(
    ATTACHMENT_DIR,
    bucket,
    fileExtension ? `${id}.${fileExtension}` : id
  );

  // Save the file to the disk
  const fileBuffer = Buffer.from(await file.arrayBuffer());

  await fs.mkdir(path.join(ATTACHMENT_DIR, bucket), { recursive: true });
  await fs.writeFile(filePath, fileBuffer);
  const publicFileName = fileExtension ? `${id}.${fileExtension}` : id;

  return {
    path: `/api/v1/organisation/${organisationId}/files/local/${bucket}/${publicFileName}`,
    id: id,
    name: fileName,
    organisationId: organisationId,
  };
};

export const getFileFromLocalDisc: GetFileFunction = async (
  name,
  bucket,
  organisationId
) => {
  // Generate the file path
  const filePath = path.join(ATTACHMENT_DIR, bucket, name);
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
  organisationId
) => {
  // Generate the file path
  const filePath = path.join(ATTACHMENT_DIR, bucket, name);
  // Delete the file
  await fs.unlink(filePath);
};
