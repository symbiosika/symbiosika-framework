# Security Review — Symbiosika Framework

**Datum:** 2026-06-10
**Umfang:** Vollständiges Framework (TypeScript / Bun / Hono, Drizzle ORM + PostgreSQL), Stand `develop` (Merge `67f938c`).
**Branch des Reviews:** `claude/framework-security-review-cmxlsl`
**Art:** White-Box-Code-Review der gesamten Codebasis (kein dynamischer Pentest, keine laufende Instanz).

> Hinweis: Die per HACK-Kommentar deaktivierte Middleware `checkUserPermission`
> (`src/lib/utils/hono-middlewares.ts`) wurde auf ausdrücklichen Wunsch aus dem
> Scope ausgenommen und ist hier **nicht** als Finding gelistet.

---

## Executive Summary

Das Framework ist ein Multi-Tenant-SaaS-Baukasten mit ~60 Endpunkten, eigenem
OAuth2/OIDC-Server, acht Auth-Methoden, File-Storage, Webhooks, Server-zu-Server-
Connections und AI/Knowledge-Funktionen. Insgesamt sind viele Sicherheitsgrundlagen
solide gelöst (Passwort-Hashing mit `Bun.password`, parametrisierte Drizzle-Queries,
httpOnly-Cookies, PKCE im OAuth2-Server, gehashte API-Tokens, sauberes OTP-Design).

Der Review hat jedoch eine Reihe **schwerwiegender Autorisierungs- und
Schlüsselverwaltungs-Probleme** aufgedeckt. Die wichtigsten Themen:

1. **Token-Schmiede durch Schlüssel-Fehlkonfiguration** — der Init-Prozess legt
   den *öffentlichen* Schlüssel als `JWT_PRIVATE_KEY` ab; das gesamte Auth-System
   läuft dadurch effektiv als symmetrisches HS256 mit einem als „public"
   bezeichneten Schlüssel.
2. **Mehrere Cross-Tenant-IDOR** — Connections (inkl. Schlüsselmaterial), Webhooks,
   Knowledge-Einträge, permission-groups und Invitations waren über geratene IDs
   tenant-übergreifend lesbar/änderbar/löschbar.
3. **Systemisch: `validateScope` ist für interaktive Sessions wirkungslos** — viele
   Routen verließen sich allein darauf und waren damit für jeden eingeloggten
   Nutzer offen.
4. **SSRF** über den URL-Parser und Webhook-Zustellung; **Path Traversal** im
   lokalen File-Storage; **Secret-Leaks** in Logs.

### Severity-Verteilung

| Severity | Anzahl | IDs |
|----------|--------|-----|
| Critical | 4 | SYM-001, SYM-002, SYM-003, SYM-004 |
| High | 6 | SYM-005, SYM-006, SYM-007, SYM-008, SYM-009, SYM-010 |
| Medium | 7 | SYM-011 … SYM-017 |
| Low/Info | 5 | SYM-018 … SYM-022 |

### Status der Fixes

In diesem Branch sind die selbst-enthaltenen, verlässlich testbaren Findings
direkt behoben (siehe Spalte „Fix" unten). Die brisanten, aber **breaking**
Themen (JWT-Schlüssel/Algorithmus, OAuth-CSRF) sind bewusst **nicht** blind
geändert, weil sie eine koordinierte Schlüsselrotation bzw. Verhaltensänderung
und einen Lauf gegen eine echte Instanz erfordern; sie sind hier mit konkreter
Remediation dokumentiert.

---

## Findings

### SYM-001 — JWT-Schlüssel-Fehlkonfiguration ermöglicht Token-Fälschung — **Critical** — *Report only (breaking)*

**Fundort:** `.scripts/init.ts:102`, `src/lib/utils/jwt-keys.ts`, `src/lib/auth/index.ts:158`, `src/lib/utils/hono-middlewares.ts:48-51`, `src/lib/oauth2/keys.ts:16`, `src/lib/oauth2/tokens.ts:81`

**Beschreibung:** Der Init-Generator schreibt den öffentlichen Schlüssel in **beide**
Variablen:
```ts
JWT_PUBLIC_KEY: jwtKeys.publicKey,
JWT_PRIVATE_KEY: jwtKeys.publicKey, // jwtKeys.privateKey,
```
Die Schlüssel sind reine base64-SPKI-Strings (kein PEM). `jwt.sign(claims, JWT_PRIVATE_KEY)`
ohne `algorithm`-Option fällt damit auf **HS256** zurück und benutzt den String als
HMAC-Secret; die Verifikation (`jwt.verify(token, JWT_PUBLIC_KEY, { algorithms: undefined })`)
akzeptiert für `authType === "local"` jeden Algorithmus. Das gesamte System läuft so als
symmetrisches HS256, dessen Secret der als *public* deklarierte und überall so behandelte
Schlüssel ist.

**Angriffsszenario:** Sobald `JWT_PUBLIC_KEY` als „öffentlich" weitergegeben wird (das ist
die Erwartung an einen Public Key: JWKS-Veröffentlichung, Auth0-Style-Deployments,
Client-Konfig, versehentlicher Commit), kann ein Angreifer beliebige Tokens HS256-signieren
(`{ sub, email, oauth: true, scope: "all" }`). Solche `oauth:true`-Tokens überspringen
zusätzlich die Session-Prüfung (`hono-middlewares.ts:69,85`) → vollständige Übernahme
beliebiger Accounts/Tenants ohne DB-Zugriff. Auch ohne Veröffentlichung wird der private
Schlüssel verworfen und ein als niedrig-sensibel behandelter Wert zum Signaturschlüssel.

