import { HTTPException } from "hono/http-exception";

export const validateOrganisationId = (data: any, organisationId: string) => {
  if (!data.organisationId || data.organisationId !== organisationId) {
    throw new HTTPException(400, {
      message:
        'Parameter "organisationId" in body does not match URL parameter',
    });
  }
};
