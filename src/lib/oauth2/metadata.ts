/**
 * OAuth2 / OIDC discovery documents and JWKS.
 */
import * as crypto from "crypto";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { availableScopes } from "../auth/available-scopes";
import { OIDC_SCOPES } from "./oidc";
import { getOidcKeyMaterial } from "./keys";

export const issuerUrl = (): string =>
  (_GLOBAL_SERVER_CONFIG.oauth2?.issuer || _GLOBAL_SERVER_CONFIG.baseUrl).replace(
    /\/$/,
    ""
  );

const scopesSupported = (): string[] => [
  ...OIDC_SCOPES,
  ...availableScopes.all,
];

/** RFC 8414 Authorization Server Metadata. */
export const buildAuthServerMetadata = () => {
  const issuer = issuerUrl();
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    introspection_endpoint: `${issuer}/oauth/introspect`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [
      "client_secret_post",
      "client_secret_basic",
      "none",
    ],
    scopes_supported: scopesSupported(),
  };
};

/** OpenID Connect discovery document. */
export const buildOpenIdConfiguration = () => {
  const issuer = issuerUrl();
  return {
    ...buildAuthServerMetadata(),
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    claims_supported: [
      "sub",
      "iss",
      "aud",
      "exp",
      "iat",
      "nonce",
      "email",
      "email_verified",
      "name",
      "given_name",
      "family_name",
    ],
    response_modes_supported: ["query"],
  };
};

/** JSON Web Key Set exposing the OIDC signing public key. */
export const buildJwks = async () => {
  const { publicPem, kid } = await getOidcKeyMaterial();
  const jwk = crypto.createPublicKey(publicPem).export({ format: "jwk" });
  return {
    keys: [
      {
        ...jwk,
        kid,
        alg: "RS256",
        use: "sig",
      },
    ],
  };
};