**Empfehlung:**
1. `.scripts/init.ts:102` auf `jwtKeys.privateKey` korrigieren und Schlüssel **rotieren**.
2. Signieren/Verifizieren explizit asymmetrisch: PEM-Wrapping der SPKI/PKCS8-Base64,
   `jwt.sign(..., privateKeyPem, { algorithm: "RS256" })`, `jwt.verify(..., publicKeyPem, { algorithms: ["RS256"] })`.
3. `algorithms` in `hono-middlewares.ts:48` **niemals** `undefined` lassen — immer pinnen.
4. OAuth-Access-Tokens nicht mit dem Verifikations-Public-Key als HMAC-Secret signieren;
   bei HS256 ein dediziertes Zufallssecret verwenden.
   *(OIDC-`id_token` ist bereits korrekt RS256 mit den echten Server-RSA-Keys.)*

**Warum nicht hier gefixt:** Breaking Change (invalidiert alle bestehenden Tokens, erfordert
PEM-Handling über alle Sign/Verify-Pfade inkl. auth0-Modus und einen Integrationslauf).

---

### SYM-002 — Cross-Tenant-IDOR auf Connections inkl. Schlüsselmaterial — **Critical** — *Behoben*

**Fundort:** `src/lib/connections/index.ts` (`getConnection`/`dropConnection`/`refreshConnection`/`verifyConnection`), `src/routes/tenant/[tenantId]/connections/index.ts`

**Beschreibung:** Die ID-basierten Connection-Operationen filterten nur nach
`connections.id`. Die Routen prüften zwar Mitgliedschaft im URL-Tenant, banden die
Connection-Zeile aber nie an diesen Tenant.

**Angriffsszenario:** Ein Admin/Mitglied von Tenant A ruft
`GET/DELETE/POST /tenant/A/connections/{connId-von-B}` und liest (inkl. öffentlichem
Schlüsselmaterial und Remote-URL), löscht oder „refresht" die Server-zu-Server-Connection
von Tenant B.

**Fix:** `getConnection`/`dropConnection`/`refreshConnection`/`verifyConnection` nehmen jetzt
einen optionalen `tenantId` und filtern damit; die Routen übergeben den Pfad-`tenantId`.

---

### SYM-003 — Cross-Tenant-IDOR auf Knowledge-Einträge (Delete/Update) — **Critical** — *Behoben*

**Fundort:** `src/lib/knowledge/permissions.ts` (`validateKnowledgeAccess`), `src/lib/knowledge/update-knowledge.ts`

**Beschreibung:** `validateKnowledgeAccess` filterte nicht nach `tenantId`. Die erste
Klausel erlaubte über `isNull(knowledgeEntry.teamId)` Zugriff auf **jeden** Eintrag ohne
Team — tenant-übergreifend. Delete/Update operierten anschließend nur per `id`.

**Angriffsszenario:** Ein Mitglied von Tenant A löscht oder überschreibt per
`DELETE/PUT /tenant/A/knowledge/entries/{id-von-B}` Knowledge-Einträge von Tenant B,
sofern deren `teamId` NULL ist (der häufige Default).

