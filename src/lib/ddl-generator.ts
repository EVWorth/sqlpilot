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
  // Modifiers the designer does not offer controls for, carried so that
  // editing a column's name or comment does not quietly rewrite the rest of
  // its definition (#377). Absent on a column being created from scratch.
  unsigned?: boolean;
  zerofill?: boolean;
  /** Only when the column overrides the table's character set. */
  charset?: string;
  collation?: string;
  /** e.g. `CURRENT_TIMESTAMP`, from EXTRA rather than from the type. */
  onUpdate?: string;
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
  // BIT(n) is a width, and losing it makes BIT(8) into BIT(1) (#382).
  "BIT",
  "YEAR",
]);

/** Types MySQL will accept AUTO_INCREMENT on. */
const AUTO_INCREMENT_TYPES = new Set([
  "INT",
  "INTEGER",
  "BIGINT",
  "TINYINT",
  "SMALLINT",
  "MEDIUMINT",
  "SERIAL",
]);

/**
 * Whether AUTO_INCREMENT is legal on this type.
 *
 * The UI disables the checkbox where it is not, but a disabled control is a
 * convention rather than a lock — and a column that already carried the flag
 * before its type was changed would otherwise keep it. MySQL answers
 * `VARCHAR(255) AUTO_INCREMENT` with ERROR 1063 (#383).
 */
export function canAutoIncrement(type: string): boolean {
  return AUTO_INCREMENT_TYPES.has(type.trim().toUpperCase());
}

