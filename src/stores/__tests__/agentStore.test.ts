import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMocks } = vi.hoisted(() => ({
  apiMocks: {
    agentEndpointStatus: vi.fn(),
    listAgentConnections: vi.fn(),
    startAgentEndpoint: vi.fn(),
    stopAgentEndpoint: vi.fn(),
    rotateAgentToken: vi.fn(),
    shareConnectionWithAgents: vi.fn(),
    revokeAgentConnection: vi.fn(),
    unlockAgentDdl: vi.fn(),
    agentHarnessSetup: vi.fn(),
  },
}));

vi.mock("../../lib/tauri-api", () => ({ api: apiMocks }));

import type { AgentConnection } from "../../lib/bindings";
import { endpointSummary, sharingOf, useAgentStore } from "../agentStore";

const stopped = { running: false, url: null, token: "tok" };
const running = { running: true, url: "http://127.0.0.1:47311/mcp", token: "tok" };

const connection = (overrides: Partial<AgentConnection> = {}): AgentConnection => ({
  connectionId: "c1",
  name: "shop",
  environment: "development",
  readOnly: false,
  connected: true,
  posture: null,
  databases: null,
  redact: [],
  ddlUnlocked: false,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  useAgentStore.setState({
    endpoint: null,
    connections: [],
    loading: false,
    error: null,
    setup: null,
  });
  apiMocks.agentEndpointStatus.mockResolvedValue(stopped);
  apiMocks.listAgentConnections.mockResolvedValue([connection()]);
  apiMocks.startAgentEndpoint.mockResolvedValue(running);
  apiMocks.stopAgentEndpoint.mockResolvedValue(stopped);
  apiMocks.rotateAgentToken.mockResolvedValue({ ...running, token: "new-tok" });
  apiMocks.shareConnectionWithAgents.mockResolvedValue(null);
  apiMocks.revokeAgentConnection.mockResolvedValue(null);
  apiMocks.unlockAgentDdl.mockResolvedValue(null);
  apiMocks.agentHarnessSetup.mockResolvedValue("claude mcp add …");
});

describe("agentStore", () => {
  it("loads the endpoint and the connections together", async () => {
    await useAgentStore.getState().refresh();
    expect(useAgentStore.getState().endpoint).toEqual(stopped);
    expect(useAgentStore.getState().connections).toHaveLength(1);
    expect(useAgentStore.getState().loading).toBe(false);
  });

  it("keeps a failure visible instead of throwing it at the dialog", async () => {
    // A dialog that throws on open is worse than one that says what is wrong.
    apiMocks.agentEndpointStatus.mockRejectedValue(new Error("no backend"));
    await expect(useAgentStore.getState().refresh()).resolves.toBeUndefined();
    expect(useAgentStore.getState().error).toContain("no backend");
    expect(useAgentStore.getState().loading).toBe(false);
  });

  it("picking a posture shares the connection", async () => {
    await useAgentStore.getState().share("c1", "samples");
    expect(apiMocks.shareConnectionWithAgents).toHaveBeenCalledWith("c1", "samples");
  });

  it("picking 'not shared' revokes rather than sharing nothing", async () => {
    // Sharing with an empty posture would be a grant that exists and permits
    // nothing, which is a different and more confusing state.
    await useAgentStore.getState().share("c1", "none");
    expect(apiMocks.revokeAgentConnection).toHaveBeenCalledWith("c1");
    expect(apiMocks.shareConnectionWithAgents).not.toHaveBeenCalled();
  });

  it("re-reads the connections after a change, rather than guessing", async () => {
    // The backend decides what a grant became; the screen should show that
    // and not an optimistic local edit.
    apiMocks.listAgentConnections.mockResolvedValue([connection({ posture: "samples" })]);
    await useAgentStore.getState().share("c1", "samples");
    expect(useAgentStore.getState().connections[0].posture).toBe("samples");
  });

  it("drops the setup text when the endpoint stops", async () => {
    useAgentStore.setState({ setup: "claude mcp add …", endpoint: running });
    await useAgentStore.getState().stop();
    expect(useAgentStore.getState().setup).toBeNull();
  });

  it("drops the setup text when the token is rotated", async () => {
    // It carries the old token; showing it after a rotation hands the user
    // something that no longer works.
    useAgentStore.setState({ setup: "claude mcp add … tok", endpoint: running });
    await useAgentStore.getState().rotateToken();
    expect(useAgentStore.getState().setup).toBeNull();
    expect(useAgentStore.getState().endpoint?.token).toBe("new-tok");
  });

  it("loads setup text for the harness that was asked for", async () => {
    await useAgentStore.getState().loadSetup("copilot");
    expect(apiMocks.agentHarnessSetup).toHaveBeenCalledWith("copilot");
    expect(useAgentStore.getState().setup).toBe("claude mcp add …");
  });

  it("changing the hidden columns keeps how the connection is shared", async () => {
    // Which data and how much data are separate decisions; editing one should
    // not make you re-pick the other.
    useAgentStore.setState({
      connections: [connection({ posture: "samples", databases: ["shop"] })],
    });

    await useAgentStore.getState().setRedaction("c1", ["pw"]);

    expect(apiMocks.shareConnectionWithAgents).toHaveBeenCalledWith(
      "c1",
      "samples",
      ["shop"],
      ["pw"],
    );
  });

  it("does nothing for a connection that is not shared", async () => {
    // There is nothing to redact on something an agent cannot see.
    useAgentStore.setState({ connections: [connection({ posture: null })] });
    await useAgentStore.getState().setRedaction("c1", ["pw"]);
    expect(apiMocks.shareConnectionWithAgents).not.toHaveBeenCalled();
  });

  it("unlocking production DDL goes through the backend", async () => {
    await useAgentStore.getState().unlockDdl("c1", true);
    expect(apiMocks.unlockAgentDdl).toHaveBeenCalledWith("c1", true);
  });
});

describe("sharingOf", () => {
  it("reads an unshared connection as 'none' rather than as empty", () => {
    expect(sharingOf(connection())).toBe("none");
  });

  it("reads a shared one as its posture", () => {
    expect(sharingOf(connection({ posture: "schema-only" }))).toBe("schema-only");
  });
});

describe("endpointSummary", () => {
  it("says nothing is reachable when it is not running", () => {
    expect(endpointSummary(stopped)).toContain("Not listening");
    expect(endpointSummary(null)).toContain("Not listening");
  });

  it("names the URL and says who can reach it", () => {
    // Both halves matter: someone looking at this screen is deciding whether
    // to share a production database.
    const summary = endpointSummary(running);
    expect(summary).toContain("http://127.0.0.1:47311/mcp");
    expect(summary).toContain("this machine");
  });
});