**Fix:** `validateKnowledgeAccess` erzwingt jetzt in allen Zweigen
`eq(knowledgeEntry.tenantId, tenantId)`; zusätzlich wurden die Delete/Update-Queries in
`update-knowledge.ts` defensiv um den Tenant-Filter ergänzt.

---

### SYM-004 — Cross-Tenant-IDOR auf Webhooks + `hasAccessToWebhook`-Stub — **Critical** — *Behoben*

**Fundort:** `src/lib/webhooks/crud.ts`, `src/routes/tenant/[tenantId]/webhooks/index.ts`

**Beschreibung:** `hasAccessToWebhook` gab unbedingt `true` zurück; `getWebhookById`/
`updateWebhook`/`deleteWebhook` filterten nur per `id`; die Routen hatten keine
`isTenantMember`-Prüfung (nur das wirkungslose `validateScope`, siehe SYM-005).

**Angriffsszenario:** Jeder eingeloggte Nutzer konnte beliebige Webhooks aller Tenants
auslesen (inkl. `webhookUrl` + Header), umschreiben (Ziel-URL kapern) oder löschen.

**Fix:** Der Stub wurde durch `getWebhookForTenant` ersetzt; alle CRUD-Funktionen erzwingen
`and(eq(id), eq(tenantId))`; `isTenantMember` wurde allen Webhook-Routen vorangestellt; die
Routen reichen den Pfad-`tenantId` durch.

---

### SYM-005 — `validateScope` ist für interaktive Sessions ein No-op — **High** — *Teilweise behoben (Routen-Härtung)*

**Fundort:** `src/lib/utils/validate-scope.ts:14-17`, `src/lib/utils/hono-middlewares.ts:157`, `src/lib/auth/index.ts:141-187`

**Beschreibung:** Login-JWTs tragen kein `scopes`-Claim. `checkToken` defaultet fehlende
Scopes auf `["all"]`, und `validateScope` ruft bei `["all"]` sofort `next()`. Damit ist
`validateScope(...)` für **jede** normale Nutzer-Session wirkungslos und schränkt nur
API-Tokens ein. Routen, die ausschließlich auf `validateScope` als Autorisierung setzten,
waren für jeden eingeloggten Nutzer offen.

**Angriffsszenario:** Grundlage für SYM-004/006/007/008/009 — überall dort, wo nur
`validateScope` und kein `isTenantMember`/`isTenantAdmin` stand.

**Fix/Empfehlung:** Die betroffenen Routen wurden mit echten Tenant-Middlewares gehärtet
(siehe SYM-002/004/006/007). Grundlegende Empfehlung: interaktive Sessions sollten nicht
implizit `["all"]` erhalten — entweder echte Scopes vergeben oder `validateScope` so
umbauen, dass es Sessions nicht durchwinkt. Das ist eine systemische Änderung mit
Breaking-Potenzial und wurde daher nicht global umgestellt.

---

### SYM-006 — permission-groups-Routen ohne Tenant-Autorisierung — **High** — *Behoben*

**Fundort:** `src/routes/tenant/[tenantId]/permission-groups/index.ts` (alle 11 Endpunkte)

**Beschreibung:** Jede Route war nur mit `authAndSetUsersInfo` + (wirkungslosem)
`validateScope` registriert — kein `isTenantMember`/`isTenantAdmin`. Die Lib-Funktionen
operieren per `id`.

**Angriffsszenario:** Jeder eingeloggte Nutzer konnte permission-groups und
path-permissions **jedes** Tenants anlegen/lesen/ändern/löschen.

**Fix:** Allen 11 Endpunkten wurde `isTenantAdmin` vorangestellt. *Empfehlung zusätzlich:*
die Lib-Queries je Zeile auf den Tenant scopen (verifizieren, dass Gruppe/Permission zum
Tenant gehören), um Defense-in-Depth zu vervollständigen.

---

### SYM-007 — Cross-Tenant-Löschen/Ablehnen von Invitations — **High** — *Behoben*

**Fundort:** `src/lib/usermanagement/invitations.ts` (`dropTenantInvitation`/`declineTenantInvitation`), `src/routes/tenant/[tenantId]/invitations/index.ts`

**Beschreibung:** `dropTenantInvitation`/`declineTenantInvitation` operierten per `id` ohne
Tenant-Filter; die Decline-Route hatte zudem gar keine Mitgliedsprüfung.

