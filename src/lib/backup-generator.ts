import { api } from "./tauri-api";
import type { SqlValue } from "../types";

export interface BackupOptions {
  includeStructure: boolean;
  includeData: boolean;
  dropTableIfExists: boolean;
  includeCreateDatabase: boolean;
  addTableLocks: boolean;
  includeAutoIncrement: boolean;
  includeViews: boolean;
  includeRoutines: boolean;
  includeTriggers: boolean;
  multiRowInserts: boolean;
  insertBatchSize: number;
}

export interface BackupProgress {
  phase: string;
  currentTable: number;
  totalTables: number;
  tableName: string;
  rowsExported: number;
  cancelled: boolean;
}

export const defaultBackupOptions: BackupOptions = {
  includeStructure: true,
  includeData: true,
  dropTableIfExists: true,
  includeCreateDatabase: false,
  addTableLocks: false,
  includeAutoIncrement: true,
  includeViews: true,
  includeRoutines: true,
  includeTriggers: true,
  multiRowInserts: true,
  insertBatchSize: 100,
};

function escapeValue(val: SqlValue): string {
  if (val === null) return "NULL";
  if (typeof val === "number") return String(val);
  if (typeof val === "boolean") return val ? "1" : "0";
  if (Array.isArray(val)) {
    // Binary data as hex
    const hex = val.map((b) => b.toString(16).padStart(2, "0")).join("");
    return `X'${hex}'`;
  }
  return (
    "'" +
    String(val)
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\0/g, "\\0")
      .replace(/\x1a/g, "\\Z") +
    "'"
  );
}

