import type { ColumnInfo, IndexInfo } from "../types";
import type { SchemaComparison, SchemaSnapshot } from "./schema-diff";

function escapeId(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function columnDefinition(col: ColumnInfo): string {
  let def = `${escapeId(col.name)} ${col.column_type}`;
  def += col.nullable ? " NULL" : " NOT NULL";
  if (col.default_value !== undefined && col.default_value !== null) {
    const needsQuotes = !["CURRENT_TIMESTAMP", "NULL"].includes(col.default_value.toUpperCase())
      && !/^\d+(\.\d+)?$/.test(col.default_value);
    def += ` DEFAULT ${needsQuotes ? `'${col.default_value}'` : col.default_value}`;
  }
  if (col.extra) {
    def += ` ${col.extra}`;
  }
  if (col.comment) {
    def += ` COMMENT '${col.comment.replace(/'/g, "''")}'`;
  }
  return def;
}

function indexDefinition(idx: IndexInfo): string {
  const cols = idx.columns.map(escapeId).join(", ");
  if (idx.name === "PRIMARY") {
    return `ADD PRIMARY KEY (${cols})`;
  }
  const unique = idx.is_unique ? "UNIQUE " : "";
  const using = idx.index_type && idx.index_type !== "BTREE" ? ` USING ${idx.index_type}` : "";
  return `ADD ${unique}INDEX ${escapeId(idx.name)} (${cols})${using}`;
}

export interface SyncStatement {
  sql: string;
  type: "create" | "alter" | "drop";
  objectType: string;
  objectName: string;
  destructive: boolean;
}

export function generateSyncSQL(
  comparison: SchemaComparison,
  sourceSchema: SchemaSnapshot,
): SyncStatement[] {
  const statements: SyncStatement[] = [];
  const sourceTableMap = new Map(sourceSchema.tables.map((t) => [t.name, t]));

  // CREATE TABLE for tables only in source
  for (const tableName of comparison.tables.onlyInSource) {
    const table = sourceTableMap.get(tableName);
    if (!table) continue;

    const colDefs = table.columns.map(columnDefinition);
    const pkCols = table.columns.filter((c) => c.is_primary_key);
    if (pkCols.length > 0) {
      colDefs.push(`PRIMARY KEY (${pkCols.map((c) => escapeId(c.name)).join(", ")})`);
    }
    for (const idx of table.indexes) {
      if (idx.name === "PRIMARY") continue;
      const cols = idx.columns.map(escapeId).join(", ");
      const unique = idx.is_unique ? "UNIQUE " : "";
      const using = idx.index_type && idx.index_type !== "BTREE" ? ` USING ${idx.index_type}` : "";
      colDefs.push(`${unique}INDEX ${escapeId(idx.name)} (${cols})${using}`);
    }

    const sql = `CREATE TABLE ${escapeId(tableName)} (\n  ${colDefs.join(",\n  ")}\n);`;
    statements.push({
      sql,
      type: "create",
      objectType: "TABLE",
      objectName: tableName,
      destructive: false,
    });
  }

  // ALTER TABLE for different tables
  for (const diff of comparison.tables.different) {
    const alterParts: string[] = [];

    for (const col of diff.columns.added) {
      alterParts.push(`ADD COLUMN ${columnDefinition(col)}`);
    }
    for (const mod of diff.columns.modified) {
      alterParts.push(`MODIFY COLUMN ${columnDefinition(mod.sourceColumn)}`);
    }
    for (const col of diff.columns.removed) {
      alterParts.push(`DROP COLUMN ${escapeId(col.name)}`);
    }
    for (const idx of diff.indexes.removed) {
      if (idx.name === "PRIMARY") {
        alterParts.push("DROP PRIMARY KEY");
      } else {
        alterParts.push(`DROP INDEX ${escapeId(idx.name)}`);
      }
    }
    for (const idx of diff.indexes.added) {
      alterParts.push(indexDefinition(idx));
    }

    if (alterParts.length > 0) {
      const sql = `ALTER TABLE ${escapeId(diff.name)}\n  ${alterParts.join(",\n  ")};`;
      const hasDestructive = diff.columns.removed.length > 0;
      statements.push({
        sql: hasDestructive ? `-- WARNING: destructive — drops column(s)\n${sql}` : sql,
        type: "alter",
        objectType: "TABLE",
        objectName: diff.name,
        destructive: hasDestructive,
      });
    }
  }

  // DROP TABLE for tables only in target
  for (const tableName of comparison.tables.onlyInTarget) {
    statements.push({
      sql: `-- WARNING: destructive\nDROP TABLE ${escapeId(tableName)};`,
      type: "drop",
      objectType: "TABLE",
      objectName: tableName,
      destructive: true,
    });
  }

  // Views
  const sourceViewMap = new Map(sourceSchema.views.map((v) => [v.info.name, v]));
  for (const view of comparison.views.onlyInSource) {
    const src = sourceViewMap.get(view.name);
    if (src) {
      statements.push({
        sql: src.ddl.endsWith(";") ? src.ddl : `${src.ddl};`,
        type: "create",
        objectType: "VIEW",
        objectName: view.name,
        destructive: false,
      });
    }
  }
  for (const viewName of comparison.views.different) {
    const src = sourceViewMap.get(viewName);
    if (src) {
      const ddl = src.ddl.replace(/^CREATE\s/i, "CREATE OR REPLACE ");
      statements.push({
        sql: ddl.endsWith(";") ? ddl : `${ddl};`,
        type: "alter",
        objectType: "VIEW",
        objectName: viewName,
        destructive: false,
      });
    }
  }
  for (const view of comparison.views.onlyInTarget) {
    statements.push({
      sql: `-- WARNING: destructive\nDROP VIEW ${escapeId(view.name)};`,
      type: "drop",
      objectType: "VIEW",
      objectName: view.name,
      destructive: true,
    });
  }

  // Routines
  const sourceRoutineMap = new Map(sourceSchema.routines.map((r) => [r.info.name, r]));
  for (const routine of comparison.routines.onlyInSource) {
    const src = sourceRoutineMap.get(routine.name);
    if (src) {
      statements.push({
        sql: src.ddl.endsWith(";") ? src.ddl : `${src.ddl};`,
        type: "create",
        objectType: routine.routine_type.toUpperCase(),
        objectName: routine.name,
        destructive: false,
      });
    }
  }
  for (const routineName of comparison.routines.different) {
    const src = sourceRoutineMap.get(routineName);
    if (src) {
      const dropType = src.info.routine_type.toUpperCase();
      statements.push({
        sql: `DROP ${dropType} IF EXISTS ${escapeId(routineName)};\n${src.ddl.endsWith(";") ? src.ddl : `${src.ddl};`}`,
        type: "alter",
        objectType: dropType,
        objectName: routineName,
        destructive: false,
      });
    }
  }
  for (const routine of comparison.routines.onlyInTarget) {
    statements.push({
      sql: `-- WARNING: destructive\nDROP ${routine.routine_type.toUpperCase()} ${escapeId(routine.name)};`,
      type: "drop",
      objectType: routine.routine_type.toUpperCase(),
      objectName: routine.name,
      destructive: true,
    });
  }

  // Triggers
  const sourceTriggerMap = new Map(sourceSchema.triggers.map((t) => [t.info.name, t]));
  for (const trigger of comparison.triggers.onlyInSource) {
    const src = sourceTriggerMap.get(trigger.name);
    if (src) {
      statements.push({
        sql: src.ddl.endsWith(";") ? src.ddl : `${src.ddl};`,
        type: "create",
        objectType: "TRIGGER",
        objectName: trigger.name,
        destructive: false,
      });
    }
  }
  for (const triggerName of comparison.triggers.different) {
    const src = sourceTriggerMap.get(triggerName);
    if (src) {
      statements.push({
        sql: `DROP TRIGGER IF EXISTS ${escapeId(triggerName)};\n${src.ddl.endsWith(";") ? src.ddl : `${src.ddl};`}`,
        type: "alter",
        objectType: "TRIGGER",
        objectName: triggerName,
        destructive: false,
      });
    }
  }
  for (const trigger of comparison.triggers.onlyInTarget) {
    statements.push({
      sql: `-- WARNING: destructive\nDROP TRIGGER ${escapeId(trigger.name)};`,
      type: "drop",
      objectType: "TRIGGER",
      objectName: trigger.name,
      destructive: true,
    });
  }

  return statements;
}
