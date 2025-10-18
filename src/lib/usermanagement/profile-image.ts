import { eq } from "drizzle-orm";
import { users } from "../db/schema/users";
import { getDb } from "../db/db-connection";

/**
 * Upsert a user´s profile image
 */
export const upsertUserProfileImage = async (userId: string, file: File) => {
  // check that file is < 1MB
  if (file.size > 1024 * 1024) {
    throw new Error("File is too large");
  }

  // Read file as buffer
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Update user in database
  await getDb()
    .update(users)
    .set({
      profileImage: buffer,
      profileImageName: file.name,
      profileImageContentType: file.type,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(users.id, userId));
};

/**
 * Get a user´s profile image
 */
export const getUserProfileImage = async (
  userId: string
): Promise<{ file: File; contentType: string; fileName: string }> => {
  const user = await getDb().select().from(users).where(eq(users.id, userId));
  if (
    !user[0] ||
    !user[0].profileImage ||
    !user[0].profileImageName ||
    !user[0].profileImageContentType
  ) {
    throw new Error("Image not found");
  }
  const file = new File(
    [new Uint8Array(user[0].profileImage)],
    user[0].profileImageName,
    {
      type: user[0].profileImageContentType,
    }
  );
  return {
    file,
    contentType: user[0].profileImageContentType,
    fileName: user[0].profileImageName,
  };
};

/**
 * Delete a user´s profile image
 */
export const deleteUserProfileImage = async (userId: string) => {
  await getDb()
    .update(users)
    .set({
      profileImage: null,
      profileImageName: null,
      profileImageContentType: null,
    })
    .where(eq(users.id, userId));
};
