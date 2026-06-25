// DDL generator for CREATE TABLE and ALTER TABLE statements

export interface DesignerColumn {
  id: string;
  name: string;
  type: string;
  length: string;
  nullable: boolean;
  defaultValue: string;
  autoIncrement: boolean;
  comment: string;
}

export interface DesignerIndex {
  id: string;
  name: string;
  type: "PRIMARY KEY" | "UNIQUE" | "INDEX" | "FULLTEXT";
  columns: string[];
}

export interface DesignerForeignKey {
  id: string;
  name: string;
  columns: string[];
  referenceTable: string;
  referenceColumns: string[];
  onDelete: "RESTRICT" | "CASCADE" | "SET NULL" | "NO ACTION";
  onUpdate: "RESTRICT" | "CASCADE" | "SET NULL" | "NO ACTION";
}

export interface TableOptions {
  engine: string;
  charset: string;
  collation: string;
  autoIncrementStart: string;
  comment: string;
}

export interface TableDesignerConfig {
  tableName: string;
  database: string;
  columns: DesignerColumn[];
  indexes: DesignerIndex[];
  foreignKeys: DesignerForeignKey[];
  options: TableOptions;
}

const TYPES_WITH_LENGTH = new Set([
  "VARCHAR",
  "CHAR",
  "DECIMAL",
  "FLOAT",
  "DOUBLE",
  "INT",
  "BIGINT",
  "TINYINT",
  "SMALLINT",
  "MEDIUMINT",
  "BINARY",
  "VARBINARY",
  "ENUM",
  "SET",
]);