**Angriffsszenario:** Ein Admin von Tenant A löschte per
`DELETE /tenant/A/invitations/{id-von-B}` Invitations von Tenant B; Decline war für jeden
eingeloggten Nutzer gegen beliebige Invitation-IDs aufrufbar.

**Fix:** Beide Funktionen filtern jetzt `and(eq(id), eq(tenantId))`; die Routen übergeben
`tenantId`; die Decline-Route erhielt `isTenantMember`.

---

### SYM-008 — SSRF über URL-Parser und Webhook-Zustellung — **High** — *Behoben*

**Fundort:** `src/lib/knowledge/parsing/url.ts:65` (aufgerufen aus `knowledge/index.ts:788`), `src/lib/webhooks/trigger.ts:49`

**Beschreibung:** `fetch()` auf eine nutzer-/admin-kontrollierte URL ohne jede Validierung,
mit automatischem Redirect-Folgen. Erreichbar für authentifizierte Tenant-Nutzer.

**Angriffsszenario:** Ein Nutzer lässt den Server eine URL wie
`http://169.254.169.254/latest/meta-data/` oder interne Adressen (`127.0.0.1`, `10.x`,
`192.168.x`) abrufen und bekommt teils den Antwort-Body zurück → Zugriff auf
Cloud-Metadaten/interne Dienste.

**Fix:** Neue Guard-Utility `src/lib/utils/url-guard.ts` (`assertPublicHttpUrl`,
`fetchWithSsrfGuard`) blockt Nicht-HTTP-Schemata, `localhost` und private/loopback/
link-local/ULA-Bereiche (IPv4 + IPv6, inkl. IPv4-mapped) und validiert **jeden**
Redirect-Hop via manuellem Folgen. Verdrahtet in `url.ts` und `webhooks/trigger.ts`.
Unit-Tests: `src/lib/utils/url-guard.test.ts`.

---

### SYM-009 — Path Traversal im lokalen File-Storage — **High** — *Behoben*

**Fundort:** `src/lib/storage/local.ts`, Routen `src/routes/tenant/[tenantId]/files/index.ts`

**Beschreibung:** `bucket` und `filename` aus den Request-Pfadparametern landeten unsaniert
in `path.join(ATTACHMENT_DIR, bucket, name)` für Read/Write/Delete. `..`-Segmente
ermöglichten das Verlassen des Upload-Verzeichnisses.

**Angriffsszenario:** Ein authentifizierter Tenant-Nutzer liest/löscht beliebige Dateien
im Prozesskontext bzw. fremde Tenant-Buckets (z. B. `../../.env`, Server-Keys).

