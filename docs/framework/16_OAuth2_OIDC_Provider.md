# OAuth2 + OIDC Provider (Authorization Server)

> **Scope:** Erweiterung des `symbiosika-framework`. Unsere App wird ein
> **OAuth 2.1 Authorization Server mit OpenID-Connect-Layer**. Drittdienste
> (Clients) schicken den Nutzer zu uns, der Nutzer meldet sich bei uns an und
> erteilt Consent, der Drittdienst erhält gescopte, widerrufbare Tokens und ruft
> damit unsere API im Namen des Nutzers auf bzw. nutzt uns als Login-Provider
> ("Anmelden mit Symbiosika").
>
> **Kein MCP.** Reiner OAuth2/OIDC-Provider.

## Getroffene Entscheidungen

| Thema | Entscheidung |
|---|---|
| Protokoll | OAuth 2.1 **+ OIDC** (id_token, /userinfo, JWKS, openid-configuration) |
| Client-Registrierung | **Nur Admin-erzeugt pro Tenant** — kein Dynamic Client Registration |
| Login im Authorize-Flow | **Email-Code (OTP) ist fester Default.** Passwort und Passkey sind manuelle Alternativen, die der Nutzer selbst auf der Login-Seite wählt. **Kein** `login/methods`-/Methoden-Probing-Endpunkt — vermeidet User-Enumeration. Code wird im selben Fenster eingegeben (kein Magic-Link). |
| Tenant | Nutzer in mehreren Tenants → **Auswahl im Authorize-Flow**; Token an Tenant gebunden |
| Consent | **Persistenz** (gemerkte Zustimmung pro User+Client+Scopes, Re-Consent nur bei neuen Scopes) |
| JWT-Lib | **kein `jose`** — `jsonwebtoken` (RS256, `kid`-Header) + `node:crypto` (JWK-Export) |

## Integration mit bestehender Auth (Schritt 1+2)

- Wiederverwendet: RSA-JWT (`JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY`, RS256), gehashte
  Tokens (SHA-256 wie `api_tokens`), `validateScope`, `isTenantAdmin`,
  `smtpService`, Redis-Cache, **Session-System aus Schritt 2**.
- **Kritisch:** OAuth-**Access-Tokens** tragen `oauth:true` und werden in
  `getTokenFromJwt` wie Service-Tokens behandelt → **kein `sid`-Session-Check**
  (sonst würde unsere eigene Step-2-Middleware sie ablehnen). Sie setzen aber
  `usersId`/`tenantId`/`scopes`/`clientId` in den Context.
- Der **Login im Authorize-Flow** erzeugt eine normale Session (mit `sid`) →
  reiht sich nahtlos in Schritt 2 ein.

## Endpoints

**Public, Domain-Root (Discovery):**
- `GET /.well-known/openid-configuration`
- `GET /.well-known/oauth-authorization-server` (RFC 8414)
- `GET /.well-known/jwks.json` (RSA-Public-Key als JWK)

**Public, Flow:**
- `GET /oauth/authorize` — Validierung → Login (Session-Reuse oder OTP) → Tenant-Auswahl → Consent → Auth-Code
- `POST /oauth/login/start` `{email}` → OTP per Mail (Hash, TTL 10m, max 5 Versuche)
- `POST /oauth/login/verify` `{email,code}` → Session-Cookie
- `POST /oauth/consent` — Erlauben/Ablehnen (+ persistente Zustimmung)
- `POST /oauth/token` — `authorization_code` (+PKCE S256) & `refresh_token` (Rotation+Reuse-Detection); bei `openid`-Scope zusätzlich **id_token**
- `POST /oauth/revoke` (RFC 7009)
- `GET /oauth/userinfo` — Bearer Access-Token → OIDC-Claims

**Geschützt, Tenant-Admin:**
- `POST/GET/GET:id/PATCH:id/DELETE:id /tenant/:tenantId/oauth/clients`
- `POST /tenant/:tenantId/oauth/clients/:id/rotate-secret`
- `client_secret` einmalig im Response, danach nur Hash. `DELETE` → Tokens revoken.

## Scopes

- **API-Scopes:** bestehende aus `available-scopes.ts` (Client darf nur Teilmenge
  seiner erlaubten Scopes anfragen; `validateScope`).
- **OIDC-Standard (neu, separat):** `openid` (triggert id_token), `profile`, `email`.

## Datenbank (5 neue `base_*`-Tabellen)

- `base_oauth_clients` — tenantId (Owner), clientId (unique), clientSecretHash
  (nullable=public), clientName, clientType, redirectUris[], grantTypes[],
  scopes[], tokenEndpointAuthMethod, disabledAt, createdBy, createdAt.
