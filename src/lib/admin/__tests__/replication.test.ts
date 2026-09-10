import { describe, expect, it } from "vitest";
import {
  CONNECTED_REPLICAS,
  describeReplicaHealth,
  parseConnectedReplicas,
  parsePrimaryStatus,
  parseReplicaStatus,
  PRIMARY_STATUS,
  REPLICA_STATUS,
} from "../replication";

/** The column names a live MySQL 8.0.46 replica actually returned. */
const MYSQL_COLUMNS = [
  "Replica_IO_State",
  "Source_Host",
  "Source_Port",
  "Source_Log_File",
  "Read_Source_Log_Pos",
  "Replica_IO_Running",
  "Replica_SQL_Running",
  "Last_Error",
  "Seconds_Behind_Source",
  "Last_IO_Error",
  "Last_SQL_Error",
  "Replica_SQL_Running_State",
];
const MYSQL_ROW = [
  "Waiting for source to send event",
  "mas-mysql-8",
  "3306",
  "binlog.000002",
  "137675",
  "Yes",
  "Yes",
  "",
  "0",
  "",
  "",
  "Replica has read all relay log; waiting for more updates",
];

/** The older vocabulary, which MariaDB and pre-8.0.22 MySQL use. */
const LEGACY_COLUMNS = [
  "Master_Host",
  "Master_Port",
  "Master_Log_File",
  "Read_Master_Log_Pos",
  "Slave_IO_Running",
  "Slave_SQL_Running",
  "Seconds_Behind_Master",
  "Last_Error",
  "Slave_SQL_Running_State",
];
const LEGACY_ROW = ["db1", "3306", "mysql-bin.000004", "9001", "Yes", "Yes", "12", "", "Waiting"];

describe("statement fallbacks (#434)", () => {
  it("prefers the modern name and keeps the old one", () => {
    // Neither works everywhere: SHOW MASTER STATUS is gone in MySQL 8.4, and
    // SHOW BINARY LOG STATUS is a syntax error in 8.0.46.
    expect(REPLICA_STATUS).toEqual({
      preferred: "SHOW REPLICA STATUS",
      fallback: "SHOW SLAVE STATUS",
    });
    expect(PRIMARY_STATUS).toEqual({
      preferred: "SHOW BINARY LOG STATUS",
      fallback: "SHOW MASTER STATUS",
    });
    expect(CONNECTED_REPLICAS).toEqual({
      preferred: "SHOW REPLICAS",
      fallback: "SHOW SLAVE HOSTS",
    });
  });
});

describe("parseReplicaStatus", () => {
  it("reads the modern column names", () => {
    const status = parseReplicaStatus(MYSQL_COLUMNS, MYSQL_ROW)!;
    expect(status.sourceHost).toBe("mas-mysql-8");
    expect(status.ioRunning).toBe(true);
    expect(status.sqlRunning).toBe(true);
    expect(status.secondsBehind).toBe(0);
    expect(status.sourceLogFile).toBe("binlog.000002");
  });

  it("reads the legacy column names", () => {
    // MySQL renamed every one of these in 8.0.22 and MariaDB kept the old
    // ones. A reader that knows one vocabulary reports nothing on the other,
    // silently, because the column is absent rather than an error.
    const status = parseReplicaStatus(LEGACY_COLUMNS, LEGACY_ROW)!;
    expect(status.sourceHost).toBe("db1");
    expect(status.secondsBehind).toBe(12);
    expect(status.sourceLogFile).toBe("mysql-bin.000004");
  });

  it("returns null when the server is not a replica", () => {
    // An empty result is the normal answer on a primary, not an error.
    expect(parseReplicaStatus(MYSQL_COLUMNS, undefined)).toBeNull();
  });

  it("treats Connecting as not running", () => {
    // Neither Yes nor No: reporting it as running would show a healthy
    // replica that is in fact failing to attach.
    const row = [...MYSQL_ROW];
    row[5] = "Connecting";
    expect(parseReplicaStatus(MYSQL_COLUMNS, row)!.ioRunning).toBe(false);
  });

  it("keeps NULL lag as unknown rather than zero", () => {
    // NULL is the server saying it cannot tell, usually because the IO thread
    // is down. Zero would read as perfectly in sync.
    const row = [...MYSQL_ROW];
    row[8] = "NULL";
    expect(parseReplicaStatus(MYSQL_COLUMNS, row)!.secondsBehind).toBeNull();

    const empty = [...MYSQL_ROW];
    empty[8] = "";
    expect(parseReplicaStatus(MYSQL_COLUMNS, empty)!.secondsBehind).toBeNull();
  });

  it("is case-insensitive about column names", () => {
    const status = parseReplicaStatus(
      MYSQL_COLUMNS.map((c) => c.toUpperCase()),
      MYSQL_ROW,
    )!;
    expect(status.sourceHost).toBe("mas-mysql-8");
  });
});

describe("parsePrimaryStatus", () => {
  it("reads the binlog position", () => {
    // These are the columns SHOW MASTER STATUS returned on MySQL 8.0.46.
    const status = parsePrimaryStatus(
      ["File", "Position", "Binlog_Do_DB", "Binlog_Ignore_DB", "Executed_Gtid_Set"],
      ["binlog.000002", "137158", "", "", "abc:1-5"],
    )!;
    expect(status).toEqual({
      file: "binlog.000002",
      position: "137158",
      executedGtidSet: "abc:1-5",
    });
  });

  it("returns null when binary logging is off", () => {
    expect(parsePrimaryStatus(["File"], undefined)).toBeNull();
  });
});

describe("parseConnectedReplicas", () => {
  it("reads what SHOW REPLICAS returned on the primary", () => {
    const replicas = parseConnectedReplicas(
      ["Server_Id", "Host", "Port", "Source_Id", "Replica_UUID"],
      [["2", "", "3306", "1", "874421d9"]],
    );
    expect(replicas).toEqual([{ serverId: "2", host: "", port: "3306" }]);
  });

  it("handles none connected", () => {
    expect(parseConnectedReplicas(["Server_Id"], [])).toEqual([]);
  });
});

describe("describeReplicaHealth", () => {
  const base = parseReplicaStatus(MYSQL_COLUMNS, MYSQL_ROW)!;

  it("is healthy when caught up", () => {
    expect(describeReplicaHealth(base)).toEqual({
      healthy: true,
      summary: "Caught up with the source.",
    });
  });

  it("is healthy but behind for a small lag", () => {
    expect(describeReplicaHealth({ ...base, secondsBehind: 5 }).healthy).toBe(true);
  });

  it("is unhealthy past a minute behind", () => {
    expect(describeReplicaHealth({ ...base, secondsBehind: 61 }).healthy).toBe(false);
  });

  it("names which thread stopped", () => {
    expect(describeReplicaHealth({ ...base, ioRunning: false }).summary).toContain("IO thread");
    expect(describeReplicaHealth({ ...base, sqlRunning: false }).summary).toContain("SQL thread");
    expect(describeReplicaHealth({ ...base, ioRunning: false, sqlRunning: false }).summary)
      .toContain("Both");
  });

  it("is unhealthy when the lag is unknown", () => {
    expect(describeReplicaHealth({ ...base, secondsBehind: null }).healthy).toBe(false);
  });
});
