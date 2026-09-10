/**
 * Reading replication status from either server, under either vocabulary.
 *
 * FR-7.2.4 asks for replication monitoring. There was none — no commands, no
 * parsing, no UI (#434).
 *
 * MySQL renamed every one of these columns in 8.0.22 (Slave→Replica,
 * Master→Source) and kept the old spellings as deprecated aliases. MariaDB
 * kept the old vocabulary and added the new statement names as aliases. So a
 * reader that knows only one vocabulary works on some servers and silently
 * reports nothing on others — silently, because the column is simply absent
 * rather than an error.
 *
 * Column names below are what the servers actually returned, captured from a
 * live MySQL 8.0.46 replica rather than from the manual:
 *
 *   Replica_IO_Running, Replica_SQL_Running, Seconds_Behind_Source,
 *   Source_Host, Source_Port, Last_IO_Error, Last_SQL_Error,
 *   Replica_SQL_Running_State, Source_Log_File, Read_Source_Log_Pos, …
 *
 * and SHOW REPLICAS on the primary returned:
 *
 *   Server_Id, Host, Port, Source_Id, Replica_UUID
 */

/**
 * A statement and the older name to fall back to.
 *
 * The modern spelling is tried first: `SHOW BINARY LOG STATUS` is the only one
 * available in MySQL 8.4, where `SHOW MASTER STATUS` was removed — and
 * `SHOW MASTER STATUS` is the only one MySQL 8.0.46 accepts, where
 * `SHOW BINARY LOG STATUS` is a syntax error. Neither works everywhere, so
 * both are needed.
 */
export interface StatementWithFallback {
  preferred: string;
  fallback: string;
}

export const REPLICA_STATUS: StatementWithFallback = {
  preferred: "SHOW REPLICA STATUS",
  fallback: "SHOW SLAVE STATUS",
};

export const PRIMARY_STATUS: StatementWithFallback = {
  preferred: "SHOW BINARY LOG STATUS",
  fallback: "SHOW MASTER STATUS",
};

export const CONNECTED_REPLICAS: StatementWithFallback = {
  preferred: "SHOW REPLICAS",
  fallback: "SHOW SLAVE HOSTS",
};

/** What this server is doing about replication. */
export interface ReplicaStatus {
  sourceHost: string;
  sourcePort: string;
  ioRunning: boolean;
  sqlRunning: boolean;
  /** Null when the server does not know — which is itself a symptom. */
  secondsBehind: number | null;
  lastIoError: string;
  lastSqlError: string;
  state: string;
  sourceLogFile: string;
  readLogPos: string;
}

export interface PrimaryStatus {
  file: string;
  position: string;
  executedGtidSet: string;
}

export interface ConnectedReplica {
  serverId: string;
  host: string;
  port: string;
}

/** Read one column under any of its historical names. */
function pick(row: Record<string, string>, ...names: string[]): string {
  for (const name of names) {
    const value = row[name.toLowerCase()];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

/** Index a result row by lower-cased column name. */
export function asRecord(columns: string[], row: unknown[]): Record<string, string> {
  const record: Record<string, string> = {};
  columns.forEach((c, i) => {
    record[c.toLowerCase()] = row[i] == null ? "" : String(row[i]);
  });
  return record;
}

export function parseReplicaStatus(
  columns: string[],
  row: unknown[] | undefined,
): ReplicaStatus | null {
  // No row means this server is not a replica, which is not an error.
  if (!row) return null;
  const r = asRecord(columns, row);

  const behind = pick(r, "Seconds_Behind_Source", "Seconds_Behind_Master");
  return {
    sourceHost: pick(r, "Source_Host", "Master_Host"),
    sourcePort: pick(r, "Source_Port", "Master_Port"),
    // "Connecting" is neither Yes nor No, and treating it as running would
    // show a healthy replica that is in fact failing to attach.
    ioRunning: pick(r, "Replica_IO_Running", "Slave_IO_Running") === "Yes",
    sqlRunning: pick(r, "Replica_SQL_Running", "Slave_SQL_Running") === "Yes",
    // NULL here is the server saying it cannot tell — usually because the IO
    // thread is down. Reporting it as 0 would read as "perfectly in sync".
    secondsBehind: behind === "" || behind.toUpperCase() === "NULL" ? null : Number(behind),
    lastIoError: pick(r, "Last_IO_Error"),
    lastSqlError: pick(r, "Last_SQL_Error", "Last_Error"),
    state: pick(r, "Replica_SQL_Running_State", "Slave_SQL_Running_State", "Replica_IO_State"),
    sourceLogFile: pick(r, "Source_Log_File", "Master_Log_File"),
    readLogPos: pick(r, "Read_Source_Log_Pos", "Read_Master_Log_Pos"),
  };
}

export function parsePrimaryStatus(
  columns: string[],
  row: unknown[] | undefined,
): PrimaryStatus | null {
  if (!row) return null;
  const r = asRecord(columns, row);
  return {
    file: pick(r, "File"),
    position: pick(r, "Position"),
    executedGtidSet: pick(r, "Executed_Gtid_Set"),
  };
}

export function parseConnectedReplicas(
  columns: string[],
  rows: unknown[][],
): ConnectedReplica[] {
  return rows.map((row) => {
    const r = asRecord(columns, row);
    return {
      serverId: pick(r, "Server_Id"),
      host: pick(r, "Host"),
      port: pick(r, "Port"),
    };
  });
}

/** What to tell the user, in one line, about a replica's health. */
export function describeReplicaHealth(status: ReplicaStatus): {
  healthy: boolean;
  summary: string;
} {
  if (!status.ioRunning && !status.sqlRunning) {
    return { healthy: false, summary: "Both replication threads are stopped." };
  }
  if (!status.ioRunning) {
    return { healthy: false, summary: "The IO thread is stopped — nothing is being received." };
  }
  if (!status.sqlRunning) {
    return { healthy: false, summary: "The SQL thread is stopped — nothing is being applied." };
  }
  if (status.secondsBehind === null) {
    return { healthy: false, summary: "The server cannot say how far behind it is." };
  }
  if (status.secondsBehind > 60) {
    return { healthy: false, summary: `${status.secondsBehind}s behind the source.` };
  }
  return {
    healthy: true,
    summary: status.secondsBehind === 0
      ? "Caught up with the source."
      : `${status.secondsBehind}s behind the source.`,
  };
}
