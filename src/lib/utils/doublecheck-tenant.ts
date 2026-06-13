import { HTTPException } from "hono/http-exception";

export const validateOrganisationId = (data: any, tenantId: string) => {
  if (!data.tenantId || data.tenantId !== tenantId) {
    throw new HTTPException(400, {
      message:
        'Parameter "tenantId" in body does not match URL parameter',
    });
  }
};