function escapeIdentifier(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

export async function generateBackup(
  connectionId: string,
  database: string,
  tableNames: string[],
  options: BackupOptions,
  onProgress: (progress: BackupProgress) => void,
  cancelRef: { current: boolean },
): Promise<string> {
  const parts: string[] = [];
  const now = new Date().toISOString();

  // Header
  parts.push("-- MySQL AI Studio Database Backup");
  parts.push(`-- Generated: ${now}`);
  parts.push(`-- Database: ${database}`);
  parts.push("");
  parts.push("/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;");
  parts.push("/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;");
  parts.push("/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;");
  parts.push("/*!40101 SET NAMES utf8mb4 */;");
  parts.push("/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;");
  parts.push("/*!40103 SET TIME_ZONE='+00:00' */;");
  parts.push("/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;");
  parts.push("/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;");
  parts.push("/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;");
  parts.push("/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;");
  parts.push("");

  if (options.includeCreateDatabase) {
    parts.push(`CREATE DATABASE IF NOT EXISTS ${escapeIdentifier(database)};`);
    parts.push(`USE ${escapeIdentifier(database)};`);
    parts.push("");
  }

  const totalItems = tableNames.length;

  // Tables
  for (let i = 0; i < tableNames.length; i++) {
    if (cancelRef.current) break;

    const tableName = tableNames[i];
    onProgress({
      phase: "Backing up tables",
      currentTable: i + 1,
      totalTables: totalItems,
      tableName,
      rowsExported: 0,
      cancelled: false,
    });

    parts.push(`--`);
    parts.push(`-- Table: ${escapeIdentifier(tableName)}`);
    parts.push(`--`);
    parts.push("");

    if (options.includeStructure) {
      if (options.dropTableIfExists) {
        parts.push(`DROP TABLE IF EXISTS ${escapeIdentifier(tableName)};`);
      }

      let ddl = await api.getTableDdl(connectionId, database, tableName);
      if (!options.includeAutoIncrement) {
        ddl = ddl.replace(/\s*AUTO_INCREMENT=\d+/gi, "");
      }
      parts.push(ddl + ";");
      parts.push("");
    }

    if (options.includeData) {
      if (options.addTableLocks) {
        parts.push(`LOCK TABLES ${escapeIdentifier(tableName)} WRITE;`);
      }

      let offset = 0;
      const batchFetch = 10000;
      let rowsExported = 0;
      let columnNames: string[] = [];

      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (cancelRef.current) break;

        const sql = `SELECT * FROM ${escapeIdentifier(database)}.${escapeIdentifier(tableName)} LIMIT ${batchFetch} OFFSET ${offset}`;
        const results = await api.executeQuery(connectionId, sql);
        const result = results[0];
        if (!result || result.rows.length === 0) break;

        if (columnNames.length === 0) {
          columnNames = result.columns.map((c) => c.name);
        }

        const escapedTable = escapeIdentifier(tableName);
        const escapedCols = columnNames.map(escapeIdentifier).join(", ");

        if (options.multiRowInserts) {
          for (let j = 0; j < result.rows.length; j += options.insertBatchSize) {
            if (cancelRef.current) break;
            const batch = result.rows.slice(j, j + options.insertBatchSize);
            const valueRows = batch.map(
              (row) => "(" + row.map(escapeValue).join(", ") + ")",
            );
            parts.push(
              `INSERT INTO ${escapedTable} (${escapedCols}) VALUES\n${valueRows.join(",\n")};`,
            );
            rowsExported += batch.length;
          }
        } else {
          for (const row of result.rows) {
            if (cancelRef.current) break;
            const values = row.map(escapeValue).join(", ");
            parts.push(
              `INSERT INTO ${escapedTable} (${escapedCols}) VALUES (${values});`,
            );
            rowsExported++;
          }
        }

        onProgress({
          phase: "Backing up tables",
          currentTable: i + 1,
          totalTables: totalItems,
          tableName,
          rowsExported,
          cancelled: false,
        });

        if (result.rows.length < batchFetch) break;
        offset += batchFetch;
      }

      if (options.addTableLocks) {
        parts.push("UNLOCK TABLES;");
      }
      parts.push("");
    }
  }

  // Views
  if (options.includeViews && !cancelRef.current) {
    const views = await api.getViews(connectionId, database);
    if (views.length > 0) {
      parts.push("--");
      parts.push("-- Views");
      parts.push("--");
      parts.push("");

      for (const view of views) {
        if (cancelRef.current) break;
        onProgress({
          phase: "Backing up views",
          currentTable: 0,
          totalTables: 0,
          tableName: view.name,
          rowsExported: 0,
          cancelled: false,
        });

        try {
          const ddl = await api.getViewDdl(connectionId, database, view.name);
          if (options.dropTableIfExists) {
            parts.push(`DROP VIEW IF EXISTS ${escapeIdentifier(view.name)};`);
          }
          parts.push(ddl + ";");
          parts.push("");
        } catch (e) {
          parts.push(`-- Error getting view ${view.name}: ${e}`);
          parts.push("");
        }
      }
    }
  }

  // Routines (procedures and functions)
  if (options.includeRoutines && !cancelRef.current) {
    const routines = await api.getRoutines(connectionId, database);
    if (routines.length > 0) {
      parts.push("--");
      parts.push("-- Routines");
      parts.push("--");
      parts.push("");

      for (const routine of routines) {
        if (cancelRef.current) break;
        onProgress({
          phase: "Backing up routines",
          currentTable: 0,
          totalTables: 0,
          tableName: routine.name,
          rowsExported: 0,
          cancelled: false,
        });

        try {
          const ddl = await api.getRoutineDdl(
            connectionId,
            database,
            routine.name,
            routine.routine_type,
          );
          const typeLabel = routine.routine_type === "PROCEDURE" ? "PROCEDURE" : "FUNCTION";
          parts.push(`DROP ${typeLabel} IF EXISTS ${escapeIdentifier(routine.name)};`);
          parts.push("DELIMITER ;;");
          parts.push(ddl + " ;;");
          parts.push("DELIMITER ;");
          parts.push("");
        } catch (e) {
          parts.push(`-- Error getting routine ${routine.name}: ${e}`);
          parts.push("");
        }
      }
    }
  }

  // Triggers
  if (options.includeTriggers && !cancelRef.current) {
    const triggers = await api.getTriggers(connectionId, database);
    if (triggers.length > 0) {
      parts.push("--");
      parts.push("-- Triggers");
      parts.push("--");
      parts.push("");

      for (const trigger of triggers) {
        if (cancelRef.current) break;
        onProgress({
          phase: "Backing up triggers",
          currentTable: 0,
          totalTables: 0,
          tableName: trigger.name,
          rowsExported: 0,
          cancelled: false,
        });

        try {
          const ddl = await api.getTriggerDdl(connectionId, database, trigger.name);
          parts.push(`DROP TRIGGER IF EXISTS ${escapeIdentifier(trigger.name)};`);
          parts.push("DELIMITER ;;");
          parts.push(ddl + " ;;");
          parts.push("DELIMITER ;");
          parts.push("");
        } catch (e) {
          parts.push(`-- Error getting trigger ${trigger.name}: ${e}`);
          parts.push("");
        }
      }
    }
  }

  // Footer
  parts.push("/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;");
  parts.push("/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;");
  parts.push("/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;");
  parts.push("/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;");
  parts.push("/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;");
  parts.push("/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;");
  parts.push("/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;");
  parts.push("/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;");
  parts.push("");
  parts.push(`-- Backup completed: ${new Date().toISOString()}`);
  parts.push("");

  return parts.join("\n");
}
