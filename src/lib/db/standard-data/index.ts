import log from "../../../lib/log";
import { getDb } from "../db-connection";
import { getDbSchemaTable, normalizeTableName } from "../db-get-schema";
import type { DBStandardData } from "./../../../types";

export const insertStandardDataEntry = async (
  data: DBStandardData[],
  forceOverwrite = false,
  forceDelete = false
) => {
  console.log("Inserting standard data. Overwrite: ", forceOverwrite);
  const db = getDb();
  const insertedIds: { [key: string]: any } = {};

  let clearedTables: Record<string, boolean> = {};

  for (let tableCount = 0; tableCount < data.length; tableCount++) {
    const tableData = data[tableCount];
    const tableName = normalizeTableName(tableData.schemaName);
    const table = getDbSchemaTable(tableName) as any;

    if (forceDelete && !clearedTables[tableName]) {
      await db.delete(table);
      clearedTables[tableName] = true;
    }

    for (let rowCount = 0; rowCount < tableData.entries.length; rowCount++) {
      const entry = tableData.entries[rowCount];

      // Replace placeholders in string fields
      for (const key in entry) {
        if (typeof entry[key] === "string") {
          entry[key] = entry[key].replace(
            /{{(\$\d+\.\d+)}}/g,
            (match: string, placeholder: string) => {
              const [tableIndex, rowIndex] = placeholder
                .slice(1)
                .split(".")
                .map(Number);
              return insertedIds[`${tableIndex}.${rowIndex}`] || match;
            }
          );
        }
      }

      try {
        let result;
        if (!forceOverwrite) {
          result = await db
            .insert(table)
            .values(entry)
            .onConflictDoNothing()
            .returning();
        } else {
          // HACK: I cannot UPDATE since I don´t know the table keys here that must be matched
          result = await db
            .insert(table)
            .values(entry)
            .onConflictDoNothing()
            .returning();
        }

        if (result && Array.isArray(result) && result[0]) {
          const insertedId = result[0].id;
          insertedIds[`${tableCount + 1}.${rowCount + 1}`] = insertedId;
          console.log(
            `Inserted standard data into ${tableData.schemaName}: ${insertedId}`
          );
        } else {
          console.log(
            `Skipping standard data insertion into ${tableData.schemaName}`
          );
        }
      } catch (error) {
        log.error(
          `Error inserting standard data into ${tableData.schemaName}: ${error}`
        );
      }
    }
  }

  return insertedIds;
};
