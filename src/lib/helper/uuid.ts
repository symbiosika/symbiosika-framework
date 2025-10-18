const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isValidUuid = (uuid: string | null | undefined): boolean => {
  if (uuid === null || uuid === undefined) {
    throw new Error("UUID cannot be null or undefined");
  }
  return uuidPattern.test(uuid);
};
