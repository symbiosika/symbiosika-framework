# Migrationsanleitung: Connections mit „leading/following"

> Für einen Coding-Agent, der eine **App** betreut, die das alte
> Connections-/Tenant-Sync-Verhalten des `@symbiosika/framework` bereits
> implementiert hatte. Diese Anleitung beschreibt, **was sich geändert hat** und
> **was die App umstellen muss**. Sie ist eigenständig lesbar (kein weiterer
> Kontext nötig).

---

## 1. Was ist neu (in 3 Sätzen)

1. Eine Verbindung hat jetzt pro Seite eine **Rolle**: `leading` (Quelle der
   Wahrheit) oder `following` (spiegelt den Leader). Das ist unabhängig davon,
   wer den Handshake gestartet hat (`initiatedBy`).
2. **Nur die `following`-Seite legt lokal einen Spiegel ("Shadow") des
   Remote-Tenants an.** Die `leading`-Seite (typischerweise der Hauptserver)
   legt **keinen** Tenant des Clients mehr an — das war die Ursache der
   Namens-Kollisionen.
3. Tenant-Namen müssen nur noch **unter lokalen Tenants** eindeutig sein
   (`tenants.origin = 'local'`); gespiegelte Remote-Tenants dürfen Namen teilen.

Außerdem: Verbindungsaufbau ist jetzt **staged** (`status: pending → active` mit
Rollback bei Fehler), ein optionaler **Edge-Modus** kann den Client zu einem
reinen Spiegel machen, und **Selbstverbindungen** (Server gegen sich selbst)
werden abgelehnt.

---

## 2. Breaking Changes auf einen Blick

| Bereich | Vorher | Jetzt |
|---|---|---|
| Tenant des Clients auf dem Hauptserver | wurde als lokaler Tenant angelegt | **wird NICHT mehr angelegt** (nur `connections.remoteTenantId`) |
| `tenants.name` Eindeutigkeit | global unique | **partial unique** nur für `origin='local'` |
| `connections` Tabelle | – | neue Spalten **`role`**, **`status`**, **`remoteTenantId`** |
| `tenants` Tabelle | – | neue Spalte **`origin`** (`local`/`remote`) |
| Ablageort einer `following`-Connection | unter dem initiierenden lokalen Tenant | **unter dem übernommenen Leader-Tenant** |
| `initializeConnection(...)` | 6 Parameter | + 7. Parameter `options` (`role`, `replaceLocalTenants`, `actingUserId`) |
| `initializeConnectionWithToken(...)` | 6 Parameter | + `options` |
| `acceptConnection(...)` | 7 Parameter | + 8. Parameter `role` |
| `ConnectionEstablishedContext` (Post-Connection-Action) | ohne `role` | hat jetzt **`role`**; `remoteTenantId` existiert auf der `leading`-Seite **nicht** lokal |
| Selbstverbindung (remoteUrl == eigene baseUrl) | lief (fehlerhaft) durch | **wird abgelehnt** |

---

## 3. Schritt-für-Schritt-Umstellung

### 3.1 Datenbank-Migration ausführen (immer)

Die neue Framework-Version bringt Migration `0014` mit (neue Enums/Spalten,
Partial-Unique-Index). Im App-Deploy:

```bash
bun run framework:migrate     # bzw. euer Migrations-Kommando (drizzle-kit migrate)
```

Bestandsdaten sind unkritisch: existierende Tenants bekommen `origin='local'`,
existierende Connections `role='leading'`, `status='active'`, `remoteTenantId=NULL`.

> Optional/empfohlen: Alte Shadow-Tenants, die der Hauptserver früher für Clients
> angelegt hat, bleiben als `origin='local'` liegen. Wenn ihr sie als „remote"
> kennzeichnen wollt (oder löschen), schreibt dafür eine eigene Backfill-Migration.

### 3.2 Rolle beim Verbindungsaufbau setzen

Beim Aufruf von `POST /api/v1/tenant/:tenantId/connections/init` (bzw.
`/init-with-token`) gibt es zwei neue **optionale** Felder im JSON-Body:

```jsonc
{
  "remoteUrl": "...",
  "remoteEmail": "...",
  "remotePassword": "...",
  "remoteTenantId": "...",
  "name": "...",
  // NEU:
  "role": "following",          // Default. Der anfragende Client folgt dem Server.
  "replaceLocalTenants": false  // Default. true => Edge-/Spiegel-Modus (s. 3.4)
}
```

Standardverhalten (Felder weglassen) = **Client folgt, Server führt** — also
genau der Normalfall. Die Gegenseite wird automatisch auf die entgegengesetzte
Rolle gesetzt; ihr müsst `exchange-keys` nicht selbst aufrufen.

### 3.3 Wenn eure App der **Hauptserver** ist (`leading`)

Das ist die wichtigste Änderung. **Der Server legt keinen Tenant des Clients
mehr an.**

- ❌ **Entfernen:** jede App-Logik, die sich darauf verließ, dass nach einer
  eingehenden Verbindung ein lokaler Tenant mit der Client-Tenant-ID existiert
  (z.B. „connected clients" aus der `tenants`-Tabelle auslesen, Daten an diesem
  Shadow-Tenant hängen, etc.).
- ✅ **Stattdessen:** die verbundenen Clients über die `connections`-Tabelle
  ermitteln. Die Client-Tenant-ID steht in **`connections.remoteTenantId`**,
  die Rolle in `connections.role` (`leading` = ihr führt diese Verbindung).

  ```sql
  SELECT remote_tenant_id, remote_url, name, status
  FROM base_connections
  WHERE tenant_id = :ownTenantId AND role = 'leading';
  ```