- `base_oauth_auth_codes` — codeHash (unique), clientId, userId, tenantId,
  redirectUri, scopes[], codeChallenge, codeChallengeMethod, **nonce**,
  expiresAt (~60s), consumedAt.
- `base_oauth_refresh_tokens` — tokenHash (unique), familyId, clientId, userId,
  tenantId, scopes[], rotatedTo, revokedAt, expiresAt (~30d).
- `base_oauth_consents` — userId, clientId, scopes[], createdAt, updatedAt
  (Persistenz; unique auf userId+clientId).
- `base_email_login_codes` — email, codeHash, purpose, attempts, expiresAt
  (~10m), consumedAt.

Indizes auf alle `*Hash`-Spalten + `expiresAt`.

## Dateien

```
lib/oauth2/  index · metadata · jwks · authorize · token · revoke · userinfo
             clients · pkce · codes · tokens · oidc · consents · types
lib/auth/    email-otp.ts
db/schema/   oauth-clients · oauth-codes · oauth-refresh-tokens ·
             oauth-consents · email-login-codes
views/oauth/ login.html · consent.html
```

## Sicherheits-Abnahmekriterien

- PKCE S256 erzwungen, `plain` abgelehnt.
- `redirect_uri` exakter String-Match; bei Mismatch kein Redirect (Open-Redirect-Schutz).
- Auth-Code single-use, ≤60s, an client_id+redirect_uri gebunden.
- Access-Token kurzlebig (15m), RS256-JWT, `aud`/`iss`/`client_id`, `oauth:true`.
- Refresh-Token nur Hash at rest, Rotation, Reuse → Family-Revoke.
- Email-OTP: 6 Ziffern, ≤10m, single-use, max 5 Versuche, nur Hash.
- **Rate-Limiting** (neu zu bauen, Redis) auf `/authorize`, `/token`, `/oauth/login/*`.
- Tenant-Bindung im Token; Cross-Tenant unmöglich.
- Tokens nie in URLs/Logs; nur `Authorization`-Header. Cookies Secure/HttpOnly/SameSite.

## Phasen

| Phase | Inhalt | Status |
|---|---|---|
| 0 | Schema (5 Tabellen) + Migration + Config-Flags | ✅ erledigt (Migration 0009) |
| 1 | Email-OTP (`email-otp.ts`) + Template + Tests | ✅ erledigt (6 Tests grün) |
| 2 | OAuth2-Core: metadata, pkce, codes, tokens, authorize, token, revoke | ✅ erledigt |
| 3 | Tenant-Client-Verwaltung + Consent-Persistenz | ✅ erledigt |
| 4 | OIDC-Layer: id_token (RS256), /userinfo, jwks, openid-configuration | ✅ erledigt (RS256 via Server-RSA-Key) |
| 5 | Consent-/Login-Views (überschreibbar via `oauth2.views`) | ✅ erledigt |
| 6 | Resource-Server-Middleware (`oauth:true`) + Regression (Schritt 2) | ✅ erledigt (31 Tests grün) |
| 7 | Flow-Script (`./.scripts/oauth-flow.ts`, 16/16 PASS) | ✅ erledigt · ⚠️ Rate-Limiting noch offen |

## Tests

Echte DB via `initTests()`: `pkce`, `email-otp`, `clients` (Admin, Cross-Tenant-403,
rotate, delete→revoke), `flow` (authorize→consent→token, PKCE-Mismatch,
redirect_uri-Mismatch, Code-Reuse, Refresh-Rotation, Reuse→Family-Revoke, Revoke),
`oidc` (id_token-Claims, /userinfo, JWKS-Signaturprüfung), `consent` (Persistenz,
Re-Consent bei neuen Scopes), `middlewares` (OAuth-AT setzt Context; Step-2-Session-JWT
unverändert). + interaktives `./.scripts/oauth-flow.ts`.

## Env-Variablen (neu, mit Defaults)

```
OAUTH2_ENABLED=true
OAUTH2_ACCESS_TOKEN_TTL=15m
OAUTH2_REFRESH_TOKEN_TTL=30d
OAUTH2_AUTH_CODE_TTL=60s
OAUTH2_REQUIRE_CONSENT=true
EMAIL_LOGIN_CODE_TTL=10m
EMAIL_LOGIN_CODE_MAX_ATTEMPTS=5
# Wiederverwendet: JWT_PRIVATE_KEY/JWT_PUBLIC_KEY, SMTP_*, REDIS_*
```