**Fix:** `safeAttachmentPath()` validiert jedes Segment gegen `^[A-Za-z0-9._-]+$` (lehnt
`..`, `/`, `\`, Nullbytes ab) und prüft per `path.resolve`-Containment, dass der Zielpfad
innerhalb von `ATTACHMENT_DIR` bleibt. Angewandt auf save/get/delete. Unit-Tests:
`src/lib/storage/local.test.ts`.

---

### SYM-010 — OAuth-Login-CSRF (`state` fehlt) + Token in Redirect-URL — **High** — *Report only*

**Fundort:** `src/lib/auth/oauth2.ts:193-218`, `src/routes/user/public.ts:689-721`

**Beschreibung:** Die Google-/Microsoft-Login-URLs setzen keinen `state`-Parameter; der
Callback validiert `state` nie. Bei Erfolg wird per
`c.redirect(.../${provider}?token=${result.token})` das Session-Token in der URL übergeben.

**Angriffsszenario:** Klassisches Login-CSRF / Account-Fixation (Opfer wird still in den
Account des Angreifers eingeloggt). Zusätzlich Token-Leak über Referer/History/Logs.

**Empfehlung:** Zufälliges `state` generieren, an die Session (Cookie) binden, im Callback
prüfen; Token über sicheres Cookie / POST-Body statt URL-Query zurückgeben; PKCE
clientseitig erwägen.

---

### SYM-011 — WhatsApp-Inbound-Webhook ohne Signaturprüfung, IP-Allowlist deaktiviert — **Medium** — *Report only*

**Fundort:** `src/routes/communiation/wa/index.ts`, `src/index.ts:276-289`

**Beschreibung:** Der POST-Handler verarbeitet `processWebhook(body)` ohne
`X-Hub-Signature-256`-HMAC-Prüfung; die `ipRestriction` ist mit `allowList: ["*"]`
effektiv abgeschaltet (echte Meta-IPs auskommentiert).

**Angriffsszenario:** Beliebige Dritte können gefälschte WhatsApp-Events einliefern; der
Handler ordnet sie per `wa_id` einem Nutzer zu → Nachrichten-Spoofing/Impersonation in die
nachgelagerte Chat-/AI-Verarbeitung.

**Empfehlung:** `X-Hub-Signature-256` gegen das Meta-App-Secret verifizieren, bevor
verarbeitet wird; echte IP-Allowlist reaktivieren.

---

### SYM-012 — OAuth2 Consent-CSRF — **Medium** — *Report only*

**Fundort:** `src/lib/oauth2/index.ts:257-306`

**Beschreibung:** `POST /oauth/consent` nimmt die Entscheidung aus dem Formular-Body, stützt
sich nur auf das Session-Cookie und hat keinen CSRF-Token/Origin-Check; `authorize_query`
kommt aus einem manipulierbaren Hidden-Field.

**Empfehlung:** CSRF-Token an die Session binden und serverseitig prüfen; `Origin`/
`Sec-Fetch-Site` validieren; Authorize-Parameter serverseitig (signiert/gespeichert) statt
im Hidden-Field führen.

---

### SYM-013 — Authorization-Code / Refresh-Token Single-Use nicht race-sicher — **Medium** — *Report only*

**Fundort:** `src/lib/oauth2/codes.ts:68-101`, `src/lib/oauth2/tokens.ts:184-219`

**Beschreibung:** Lesen → Prüfen → Update erfolgt ohne Transaktion/Row-Lock und ohne
`WHERE consumed_at IS NULL` auf dem UPDATE (TOCTOU). Gleiches Muster bei der
Refresh-Token-Rotation.

**Empfehlung:** Konsum atomar machen:
`UPDATE ... SET consumed_at = now() WHERE id = ? AND consumed_at IS NULL RETURNING *` und
0 betroffene Zeilen als „bereits benutzt" behandeln.

---

### SYM-014 — Offene, unauthentifizierte Dynamic Client Registration — **Medium** — *Report only*

**Fundort:** `src/lib/oauth2/index.ts:436-483`, `src/lib/oauth2/clients.ts`

**Beschreibung:** `POST /oauth/register` benötigt keine Auth, legt einen `public`-Client mit
`tenantId: null` an und übernimmt eine vom Aufrufer gelieferte `client_id` (client_id-
Squatting / Ressourcen-Missbrauch).

**Empfehlung:** Registrierung deaktivieren oder gaten (Initial-Access-Token/Admin);
keine aufrufergesteuerte `client_id` zulassen; dynamische Clients limitieren/scopen.

---

### SYM-015 — Admin-Log-Routen nur durch No-op-Scope geschützt — **Medium** — *Report only*

**Fundort:** `src/routes/admin/index.ts:19-108`

**Beschreibung:** `/admin/logs/download` und `/admin/logs/clear` nutzen nur
`validateScope("app:logs")` ohne echte Plattform-Admin-Prüfung. Wegen SYM-005 passieren
Sessions diese Prüfung.

**Angriffsszenario:** Jeder eingeloggte Nutzer kann alle Server-Logs (potenziell Secrets/
PII) herunterladen und löschen.

**Empfehlung:** Hinter eine echte Plattform-Admin-Prüfung stellen, nicht nur einen Scope,
den Sessions umgehen.

---

### SYM-016 — Teams: Create/List ohne Mitgliedsprüfung; Team-Ops nicht Tenant-gebunden — **Medium** — *Report only*

**Fundort:** `src/routes/tenant/[tenantId]/teams/index.ts`, `src/lib/usermanagement/teams.ts`

**Beschreibung:** `POST /teams` und `GET /teams` haben kein `isTenantMember`; Create macht
den Aufrufer zum Team-Admin. `:teamId`-Routen prüfen Team-Mitgliedschaft, verifizieren aber
nicht `teams.tenantId === URL-tenantId`.

**Empfehlung:** `isTenantMember` an Create/List; in den `:teamId`-Middlewares/Queries
`teams.tenantId === tenantId` erzwingen.

---

### SYM-017 — Kein Rate-Limiting auf Auth-Endpunkten — **Medium** — *Report only*

**Fundort:** `src/routes/user/public.ts` (`/user/login`, `/user/request-login-code`,
`/user/send-magic-link`, `/user/forgot-password`, `/user/reset-password`, `/user/token-exchange`)

**Beschreibung:** Keine erkennbare Drosselung. Brute-Force von Passwörtern/Tokens und
Mail-Bombing über die Magic-Link-/Verifikations-Endpunkte möglich. (Das OTP-Modul kappt
immerhin Verifikationsversuche pro Code.)

**Empfehlung:** IP-/Account-basiertes Rate-Limiting + exponentielles Backoff auf alle
credential- und mailauslösenden Endpunkte.

---

### SYM-018 — AES-256-CBC ohne Authentizität — **Low** — *Report only*

**Fundort:** `src/lib/crypt/aes.ts`

**Beschreibung:** Tenant-Secrets werden mit AES-256-CBC ohne MAC/AEAD verschlüsselt (GCM-Pfad
existiert, ist aber nicht Default). Kein Integritätsschutz; bei künftiger Exponierung eines
Entschlüsselungs-Orakels Padding-Oracle-Risiko.

**Empfehlung:** Auf AES-256-GCM (oder Encrypt-then-MAC) als Default umstellen; das
Key-Versioning unterstützt das bereits.

---

### SYM-019 — User-Enumeration bei „forgot-password" — **Low** — *Behoben*

**Fundort:** `src/lib/auth/index.ts` (`forgotPasswort`)

**Beschreibung:** Vorher warf die Funktion „User not found" für unbekannte Adressen
(über HTTP 500 sichtbar) → Account-Enumeration. (Das OTP-/Magic-Link-Design ist hier
vorbildlich.)

**Fix:** Gibt jetzt unabhängig von der Existenz eine generische Erfolgsmeldung zurück und
versendet den Reset-Link nur, wenn der Account existiert; Fehler werden serverseitig
geloggt. *Empfehlung zusätzlich:* auch die Login-Fehlermeldungen (`"Invalid login: ..."`)
generisch halten (derzeit werden „user not found"/„passwords do not match"/„Email is not
verified" durchgereicht).

---

### SYM-020 — Secret-Leaks in Logs — **Low** — *Behoben*

**Fundort:** `src/lib/utils/jwt-keys.ts`, `src/lib/crypt/aes.ts`, `src/lib/communication/whatsapp/send.ts`

**Beschreibung:** Beim Erstgenerieren wurden JWT-Private-Key und AES-Master-Key per
`console.log` ausgegeben; `whatsapp/send.ts` loggte das Token-Präfix.

**Fix:** JWT-/AES-Schlüssel werden nun in eine lokale Datei mit `0600` geschrieben (statt
stdout), und nur der Dateipfad wird ausgegeben; das WhatsApp-Token-Log wurde entfernt.

---

### SYM-021 — `sql.raw()` mit Embedding-Vektor in Similarity-Search — **Low/Info** — *Report only*

**Fundort:** `src/lib/knowledge/similarity-search.ts:101`

**Beschreibung:** `sql.raw(`'[${embed.embedding}]'`)` interpoliert den Embedding-Vektor
direkt. Der Vektor ist serverseitig generiert (numerisch), daher derzeit nicht injizierbar.
Der `tenantId`-Filter in der Query ist korrekt parametrisiert.

**Empfehlung:** Den Vektor als Parameter binden oder vor der Interpolation streng als
Zahlen-Array validieren, um die Annahme „nur Zahlen" abzusichern.

---

### SYM-022 — Verbose Fehler-Reflektion & CORS-Default `["*"]` — **Low/Info** — *Report only*

**Fundort:** zahlreiche Handler (`"… " + err`), `src/index.ts:161-166`, `README.md:28`

**Beschreibung:** Viele Handler geben interne Fehlertexte an den Client zurück (Info-Leak).
Der dokumentierte CORS-Default ist `allowedOrigins: ["*"]`. Da die CORS-Middleware keine
`credentials: true` setzt, ist der Cookie-basierte Pfad nicht direkt cross-origin lesbar;
dennoch ist `*` als Default unnötig weit.

**Empfehlung:** Generische Client-Fehler + serverseitiges Detail-Logging; restriktive
`allowedOrigins`-Defaults dokumentieren/erzwingen.

---

## Positivbefunde

- **Passwort-Hashing** via `Bun.password.hash/verify` (`src/lib/auth/index.ts`).
- **Parametrisierte Queries** durchgängig über Drizzle; keine String-konkatenierte SQL.
- **OTP-Design** (`src/lib/auth/email-otp.ts`): nur Hash gespeichert, Single-Use, TTL,
  Versuchslimit, keine User-Enumeration.
- **API-Tokens** werden nur als SHA-256-Hash gespeichert; Scopes validiert.
- **Cookies** httpOnly + secure (bei https) + SameSite=Lax; separater nicht-sensibler
  `jwt_present`-Marker.
- **OAuth2-Server:** PKCE für alle Clients verpflichtend (nur S256), timing-sicherer
  PKCE-Vergleich, Redirect-URI-Exact-Match, Codes/Tokens an `client_id` gebunden, OIDC-
  `id_token` korrekt RS256/JWKS, keine Scope-Eskalation.
- **Sessions:** serverseitige `sid`-Prüfung pro Request macht Logout/Passwort-Reset wirksam
  revozierbar.
- **Tenant-Middlewares** `isTenantMember`/`isTenantAdmin` prüfen korrekt gegen den
  URL-`tenantId` (nicht den JWT-Claim).

---

## Priorisierte Maßnahmenliste

**Sofort (Critical):**
1. SYM-001 JWT-Schlüssel korrigieren (`init.ts` → privateKey), RS256 pinnen, **Keys rotieren**.
2. SYM-002/003/004 sind in diesem Branch behoben — reviewen & deployen.

**Kurzfristig (High):**
3. SYM-005 Scope-Modell: Sessions nicht implizit `["all"]` geben (systemische Änderung).
4. SYM-010 OAuth-Login-`state` + Token nicht in URL.
5. SYM-006/007/008/009 (behoben) reviewen.

**Mittelfristig (Medium):**
6. SYM-011 WhatsApp-Signatur + IP-Allowlist.
7. SYM-012/013/014 OAuth-Härtung (Consent-CSRF, atomarer Code-Konsum, Registrierung gaten).
8. SYM-015/016 echte Admin-Prüfung für Logs; Teams Tenant-Bindung.
9. SYM-017 Rate-Limiting.

**Aufräumen (Low/Info):**
10. SYM-018 AES-GCM; SYM-019 (behoben) Login-Meldungen generisch; SYM-021 Embedding binden;
    SYM-022 Fehler-/CORS-Härtung.

---

## In diesem Branch umgesetzte Fixes (Übersicht)

| Finding | Geänderte Dateien |
|---------|-------------------|
| SYM-002 | `src/lib/connections/index.ts`, `src/routes/tenant/[tenantId]/connections/index.ts` |
| SYM-003 | `src/lib/knowledge/permissions.ts`, `src/lib/knowledge/update-knowledge.ts` |
| SYM-004 | `src/lib/webhooks/crud.ts`, `src/routes/tenant/[tenantId]/webhooks/index.ts` |
| SYM-006 | `src/routes/tenant/[tenantId]/permission-groups/index.ts` |
| SYM-007 | `src/lib/usermanagement/invitations.ts`, `src/routes/tenant/[tenantId]/invitations/index.ts` |
| SYM-008 | `src/lib/utils/url-guard.ts` (neu), `src/lib/knowledge/parsing/url.ts`, `src/lib/webhooks/trigger.ts` |
| SYM-009 | `src/lib/storage/local.ts` |
| SYM-019 | `src/lib/auth/index.ts` |
| SYM-020 | `src/lib/utils/jwt-keys.ts`, `src/lib/crypt/aes.ts`, `src/lib/communication/whatsapp/send.ts` |

**Neue Tests:** `src/lib/utils/url-guard.test.ts`, `src/lib/storage/local.test.ts`
(9 Tests, grün). Typecheck (`bun run build` / `tsc`) ist grün.

## Verifikation

```bash
bun install
bun run build                      # tsc — grün
bun test src/lib/utils/url-guard.test.ts src/lib/storage/local.test.ts
```

Die vollständige Test-Suite benötigt eine PostgreSQL-Instanz (siehe
`docker-compose.yml`) und wurde in dieser Umgebung nicht end-to-end ausgeführt; die
geänderten Module sind über Typecheck und die neuen Unit-Tests abgesichert.
