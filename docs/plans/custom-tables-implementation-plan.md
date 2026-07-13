# Umsetzungsplan: Custom Tables ("Airtable light")

Tenant-scoped, benutzerdefinierte Tabellen mit den Feldtypen **Text, Zahl, Datum**, verwaltet und abgefragt über die REST-API. Zielgröße: ~1.000 Zeilen pro Tabelle (kein Big-Data-Anspruch).

## 1. Architekturentscheidung (fix, nicht neu diskutieren)

**Kein dynamisches DDL.** Es werden keine echten Postgres-Tabellen zur Laufzeit angelegt. Stattdessen zwei statische Drizzle-Tabellen:

- `custom_tables` — Metadaten + Felddefinitionen (Schema) als JSONB
- `custom_table_rows` — die Zeilen, Nutzdaten als JSONB

Validierung der Zeilen gegen das gespeicherte Schema passiert zur Laufzeit in der Applikationsschicht (dynamisch gebaute Valibot-Schemas). Filter/Sortierung laufen über Postgres-JSONB-Operatoren mit Typ-Casts, die aus dem gespeicherten Schema abgeleitet werden.

Dieses Muster existiert im Repo bereits ähnlich in `src/lib/db/schema/additional-data.ts` (JSONB + Indizes), dort aber als Key-Value. Hier wird es tabellarisch.

## 2. Datenmodell

Neue Datei: `src/lib/db/schema/custom-tables.ts`. Konventionen aus den bestehenden Schema-Dateien übernehmen (`pgBaseTable` aus `./index` — prefixt Tabellennamen mit `base_`; `drizzle-valibot` Select/Insert/Update-Schemas; `relations`).

### `custom_tables`

| Spalte | Typ | Anmerkung |
|---|---|---|
| `id` | uuid PK | `default gen_random_uuid()` |
| `tenantId` | uuid FK → `tenants.id` | `onDelete: "cascade"`, notNull |
| `name` | varchar(100) | technischer Name, notNull; `unique(tenantId, name)` |
| `label` | varchar(255) | Anzeigename, optional |
| `description` | text | optional |
| `fields` | jsonb | Array von Felddefinitionen (siehe unten), notNull |
| `createdAt` / `updatedAt` | timestamp (mode: "string") | defaultNow, notNull |

Indizes: unique auf `(tenantId, name)`, Index auf `tenantId`.

### `custom_table_rows`

| Spalte | Typ | Anmerkung |
|---|---|---|
| `id` | uuid PK | `default gen_random_uuid()` |
| `tableId` | uuid FK → `custom_tables.id` | `onDelete: "cascade"`, notNull |
| `data` | jsonb | notNull |
| `createdAt` / `updatedAt` | timestamp (mode: "string") | defaultNow, notNull |

Indizes: Index auf `tableId`, GIN-Index auf `data` (per `sql`-Fragment in der Index-Definition oder direkt in der generierten Migration ergänzen).

### Registrierung

In `src/lib/db/db-schema.ts` nach dem Muster der anderen Schema-Dateien einbinden (`import * as customTables from "./schema/custom-tables"`, `export * from ...`, in das zusammengeführte Schema-Objekt spreaden).

Migration erzeugen mit `bun run framework:generate` (landet in `drizzle-sql/`), anwenden mit `bun run framework:migrate`.

## 3. Felddefinitionsformat

```ts
type CustomTableFieldType = "text" | "number" | "date";

interface CustomTableField {
  name: string;      // ^[a-z][a-z0-9_]{0,49}$ — technischer Schlüssel im data-JSONB
  type: CustomTableFieldType;
  label?: string;    // Anzeigename
  required?: boolean; // default false
}
```

Regeln (bei Create/Update der Tabelle serverseitig validieren):

- `name` eindeutig innerhalb der Tabelle, Regex wie oben, reservierte Namen verbieten: `id`, `createdAt`, `updatedAt`.
- Max. 100 Felder pro Tabelle.
- `date` wird als ISO-8601-String (`YYYY-MM-DD` oder voller Timestamp) im JSONB gespeichert; `number` als JSON number; `text` als string.

## 4. Neues Lib-Modul `src/lib/custom-tables/`

### `validation.ts`

- `buildRowValidator(fields: CustomTableField[])` → baut dynamisch ein `v.object({...})` (Valibot):
  - `text` → `v.string()`
  - `number` → `v.number()`
  - `date` → `v.pipe(v.string(), v.isoDate())` oder ISO-Timestamp-Check
  - `required: false` → `v.optional(...)`
  - Unbekannte Keys ablehnen (`v.strictObject`) bei **Insert**; bei **Read** tolerant sein (alte Rows nach Schema-Änderung nicht hart failen lassen).
