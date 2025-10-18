export const generateEmbedding = async (
  text: string,
  options: { organisationId?: string; userId?: string }
) => {
  return { embedding: [0.0, 0.0, 0.0, 0.0, 0.0], model: "" };
};