function escId(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function buildColumnType(col: DesignerColumn): string {
  const upper = col.type.toUpperCase();
  if (col.length && TYPES_WITH_LENGTH.has(upper)) {
    if (upper === "ENUM" || upper === "SET") {
      return `${upper}(${col.length})`;
    }
    return `${upper}(${col.length})`;
  }
  return upper;
}

function buildColumnDef(col: DesignerColumn): string {
  const parts: string[] = [escId(col.name), buildColumnType(col)];

  if (!col.nullable) {
    parts.push("NOT NULL");
  } else {
    parts.push("NULL");
  }

  if (col.autoIncrement) {
    parts.push("AUTO_INCREMENT");
  } else if (col.defaultValue !== "") {
    const upper = col.defaultValue.toUpperCase();
    if (
      upper === "NULL"
      || upper === "CURRENT_TIMESTAMP"
      || upper === "CURRENT_TIMESTAMP()"
      || upper.startsWith("CURRENT_TIMESTAMP ON")
    ) {
      parts.push(`DEFAULT ${col.defaultValue}`);
    } else {
      parts.push(`DEFAULT '${col.defaultValue.replace(/'/g, "''")}'`);
    }
  }

  if (col.comment) {
    parts.push(`COMMENT '${col.comment.replace(/'/g, "''")}'`);
  }

  return parts.join(" ");
}

function buildIndexDef(idx: DesignerIndex): string {
  const cols = idx.columns.map(escId).join(", ");
  if (idx.type === "PRIMARY KEY") {
    return `PRIMARY KEY (${cols})`;
  }
  const keyword = idx.type === "UNIQUE" ? "UNIQUE INDEX" : idx.type;
  return `${keyword} ${escId(idx.name)} (${cols})`;
}

function buildForeignKeyDef(fk: DesignerForeignKey): string {
  const cols = fk.columns.map(escId).join(", ");
  const refCols = fk.referenceColumns.map(escId).join(", ");
  return (
    `CONSTRAINT ${escId(fk.name)} FOREIGN KEY (${cols}) `
    + `REFERENCES ${escId(fk.referenceTable)} (${refCols}) `
    + `ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`
  );
}

function buildTableOptions(opts: TableOptions): string {
  const parts: string[] = [];
  if (opts.engine) parts.push(`ENGINE = ${opts.engine}`);
  if (opts.charset) parts.push(`DEFAULT CHARSET = ${opts.charset}`);
  if (opts.collation) parts.push(`COLLATE = ${opts.collation}`);
  if (opts.autoIncrementStart && opts.autoIncrementStart !== "1") {
    parts.push(`AUTO_INCREMENT = ${opts.autoIncrementStart}`);
  }
  if (opts.comment) {
    parts.push(`COMMENT = '${opts.comment.replace(/'/g, "''")}'`);
  }
  return parts.join("\n");
}

export function generateCreateTable(config: TableDesignerConfig): string {
  const { tableName, columns, indexes, foreignKeys, options } = config;

  if (!tableName || columns.length === 0) {
    return "-- Please add a table name and at least one column";
  }

  const defs: string[] = [];

  for (const col of columns) {
    if (col.name) {
      defs.push(`  ${buildColumnDef(col)}`);
    }
  }

  for (const idx of indexes) {
    if (idx.columns.length > 0) {
      defs.push(`  ${buildIndexDef(idx)}`);
    }
  }

  for (const fk of foreignKeys) {
    if (fk.columns.length > 0 && fk.referenceTable && fk.referenceColumns.length > 0) {
      defs.push(`  ${buildForeignKeyDef(fk)}`);
    }
  }

  const opts = buildTableOptions(options);
  const optLine = opts ? `\n${opts}` : "";

  return `CREATE TABLE ${escId(tableName)} (\n${defs.join(",\n")}\n)${optLine};`;
}

export function generateAlterTable(
  tableName: string,
  original: TableDesignerConfig,
  modified: TableDesignerConfig,
): string {
  const stmts: string[] = [];
  const tn = escId(tableName);

  // Renamed table
  if (modified.tableName !== original.tableName && modified.tableName) {
    stmts.push(`ALTER TABLE ${tn} RENAME TO ${escId(modified.tableName)};`);
  }

  // Dropped columns
  const origColNames = new Set(original.columns.map((c) => c.id));
  const modColMap = new Map(modified.columns.map((c) => [c.id, c]));
  const origColMap = new Map(original.columns.map((c) => [c.id, c]));

  for (const origCol of original.columns) {
    if (!modColMap.has(origCol.id)) {
      stmts.push(`ALTER TABLE ${tn} DROP COLUMN ${escId(origCol.name)};`);
    }
  }

  // Added/modified columns
  let prevCol: string | null = null;
  for (const modCol of modified.columns) {
    if (!modCol.name) continue;

    if (!origColNames.has(modCol.id)) {
      const pos = prevCol ? ` AFTER ${escId(prevCol)}` : " FIRST";
      stmts.push(`ALTER TABLE ${tn} ADD COLUMN ${buildColumnDef(modCol)}${pos};`);
    } else {
      const origCol = origColMap.get(modCol.id);
      if (origCol && isColumnChanged(origCol, modCol)) {
        const nameChanged = origCol.name !== modCol.name;
        const keyword = nameChanged ? "CHANGE COLUMN" : "MODIFY COLUMN";
        const oldName = nameChanged ? `${escId(origCol.name)} ` : "";
        stmts.push(
          `ALTER TABLE ${tn} ${keyword} ${oldName}${buildColumnDef(modCol)};`,
        );
      }
    }
    prevCol = modCol.name;
  }

  // Dropped indexes
  const origIdxIds = new Set(original.indexes.map((i) => i.id));
  const modIdxMap = new Map(modified.indexes.map((i) => [i.id, i]));
  const origIdxMap = new Map(original.indexes.map((i) => [i.id, i]));

  for (const origIdx of original.indexes) {
    if (!modIdxMap.has(origIdx.id)) {
      if (origIdx.type === "PRIMARY KEY") {
        stmts.push(`ALTER TABLE ${tn} DROP PRIMARY KEY;`);
      } else {
        stmts.push(`ALTER TABLE ${tn} DROP INDEX ${escId(origIdx.name)};`);
      }
    }
  }

  // Added/modified indexes
  for (const modIdx of modified.indexes) {
    if (modIdx.columns.length === 0) continue;

    if (!origIdxIds.has(modIdx.id)) {
      if (modIdx.type === "PRIMARY KEY") {
        stmts.push(`ALTER TABLE ${tn} ADD PRIMARY KEY (${modIdx.columns.map(escId).join(", ")});`);
      } else {
        stmts.push(`ALTER TABLE ${tn} ADD ${buildIndexDef(modIdx)};`);
      }
    } else {
      const origIdx = origIdxMap.get(modIdx.id);
      if (origIdx && isIndexChanged(origIdx, modIdx)) {
        if (origIdx.type === "PRIMARY KEY") {
          stmts.push(`ALTER TABLE ${tn} DROP PRIMARY KEY;`);
        } else {
          stmts.push(`ALTER TABLE ${tn} DROP INDEX ${escId(origIdx.name)};`);
        }
        if (modIdx.type === "PRIMARY KEY") {
          stmts.push(`ALTER TABLE ${tn} ADD PRIMARY KEY (${modIdx.columns.map(escId).join(", ")});`);
        } else {
          stmts.push(`ALTER TABLE ${tn} ADD ${buildIndexDef(modIdx)};`);
        }
      }
    }
  }

  // Dropped FKs
  const origFkIds = new Set(original.foreignKeys.map((f) => f.id));
  const modFkMap = new Map(modified.foreignKeys.map((f) => [f.id, f]));
  const origFkMap = new Map(original.foreignKeys.map((f) => [f.id, f]));

  for (const origFk of original.foreignKeys) {
    if (!modFkMap.has(origFk.id)) {
      stmts.push(`ALTER TABLE ${tn} DROP FOREIGN KEY ${escId(origFk.name)};`);
    }
  }

  // Added/modified FKs
  for (const modFk of modified.foreignKeys) {
    if (modFk.columns.length === 0 || !modFk.referenceTable) continue;

    if (!origFkIds.has(modFk.id)) {
      stmts.push(`ALTER TABLE ${tn} ADD ${buildForeignKeyDef(modFk)};`);
    } else {
      const origFk = origFkMap.get(modFk.id);
      if (origFk && isFkChanged(origFk, modFk)) {
        stmts.push(`ALTER TABLE ${tn} DROP FOREIGN KEY ${escId(origFk.name)};`);
        stmts.push(`ALTER TABLE ${tn} ADD ${buildForeignKeyDef(modFk)};`);
      }
    }
  }

  // Table options
  const optChanges: string[] = [];
  if (modified.options.engine !== original.options.engine && modified.options.engine) {
    optChanges.push(`ENGINE = ${modified.options.engine}`);
  }
  if (modified.options.charset !== original.options.charset && modified.options.charset) {
    optChanges.push(`DEFAULT CHARSET = ${modified.options.charset}`);
  }
  if (modified.options.collation !== original.options.collation && modified.options.collation) {
    optChanges.push(`COLLATE = ${modified.options.collation}`);
  }
  if (modified.options.comment !== original.options.comment) {
    optChanges.push(`COMMENT = '${modified.options.comment.replace(/'/g, "''")}'`);
  }
  if (optChanges.length > 0) {
    stmts.push(`ALTER TABLE ${tn} ${optChanges.join(", ")};`);
  }

  return stmts.length > 0
    ? stmts.join("\n\n")
    : "-- No changes detected";
}

function isColumnChanged(a: DesignerColumn, b: DesignerColumn): boolean {
  return (
    a.name !== b.name
    || a.type !== b.type
    || a.length !== b.length
    || a.nullable !== b.nullable
    || a.defaultValue !== b.defaultValue
    || a.autoIncrement !== b.autoIncrement
    || a.comment !== b.comment
  );
}

function isIndexChanged(a: DesignerIndex, b: DesignerIndex): boolean {
  return (
    a.name !== b.name
    || a.type !== b.type
    || a.columns.join(",") !== b.columns.join(",")
  );
}

function isFkChanged(a: DesignerForeignKey, b: DesignerForeignKey): boolean {
  return (
    a.name !== b.name
    || a.columns.join(",") !== b.columns.join(",")
    || a.referenceTable !== b.referenceTable
    || a.referenceColumns.join(",") !== b.referenceColumns.join(",")
    || a.onDelete !== b.onDelete
    || a.onUpdate !== b.onUpdate
  );
}