- Validierungsfehler als HTTP 400 mit feldgenauer Fehlermeldung durchreichen.

### `crud.ts` (Tabellen-Verwaltung)

- `createCustomTable(tenantId, input)` — validiert Felddefinitionen, legt Tabelle an.
- `getCustomTable(tenantId, tableId)` / `getCustomTableByName(tenantId, name)` — immer tenant-scoped abfragen (WHERE `tenantId` **und** `id`), niemals nur über die id, sonst Cross-Tenant-Leak.
- `listCustomTables(tenantId)` — Metadaten inkl. Zeilenanzahl (`count(*)` Subquery, optional).
- `updateCustomTable(tenantId, tableId, input)` — Name/Label/Description/Fields. Schema-Änderungs-Policy v1: Felder **hinzufügen** immer erlaubt; Felder **entfernen** erlaubt (alte Werte bleiben im JSONB liegen und werden beim Lesen ignoriert); Feld-**Typänderung** in v1 ablehnen (400) — das vermeidet Migrationslogik; Umbenennen = entfernen + hinzufügen.
- `deleteCustomTable(tenantId, tableId)` — Rows fallen per FK-Cascade.

### `rows.ts` (Zeilen)

- `insertRow(tenantId, tableId, data)` — Tabelle laden (tenant-scoped), gegen Schema validieren, insert. Guard: max. 50.000 Rows pro Tabelle (Zählung vor Insert; grober Schutz, kein Race-Problem bei der Zielgröße).
- `insertRows(...)` — Bulk-Variante (Array, max. 500 pro Request), einzeln validieren, in einer Transaktion einfügen.
- `updateRow(tenantId, tableId, rowId, data)` — Partial-Update: eingehende Felder validieren, per JSONB-Merge (`data || $new`) oder read-modify-write in Transaktion.
- `deleteRow(tenantId, tableId, rowId)`
- `getRow(tenantId, tableId, rowId)`
- `queryRows(tenantId, tableId, options)` — siehe Query-Design unten.

### `query.ts` (Filter-/Sortier-Builder)

Baut aus geparsten Filtern Drizzle-`sql`-Fragmente. Typ-Cast pro Feld aus dem gespeicherten Schema ableiten:

- `text` → `data->>'feld'`
- `number` → `(data->>'feld')::numeric`
- `date` → `(data->>'feld')::timestamptz`

**Wichtig (Sicherheit):** Feldnamen aus dem Request niemals direkt in SQL interpolieren. Immer erst gegen die Felddefinitionen der Tabelle auflösen (whitelist); den Feldnamen dann als Parameter binden (`data->>${sql.param(field.name)}`) oder nur den validierten, regex-geprüften Namen verwenden. Werte immer als gebundene Parameter.

Unterstützte Operatoren v1: `eq`, `neq`, `gt`, `gte`, `lt`, `lte` (number/date), `contains` (text, ILIKE `%...%`), `startswith`, `isnull` / `notnull`. Mehrere Filter werden mit AND verknüpft. OR/Gruppierung ist bewusst **nicht** in v1.

## 5. API-Routen

Neue Datei: `src/routes/tenant/[tenantId]/tables/index.ts`, exportiert `defineCustomTableRoutes(app, API_BASE_PATH)` nach dem Muster von `src/routes/tenant/[tenantId]/webhooks/index.ts`:

- Middleware-Kette pro Route: `authAndSetUsersInfo`, `isTenantMember` (Import aus `../../index`), `describeRoute({ tags: ["custom-tables"], ... })` mit `resolver(...)`-Response-Schemas, `validateScope(...)`, `validator("param"/"json"/"query", ...)`.
- Scopes: `tables:read` für GETs, `tables:write` für Mutationen.
- Registrierung in `src/index.ts` neben den anderen `define*Routes`-Aufrufen (z. B. bei `defineWebhookRoutes`, Zeile ~268).

### Endpoints

| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/tenant/:tenantId/tables` | Tabelle anlegen (name, label?, description?, fields) |
| GET | `/tenant/:tenantId/tables` | Tabellen auflisten (Metadaten) |
| GET | `/tenant/:tenantId/tables/:tableId` | Tabelle inkl. Schema (= Schema-Abfrage-Use-Case) |
| PUT | `/tenant/:tenantId/tables/:tableId` | Tabelle/Schema ändern (Policy siehe §4) |
| DELETE | `/tenant/:tenantId/tables/:tableId` | Tabelle inkl. Rows löschen |
| POST | `/tenant/:tenantId/tables/:tableId/rows` | Zeile anlegen; Body als Objekt `{...}` oder Array `[{...}]` für Bulk |
| GET | `/tenant/:tenantId/tables/:tableId/rows` | Zeilen abfragen (Filter/Suche/Sort/Pagination) |
| GET | `/tenant/:tenantId/tables/:tableId/rows/:rowId` | Einzelne Zeile |
| PATCH | `/tenant/:tenantId/tables/:tableId/rows/:rowId` | Zeile partiell ändern |
| DELETE | `/tenant/:tenantId/tables/:tableId/rows/:rowId` | Zeile löschen |

### Query-Parameter für `GET .../rows`

- `page` (default 1), `limit` (default 50, max 500) → LIMIT/OFFSET
- `sort` = Feldname (whitelist gegen Schema) oder `createdAt`/`updatedAt`; `order` = `asc`|`desc` (default asc)
- `search` = Volltext-Kurzform: ILIKE `%term%` über alle `text`-Felder der Tabelle (OR-verknüpft)
- `filter` = wiederholbarer Parameter im Format `feld:op:wert`, z. B. `?filter=preis:gt:10&filter=name:contains:schraube`. Doppelpunkte im Wert sind erlaubt (nur an den ersten beiden Doppelpunkten splitten).

Response-Format der Liste:

```json
{
  "rows": [{ "id": "...", "data": { ... }, "createdAt": "...", "updatedAt": "..." }],
  "pagination": { "page": 1, "limit": 50, "total": 123 }
}
```

`total` über `count(*)` mit denselben Filtern.

## 6. Tests

Bun-Tests nach dem Muster von `src/routes/tenant/[tenantId]/jobs/index.test.ts` (Hono-App lokal, `defineCustomTableRoutes(app, "/api")`, `initTests()` aus `src/test/init.test`, `testFetcher`, Cleanup in `afterAll` über `getDb()`).

- `index.test.ts` — Happy Path: Tabelle anlegen → Schema abfragen → Rows anlegen (einzeln + bulk) → filtern (je Operator mind. ein Fall, inkl. number-`gt` und date-Vergleich) → `search` → Sortierung → Pagination (total, page 2) → Row patchen → Row löschen → Tabelle löschen (Rows weg).
- `validation.test.ts` — ungültige Felddefinitionen (doppelter Name, reservierter Name, ungültiger Typ, >100 Felder), Row-Validierung (falscher Typ, fehlendes required-Feld, unbekanntes Feld, ungültiges Datum) → jeweils 400. Typänderung eines Felds → 400.
- `security.test.ts` — Muster von `jobs/security.test.ts`: User aus fremdem Tenant bekommt auf alle Endpoints 403; Row-Zugriff über `tableId` eines fremden Tenants schlägt fehl; Filter-Feldnamen mit SQL-Sonderzeichen (`'`, `--`, `;`) führen zu 400, nicht zu SQL-Fehlern.

Alle Tests grün vor Abschluss: `bun test src/routes/tenant/\[tenantId\]/tables/`.

## 7. Arbeitsschritte in Reihenfolge

1. Schema-Datei `custom-tables.ts` anlegen, in `db-schema.ts` registrieren, `bun run framework:generate`, Migration prüfen (GIN-Index ggf. manuell ergänzen), `bun run framework:migrate`.
2. `src/lib/custom-tables/`: `validation.ts` → `crud.ts` → `query.ts` → `rows.ts` (mit Unit-Tests für validation + query-Builder).
3. Routen-Modul + Registrierung in `src/index.ts`.
4. Routen-Tests (index / validation / security) schreiben und grün laufen lassen.
5. Kein Frontend, kein CSV-Import in v1 (bewusst raus; `csv`-Dependency existiert für später).

## 8. Definition of Done

- Alle Endpoints aus §5 funktionieren und sind via `describeRoute` in der OpenAPI/Swagger-Doku sichtbar.
- Zeilen werden strikt gegen das Tabellen-Schema validiert (400 mit Feldbezug bei Fehlern).
- Alle Abfragen sind tenant-scoped; keine Route erlaubt Cross-Tenant-Zugriff.
- Filter-/Sortier-Eingaben können keine SQL-Injection auslösen (Whitelisting + gebundene Parameter, durch Security-Tests abgedeckt).
- `bun test` für die neuen Testdateien grün; bestehende Tests nicht gebrochen.
