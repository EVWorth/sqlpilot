import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { liveConnectionIds } from "../../lib/run-connection";
import { useConnectionStore } from "../../stores/connectionStore";
import { type SqliteSession, useSqliteStore } from "../../stores/sqliteStore";
import type { ConnectionInfo } from "../../types";
import { useLiveConnectionIds } from "../useLiveConnectionIds";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const server = (id: string) => ({ id }) as unknown as ConnectionInfo;
const file = (id: string) => ({ id }) as unknown as SqliteSession;

beforeEach(() => {
  useConnectionStore.setState({ activeConnections: [] });
  useSqliteStore.setState({ sessions: [] });
});

describe("useLiveConnectionIds", () => {
  it("lists connected servers and open SQLite files", () => {
    useConnectionStore.setState({ activeConnections: [server("dev")] });
    useSqliteStore.setState({ sessions: [file("sqlite-1")] });

    const { result } = renderHook(() => useLiveConnectionIds());

    expect(result.current).toEqual(["dev", "sqlite-1"]);
  });

  it("follows servers and files as they come and go", () => {
    const { result } = renderHook(() => useLiveConnectionIds());
    expect(result.current).toEqual([]);

    act(() => useConnectionStore.setState({ activeConnections: [server("dev"), server("prod")] }));
    act(() => useSqliteStore.setState({ sessions: [file("sqlite-1")] }));
    expect(result.current).toEqual(["dev", "prod", "sqlite-1"]);

    act(() => useConnectionStore.setState({ activeConnections: [server("prod")] }));
    expect(result.current).toEqual(["prod", "sqlite-1"]);
  });

  // Where a run goes and whether a tab's connection still counts (#944) read
  // one list each; they must not drift apart.
  it("is the same list as liveConnectionIds", () => {
    useConnectionStore.setState({ activeConnections: [server("dev")] });
    useSqliteStore.setState({ sessions: [file("sqlite-1"), file("sqlite-2")] });

    const { result } = renderHook(() => useLiveConnectionIds());

    expect(result.current).toEqual(liveConnectionIds());
  });
});
