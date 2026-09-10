import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runStatement = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/run-statement", () => ({ runStatement }));

import { ReplicationTab } from "../ReplicationTab";

const cols = (names: string[]) => names.map((name) => ({ name }));

/** A live MySQL 8.0.46 replica's answer. */
const REPLICA_RESULT = {
  columns: cols([
    "Source_Host",
    "Source_Port",
    "Replica_IO_Running",
    "Replica_SQL_Running",
    "Seconds_Behind_Source",
    "Source_Log_File",
    "Read_Source_Log_Pos",
    "Replica_SQL_Running_State",
    "Last_IO_Error",
    "Last_SQL_Error",
  ]),
  rows: [[
    "mas-mysql-8",
    "3306",
    "Yes",
    "Yes",
    "0",
    "binlog.000002",
    "137675",
    "Replica has read all relay log",
    "",
    "",
  ]],
};

const PRIMARY_RESULT = {
  columns: cols(["File", "Position", "Executed_Gtid_Set"]),
  rows: [["binlog.000002", "137158", ""]],
};

const REPLICAS_RESULT = {
  columns: cols(["Server_Id", "Host", "Port", "Source_Id", "Replica_UUID"]),
  rows: [["2", "", "3306", "1", "874421d9"]],
};

/** Answer by statement, so fallbacks and ordering behave realistically. */
function seed(answers: Record<string, unknown>) {
  runStatement.mockImplementation(async ({ sql }: { sql: string }) => {
    if (sql in answers) {
      const value = answers[sql];
      if (value === "error") throw new Error("ERROR 1064 syntax");
      return [value];
    }
    throw new Error("ERROR 1064 syntax");
  });
}

describe("ReplicationTab (#434)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runStatement.mockReset();
  });

  it("says a standalone server is neither, without calling it an error", async () => {
    seed({
      "SHOW REPLICA STATUS": { columns: [], rows: [] },
      "SHOW BINARY LOG STATUS": { columns: [], rows: [] },
      "SHOW REPLICAS": { columns: [], rows: [] },
    });
    render(<ReplicationTab connectionId="c1" />);

    expect(await screen.findByText(/neither a replica nor a primary/)).toBeInTheDocument();
  });

  it("shows replica health when this server is a replica", async () => {
    seed({
      "SHOW REPLICA STATUS": REPLICA_RESULT,
      "SHOW BINARY LOG STATUS": { columns: [], rows: [] },
      "SHOW REPLICAS": { columns: [], rows: [] },
    });
    render(<ReplicationTab connectionId="c1" />);

    expect(await screen.findByText(/Replicating from mas-mysql-8:3306/)).toBeInTheDocument();
    expect(screen.getByText("Caught up with the source.")).toBeInTheDocument();
    expect(screen.getByText("binlog.000002:137675")).toBeInTheDocument();
  });

  it("raises an alert when a thread has stopped", async () => {
    const stopped = structuredClone(REPLICA_RESULT);
    stopped.rows[0][2] = "No";
    seed({
      "SHOW REPLICA STATUS": stopped,
      "SHOW BINARY LOG STATUS": { columns: [], rows: [] },
      "SHOW REPLICAS": { columns: [], rows: [] },
    });
    render(<ReplicationTab connectionId="c1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("IO thread is stopped");
  });

  it("falls back to the older statement name", async () => {
    // SHOW BINARY LOG STATUS is a syntax error on MySQL 8.0.46, and
    // SHOW MASTER STATUS is gone in 8.4 — neither works everywhere.
    seed({
      "SHOW SLAVE STATUS": { columns: [], rows: [] },
      "SHOW MASTER STATUS": PRIMARY_RESULT,
      "SHOW SLAVE HOSTS": { columns: [], rows: [] },
    });
    render(<ReplicationTab connectionId="c1" />);

    expect(await screen.findByText("binlog.000002:137158")).toBeInTheDocument();
  });

  it("lists connected replicas, and says when a host is not reported", async () => {
    // SHOW REPLICAS reports an empty host unless the replica was started with
    // report_host, which most are not.
    seed({
      "SHOW REPLICA STATUS": { columns: [], rows: [] },
      "SHOW BINARY LOG STATUS": PRIMARY_RESULT,
      "SHOW REPLICAS": REPLICAS_RESULT,
    });
    render(<ReplicationTab connectionId="c1" />);

    expect(await screen.findByText("Connected replicas")).toBeInTheDocument();
    expect(screen.getByText("not reported")).toBeInTheDocument();
  });

  it("shows both sides when the server is a replica and a primary", async () => {
    seed({
      "SHOW REPLICA STATUS": REPLICA_RESULT,
      "SHOW BINARY LOG STATUS": PRIMARY_RESULT,
      "SHOW REPLICAS": REPLICAS_RESULT,
    });
    render(<ReplicationTab connectionId="c1" />);

    await waitFor(() => expect(screen.getByText("Binary log")).toBeInTheDocument());
    expect(screen.getByText(/Replicating from/)).toBeInTheDocument();
    expect(screen.getByText("Connected replicas")).toBeInTheDocument();
  });

  it("reads these as internal statements, not the user's work", async () => {
    seed({
      "SHOW REPLICA STATUS": { columns: [], rows: [] },
      "SHOW BINARY LOG STATUS": { columns: [], rows: [] },
      "SHOW REPLICAS": { columns: [], rows: [] },
    });
    render(<ReplicationTab connectionId="c1" />);

    await waitFor(() => expect(runStatement).toHaveBeenCalled());
    for (const [call] of runStatement.mock.calls) {
      expect(call.origin).toBe("internal");
    }
  });
});
