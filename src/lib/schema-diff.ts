import type { ColumnInfo, IndexInfo, ViewInfo, RoutineInfo, TriggerInfo } from "../types";

export interface ColumnModification {
  name: string;
  sourceColumn: ColumnInfo;
  targetColumn: ColumnInfo;
  changes: string[];
}

export interface TableDiff {
  name: string;
  columns: {
    added: ColumnInfo[];
    removed: ColumnInfo[];
    modified: ColumnModification[];
  };
  indexes: {
    added: IndexInfo[];
    removed: IndexInfo[];
  };
}

export interface ObjectDiff<T> {
  onlyInSource: T[];
  onlyInTarget: T[];
  different: string[];
  identical: string[];
}

export interface SchemaComparison {
  tables: {
    onlyInSource: string[];
    onlyInTarget: string[];
    different: TableDiff[];
    identical: string[];
  };
  views: ObjectDiff<ViewInfo>;
  routines: ObjectDiff<RoutineInfo>;
  triggers: ObjectDiff<TriggerInfo>;
}

export interface SchemaSnapshot {
  tables: {
    name: string;
    columns: ColumnInfo[];
    indexes: IndexInfo[];
  }[];
  views: { info: ViewInfo; ddl: string }[];
  routines: { info: RoutineInfo; ddl: string }[];
  triggers: { info: TriggerInfo; ddl: string }[];
}

export function compareColumns(
  sourceColumns: ColumnInfo[],
  targetColumns: ColumnInfo[],
): { added: ColumnInfo[]; removed: ColumnInfo[]; modified: ColumnModification[] } {
  const sourceMap = new Map(sourceColumns.map((c) => [c.name, c]));
  const targetMap = new Map(targetColumns.map((c) => [c.name, c]));

  const added: ColumnInfo[] = [];
  const removed: ColumnInfo[] = [];
  const modified: ColumnModification[] = [];

  for (const col of sourceColumns) {
    if (!targetMap.has(col.name)) {
      added.push(col);
    }
  }

  for (const col of targetColumns) {
    if (!sourceMap.has(col.name)) {
      removed.push(col);
    }
  }

  for (const [name, srcCol] of sourceMap) {
    const tgtCol = targetMap.get(name);
    if (!tgtCol) continue;

    const changes: string[] = [];
    if (srcCol.column_type !== tgtCol.column_type) {
      changes.push(`type: ${tgtCol.column_type} → ${srcCol.column_type}`);
    }
    if (srcCol.nullable !== tgtCol.nullable) {
      changes.push(`nullable: ${tgtCol.nullable ? "YES" : "NO"} → ${srcCol.nullable ? "YES" : "NO"}`);
    }
    if ((srcCol.default_value ?? "") !== (tgtCol.default_value ?? "")) {
      changes.push(`default: ${tgtCol.default_value ?? "NULL"} → ${srcCol.default_value ?? "NULL"}`);
    }
    if (srcCol.extra !== tgtCol.extra) {
      changes.push(`extra: ${tgtCol.extra || "(none)"} → ${srcCol.extra || "(none)"}`);
    }
    if (srcCol.comment !== tgtCol.comment) {
      changes.push(`comment: "${tgtCol.comment}" → "${srcCol.comment}"`);
    }

    if (changes.length > 0) {
      modified.push({ name, sourceColumn: srcCol, targetColumn: tgtCol, changes });
    }
  }

  return { added, removed, modified };
}

export function compareIndexes(
  sourceIndexes: IndexInfo[],
  targetIndexes: IndexInfo[],
): { added: IndexInfo[]; removed: IndexInfo[] } {
  const sourceMap = new Map(sourceIndexes.map((i) => [i.name, i]));
  const targetMap = new Map(targetIndexes.map((i) => [i.name, i]));

  const added: IndexInfo[] = [];
  const removed: IndexInfo[] = [];

  for (const idx of sourceIndexes) {
    const tgtIdx = targetMap.get(idx.name);
    if (!tgtIdx) {
      added.push(idx);
    } else if (
      idx.columns.join(",") !== tgtIdx.columns.join(",") ||
      idx.is_unique !== tgtIdx.is_unique ||
      idx.index_type !== tgtIdx.index_type
    ) {
      // Index changed — treat as remove old + add new
      removed.push(tgtIdx);
      added.push(idx);
    }
  }

  for (const idx of targetIndexes) {
    if (!sourceMap.has(idx.name)) {
      removed.push(idx);
    }
  }

  return { added, removed };
}

function normalizeDdl(ddl: string): string {
  return ddl.replace(/\s+/g, " ").trim().toLowerCase();
}