function escId(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function buildColumnType(col: DesignerColumn): string {
  const upper = col.type.toUpperCase();
  // UNSIGNED and ZEROFILL are part of the type, not separate clauses, and
  // must come straight after it. ZEROFILL implies UNSIGNED, so MySQL reports
  // both; emitting both back is what it accepts.
  const numericAttrs = [
    col.unsigned ? " UNSIGNED" : "",
    col.zerofill ? " ZEROFILL" : "",
  ].join("");
  if (col.length && TYPES_WITH_LENGTH.has(upper)) {
    return `${upper}(${col.length})${numericAttrs}`;
  }
  return `${upper}${numericAttrs}`;
}

function buildColumnDef(col: DesignerColumn): string {
  const parts: string[] = [escId(col.name), buildColumnType(col)];

  // Between the type and NOT NULL, which is where MySQL wants them.
  if (col.charset) parts.push(`CHARACTER SET ${col.charset}`);
  if (col.collation) parts.push(`COLLATE ${col.collation}`);

  if (!col.nullable) {
    parts.push("NOT NULL");
  } else {
    parts.push("NULL");
  }

  if (col.autoIncrement && canAutoIncrement(col.type)) {
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

  // After DEFAULT, before COMMENT.
  if (col.onUpdate) {
    parts.push(`ON UPDATE ${col.onUpdate}`);
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

/**
 * One ALTER TABLE carrying every change, rather than one per change.
 *
 * Emitting a statement each meant a run could stop halfway. Adding five
 * columns where the third collides with an existing name left the first two
 * added and the rest not, with the table in a state the user never asked
 * for. Confirmed on MySQL 8 and MariaDB 11: separate statements leave
 * `id,dup,ok1`, the combined form leaves `id,dup` — untouched.
 *
 * A transaction cannot help here. DDL commits implicitly, verified on the
 * same servers: START TRANSACTION, ALTER TABLE ADD COLUMN, ROLLBACK leaves
 * the column in place. Putting the clauses in one statement is what actually
 * makes the change all-or-nothing (#379).
 */
export function generateAlterTable(
  tableName: string,
  original: TableDesignerConfig,
  modified: TableDesignerConfig,
): string {
  // Each entry is one clause of the single statement built at the end.
  const clauses: string[] = [];
  const tn = escId(tableName);

  // Renamed table
  if (modified.tableName !== original.tableName && modified.tableName) {
    clauses.push(`RENAME TO ${escId(modified.tableName)}`);
  }

  // Dropped columns
  const origColNames = new Set(original.columns.map((c) => c.id));
  const modColMap = new Map(modified.columns.map((c) => [c.id, c]));
  const origColMap = new Map(original.columns.map((c) => [c.id, c]));

  for (const origCol of original.columns) {
    if (!modColMap.has(origCol.id)) {
      clauses.push(`DROP COLUMN ${escId(origCol.name)}`);
    }
  }

  // Added/modified columns
  let prevCol: string | null = null;
  for (const modCol of modified.columns) {
    if (!modCol.name) continue;

    if (!origColNames.has(modCol.id)) {
      const pos = prevCol ? ` AFTER ${escId(prevCol)}` : " FIRST";
      clauses.push(`ADD COLUMN ${buildColumnDef(modCol)}${pos}`);
    } else {
      const origCol = origColMap.get(modCol.id);
      if (origCol && isColumnChanged(origCol, modCol)) {
        const nameChanged = origCol.name !== modCol.name;
        const keyword = nameChanged ? "CHANGE COLUMN" : "MODIFY COLUMN";
        const oldName = nameChanged ? `${escId(origCol.name)} ` : "";
        clauses.push(`${keyword} ${oldName}${buildColumnDef(modCol)}`);
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
        clauses.push("DROP PRIMARY KEY");
      } else {
        clauses.push(`DROP INDEX ${escId(origIdx.name)}`);
      }
    }
  }

  // Added/modified indexes
  for (const modIdx of modified.indexes) {
    if (modIdx.columns.length === 0) continue;

    if (!origIdxIds.has(modIdx.id)) {
      if (modIdx.type === "PRIMARY KEY") {
        clauses.push(`ADD PRIMARY KEY (${modIdx.columns.map(escId).join(", ")})`);
      } else {
        clauses.push(`ADD ${buildIndexDef(modIdx)}`);
      }
    } else {
      const origIdx = origIdxMap.get(modIdx.id);
      if (origIdx && isIndexChanged(origIdx, modIdx)) {
        if (origIdx.type === "PRIMARY KEY") {
          clauses.push("DROP PRIMARY KEY");
        } else {
          clauses.push(`DROP INDEX ${escId(origIdx.name)}`);
        }
        if (modIdx.type === "PRIMARY KEY") {
          clauses.push(`ADD PRIMARY KEY (${modIdx.columns.map(escId).join(", ")})`);
        } else {
          clauses.push(`ADD ${buildIndexDef(modIdx)}`);
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
      clauses.push(`DROP FOREIGN KEY ${escId(origFk.name)}`);
    }
  }

  // Added/modified FKs
  for (const modFk of modified.foreignKeys) {
    if (modFk.columns.length === 0 || !modFk.referenceTable) continue;

    if (!origFkIds.has(modFk.id)) {
      clauses.push(`ADD ${buildForeignKeyDef(modFk)}`);
    } else {
      const origFk = origFkMap.get(modFk.id);
      if (origFk && isFkChanged(origFk, modFk)) {
        clauses.push(`DROP FOREIGN KEY ${escId(origFk.name)}`);
        clauses.push(`ADD ${buildForeignKeyDef(modFk)}`);
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
  clauses.push(...optChanges);

  if (clauses.length === 0) return "-- No changes detected";

  // One clause per line: the statement can be long, and a preview the user
  // is asked to approve should be readable.
  return `ALTER TABLE ${tn}\n  ${clauses.join(",\n  ")};`;
}

function isColumnChanged(a: DesignerColumn, b: DesignerColumn): boolean {
  return (
    a.name !== b.name
    || a.type !== b.type
    || a.length !== b.length
    || a.unsigned !== b.unsigned
    || a.zerofill !== b.zerofill
    || a.charset !== b.charset
    || a.collation !== b.collation
    || a.onUpdate !== b.onUpdate
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