- ❌ **Entfernen:** App-Workarounds gegen Tenant-Namens-Kollisionen beim
  Verbindungsaufbau. Die gibt es durch die Partial-Unique-Regel nicht mehr.

### 3.4 Wenn eure App der **Client/Edge** ist (`following`)

- Der Client **übernimmt den Leader-Tenant lokal** (`origin='remote'`, gleiche
  ID wie auf dem Server). Die Connection wird **unter diesem Leader-Tenant**
  geführt, nicht mehr unter dem ursprünglichen lokalen Client-Tenant.
- ❌ **Entfernen:** falls die App bisher selbst „nach dem Verbinden alle anderen
  Tenants löschen" implementiert hatte (der ursprüngliche Problem-Workaround) —
  **raus damit.** Das übernimmt jetzt das Framework sicher, wenn ihr beim Init
  `replaceLocalTenants: true` setzt:
  - der initiierende Admin wird automatisch **Owner** des übernommenen Tenants
    (kein Aussperren),
  - erst danach werden alle anderen lokalen Tenants gelöscht (cascade),
  - alles erst **nach** erfolgreichem Handshake (vorher Rollback).
- ✅ **Wichtig nach dem Init:** Die App muss anschließend im Kontext des
  **übernommenen Leader-Tenants** arbeiten. Konkret:
  - Tenant-Kontext / „aktiven Tenant" der App auf `remoteTenantId` umstellen,
  - ggf. Session/JWT erneuern (alte Tokens waren auf den alten Tenant gescoped),
  - Listings/Disconnect (`GET .../connections`, `DELETE .../self-disconnect`)
    mit der **neuen** (Leader-)Tenant-ID aufrufen.

### 3.5 Post-Connection-Actions anpassen (falls genutzt)

Wenn die App `registerPostConnectionAction(...)` verwendet:

```ts
registerPostConnectionAction(async (ctx) => {
  // ctx hat jetzt zusätzlich: ctx.role ("leading" | "following")
  // ACHTUNG: ctx.remoteTenantId existiert auf der LEADING-Seite NICHT als
  // lokaler Tenant. Nicht mehr blind getTenant(ctx.remoteTenantId) annehmen.
  if (ctx.role === "following") {
    // hier ist der Leader-Tenant lokal vorhanden (origin='remote')
  } else {
    // leading: nur connections.remoteTenantId als Referenz, kein lokaler Tenant
  }
});
```

### 3.6 Direkte Service-Aufrufe anpassen (falls die App den Service direkt nutzt)

Falls die App `connectionsService` direkt aufruft (statt nur die Routen):

```ts
// VORHER
await connectionsService.initializeConnection(
  localTenantId, remoteUrl, email, password, remoteTenantId, name
);

// JETZT (options optional; Default role="following")
await connectionsService.initializeConnection(
  localTenantId, remoteUrl, email, password, remoteTenantId, name,
  { role: "following", replaceLocalTenants: false, actingUserId }
);

// acceptConnection hat einen zusätzlichen role-Parameter (Default "leading")
await connectionsService.acceptConnection(
  localTenantId, remoteUrl, remoteTenantId, remoteConnectionId,
  remotePublicKey, connectionName, remoteTenantName,
  "leading"
);
```

Neu exportiert: `connectionsService.isSelfConnectionUrl(remoteUrl)` /
`isSelfConnectionUrl(remoteUrl)` — nützlich, um in der UI einen Selbstverbindungs-
Versuch früh abzufangen (der Service wirft sonst beim Init einen Fehler).

---

## 4. Checkliste für den Agent

- [ ] Framework-Version aktualisiert, `framework:migrate` läuft fehlerfrei.
- [ ] (Hauptserver) Alle Stellen entfernt, die einen lokal angelegten
      Client-Tenant erwarteten; auf `connections.remoteTenantId` umgestellt.
- [ ] (Hauptserver) Tenant-Namens-Kollisions-Workarounds entfernt.
- [ ] (Client) Eigene „Tenants löschen nach Verbinden"-Logik entfernt; bei
      Bedarf `replaceLocalTenants: true` beim Init gesetzt.
- [ ] (Client) Nach Init auf den Leader-Tenant-Kontext umgestellt
      (aktiver Tenant + Session/JWT erneuern).
- [ ] `init`/`init-with-token`-Aufrufe um `role`/`replaceLocalTenants` ergänzt,
      wo nötig (sonst Defaults).
- [ ] Direkte `initializeConnection`/`acceptConnection`-Aufrufe um neue Parameter
      ergänzt.
- [ ] Post-Connection-Actions: `ctx.role` berücksichtigt, kein blindes
      `getTenant(remoteTenantId)` auf der leading-Seite.
- [ ] Connection-Listings/Disconnect nutzen die korrekte Tenant-ID (bei
      following: den Leader-Tenant).
- [ ] Selbstverbindungs-Fall in der UI sauber abgefangen.

---

## 5. Was man jetzt NICHT mehr braucht

- Kein manuelles Anlegen/Pflegen von Shadow-Tenants des Clients auf dem Server.
- Keine eigenen Umbenennungs-/Dedupe-Tricks gegen `tenants.name`-Kollisionen.
- Keine selbstgebaute „reset to single tenant"-Routine auf dem Client
  (→ `replaceLocalTenants: true`).

---

## 6. Testhinweis

Das Framework bringt eine self-contained Test-Suite mit
(`src/test/connections.test.ts`), die die Rollen-Logik gegen eine In-Process-DB
prüft (keine externe DB nötig). Als Vorlage für App-eigene Tests gut geeignet —
insbesondere das Mock-Muster für die Gegenseite am `fetch`-Rand.