export function compareSchemas(source: SchemaSnapshot, target: SchemaSnapshot): SchemaComparison {
  const sourceTableNames = new Set(source.tables.map((t) => t.name));
  const targetTableNames = new Set(target.tables.map((t) => t.name));
  const sourceTableMap = new Map(source.tables.map((t) => [t.name, t]));
  const targetTableMap = new Map(target.tables.map((t) => [t.name, t]));

  const onlyInSource: string[] = [];
  const onlyInTarget: string[] = [];
  const different: TableDiff[] = [];
  const identical: string[] = [];

  for (const name of sourceTableNames) {
    if (!targetTableNames.has(name)) {
      onlyInSource.push(name);
    }
  }
  for (const name of targetTableNames) {
    if (!sourceTableNames.has(name)) {
      onlyInTarget.push(name);
    }
  }

  for (const name of sourceTableNames) {
    if (!targetTableNames.has(name)) continue;
    const srcTable = sourceTableMap.get(name)!;
    const tgtTable = targetTableMap.get(name)!;

    const colDiff = compareColumns(srcTable.columns, tgtTable.columns);
    const idxDiff = compareIndexes(srcTable.indexes, tgtTable.indexes);

    const hasDifferences =
      colDiff.added.length > 0 ||
      colDiff.removed.length > 0 ||
      colDiff.modified.length > 0 ||
      idxDiff.added.length > 0 ||
      idxDiff.removed.length > 0;

    if (hasDifferences) {
      different.push({ name, columns: colDiff, indexes: idxDiff });
    } else {
      identical.push(name);
    }
  }

  // Compare views
  const sourceViewMap = new Map(source.views.map((v) => [v.info.name, v]));
  const targetViewMap = new Map(target.views.map((v) => [v.info.name, v]));
  const viewDiff = compareObjects(sourceViewMap, targetViewMap, (s, t) => normalizeDdl(s.ddl) === normalizeDdl(t.ddl));

  // Compare routines
  const sourceRoutineMap = new Map(source.routines.map((r) => [r.info.name, r]));
  const targetRoutineMap = new Map(target.routines.map((r) => [r.info.name, r]));
  const routineDiff = compareObjects(sourceRoutineMap, targetRoutineMap, (s, t) => normalizeDdl(s.ddl) === normalizeDdl(t.ddl));

  // Compare triggers
  const sourceTriggerMap = new Map(source.triggers.map((t) => [t.info.name, t]));
  const targetTriggerMap = new Map(target.triggers.map((t) => [t.info.name, t]));
  const triggerDiff = compareObjects(sourceTriggerMap, targetTriggerMap, (s, t) => normalizeDdl(s.ddl) === normalizeDdl(t.ddl));

  return {
    tables: { onlyInSource, onlyInTarget, different, identical },
    views: {
      onlyInSource: [...viewDiff.onlyInSource].map((n) => sourceViewMap.get(n)!.info),
      onlyInTarget: [...viewDiff.onlyInTarget].map((n) => targetViewMap.get(n)!.info),
      different: viewDiff.different,
      identical: viewDiff.identical,
    },
    routines: {
      onlyInSource: [...routineDiff.onlyInSource].map((n) => sourceRoutineMap.get(n)!.info),
      onlyInTarget: [...routineDiff.onlyInTarget].map((n) => targetRoutineMap.get(n)!.info),
      different: routineDiff.different,
      identical: routineDiff.identical,
    },
    triggers: {
      onlyInSource: [...triggerDiff.onlyInSource].map((n) => sourceTriggerMap.get(n)!.info),
      onlyInTarget: [...triggerDiff.onlyInTarget].map((n) => targetTriggerMap.get(n)!.info),
      different: triggerDiff.different,
      identical: triggerDiff.identical,
    },
  };
}

function compareObjects<T>(
  sourceMap: Map<string, T>,
  targetMap: Map<string, T>,
  isEqual: (s: T, t: T) => boolean,
): { onlyInSource: string[]; onlyInTarget: string[]; different: string[]; identical: string[] } {
  const onlyInSource: string[] = [];
  const onlyInTarget: string[] = [];
  const different: string[] = [];
  const identical: string[] = [];

  for (const name of sourceMap.keys()) {
    if (!targetMap.has(name)) {
      onlyInSource.push(name);
    } else if (isEqual(sourceMap.get(name)!, targetMap.get(name)!)) {
      identical.push(name);
    } else {
      different.push(name);
    }
  }
  for (const name of targetMap.keys()) {
    if (!sourceMap.has(name)) {
      onlyInTarget.push(name);
    }
  }

  return { onlyInSource, onlyInTarget, different, identical };
}
