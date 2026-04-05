export const GLOBAL_PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "CREATE",
  "DROP",
  "RELOAD",
  "SHUTDOWN",
  "PROCESS",
  "FILE",
  "REFERENCES",
  "INDEX",
  "ALTER",
  "SHOW DATABASES",
  "SUPER",
  "CREATE TEMPORARY TABLES",
  "LOCK TABLES",
  "EXECUTE",
  "REPLICATION SLAVE",
  "REPLICATION CLIENT",
  "CREATE VIEW",
  "SHOW VIEW",
  "CREATE ROUTINE",
  "ALTER ROUTINE",
  "CREATE USER",
  "EVENT",
  "TRIGGER",
  "CREATE TABLESPACE",
] as const;

export const DATABASE_PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "CREATE",
  "DROP",
  "REFERENCES",
  "INDEX",
  "ALTER",
  "CREATE TEMPORARY TABLES",
  "LOCK TABLES",
  "EXECUTE",
  "CREATE VIEW",
  "SHOW VIEW",
  "CREATE ROUTINE",
  "ALTER ROUTINE",
  "EVENT",
  "TRIGGER",
] as const;

export type GlobalPrivilege = (typeof GLOBAL_PRIVILEGES)[number];
export type DatabasePrivilege = (typeof DATABASE_PRIVILEGES)[number];

export interface ParsedGrant {
  privileges: string[];
  scope: string; // e.g. "*.*", "db.*", "db.table"
  grantOption: boolean;
}

export function escapeIdentifier(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function parseGrantStatements(grants: string[]): ParsedGrant[] {
  const parsed: ParsedGrant[] = [];
  for (const grant of grants) {
    const match = grant.match(
      /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i,
    );
    if (!match) continue;

    const privsPart = match[1].trim();
    const scope = match[2].trim();
    const grantOption = /WITH\s+GRANT\s+OPTION/i.test(grant);

    let privileges: string[];
    if (/^ALL\s+PRIVILEGES$/i.test(privsPart) || /^ALL$/i.test(privsPart)) {
      privileges = ["ALL PRIVILEGES"];
    } else {
      privileges = privsPart
        .split(",")
        .map((p) => p.trim().replace(/\s*\(.+?\)/, ""))
        .filter(Boolean);
    }

    parsed.push({ privileges, scope, grantOption });
  }
  return parsed;
}

export function categorizeGrants(parsed: ParsedGrant[]): {
  global: ParsedGrant[];
  database: Map<string, ParsedGrant>;
  table: ParsedGrant[];
} {
  const global: ParsedGrant[] = [];
  const database = new Map<string, ParsedGrant>();
  const table: ParsedGrant[] = [];

  for (const g of parsed) {
    const cleanScope = g.scope.replace(/`/g, "");
    if (cleanScope === "*.*") {
      global.push(g);
    } else if (cleanScope.endsWith(".*")) {
      const db = cleanScope.replace(".*", "");
      database.set(db, g);
    } else {
      table.push(g);
    }
  }

  return { global, database, table };
}
