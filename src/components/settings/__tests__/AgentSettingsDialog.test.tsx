import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

vi.mock("../../../lib/tauri-api", () => ({ api: apiMocks }));

import type { AgentConnection } from "../../../lib/bindings";
import { useAgentStore } from "../../../stores/agentStore";
import { AgentSettingsDialog } from "../AgentSettingsDialog";

const stopped = { running: false, url: null, token: "abcdef0123456789" };
const running = { running: true, url: "http://127.0.0.1:47311/mcp", token: "abcdef0123456789" };

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
  apiMocks.rotateAgentToken.mockResolvedValue(running);
  apiMocks.shareConnectionWithAgents.mockResolvedValue(null);
  apiMocks.revokeAgentConnection.mockResolvedValue(null);
  apiMocks.unlockAgentDdl.mockResolvedValue(null);
  apiMocks.agentHarnessSetup.mockResolvedValue("claude mcp add --transport http sqlpilot …");
});

const open = () => render(<AgentSettingsDialog isOpen onClose={() => {}} />);

describe("AgentSettingsDialog", () => {
  it("renders nothing when closed", () => {
    render(<AgentSettingsDialog isOpen={false} onClose={() => {}} />);
    expect(screen.queryByText("Agents")).toBeNull();
    expect(apiMocks.agentEndpointStatus).not.toHaveBeenCalled();
  });

  it("says plainly that nothing is reachable while the endpoint is stopped", async () => {
    open();
    expect(await screen.findByText(/Not listening/)).toBeTruthy();
  });

  it("shows the URL once it is running", async () => {
    apiMocks.agentEndpointStatus.mockResolvedValue(running);
    open();
    expect(await screen.findByText(/127\.0\.0\.1:47311/)).toBeTruthy();
  });

  it("starts the endpoint", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await waitFor(() => expect(apiMocks.startAgentEndpoint).toHaveBeenCalled());
  });

  it("hides the token until it is asked for", async () => {
    // Not a secret from the user — they have to paste it into a harness — but
    // a secret from whoever is standing behind them.
    open();
    await screen.findByText(/Not listening/);
    expect(screen.queryByText("abcdef0123456789")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show token" }));
    expect(screen.getByText("abcdef0123456789")).toBeTruthy();
  });

  it("shows an unshared connection as not shared", async () => {
    open();
    const select = await screen.findByLabelText("How shop is shared");
    expect((select as HTMLSelectElement).value).toBe("none");
  });

  it("sharing a connection sends the posture that was picked", async () => {
    open();
    const select = await screen.findByLabelText("How shop is shared");
    fireEvent.change(select, { target: { value: "samples" } });
    await waitFor(() => expect(apiMocks.shareConnectionWithAgents).toHaveBeenCalledWith("c1", "samples"));
  });

  it("explains what the chosen posture means", async () => {
    // The posture is the answer to "what is this thing allowed to see", so it
    // should be readable on the row rather than looked up elsewhere.
    apiMocks.listAgentConnections.mockResolvedValue([connection({ posture: "schema-only" })]);
    open();
    expect(await screen.findByText(/no row values come back/)).toBeTruthy();
  });

  it("marks a production connection", async () => {
    apiMocks.listAgentConnections.mockResolvedValue([
      connection({ environment: "production", posture: "schema-only" }),
    ]);
    open();
    const badge = await screen.findByTestId("environment-badge");
    expect(badge.textContent).toBe("production");
  });

  it("offers a place to name the columns this schema hides", async () => {
    // The built-in credential list cannot know a schema calls it `pw`.
    apiMocks.listAgentConnections.mockResolvedValue([connection({ posture: "samples" })]);
    open();
    expect(await screen.findByLabelText("Columns to hide on shop")).toBeTruthy();
  });

  it("does not offer it on a connection nobody shared", async () => {
    apiMocks.listAgentConnections.mockResolvedValue([connection({ posture: null })]);
    open();
    await screen.findByLabelText("How shop is shared");
    expect(screen.queryByLabelText("Columns to hide on shop")).toBeNull();
  });

  it("saves the patterns when the field is left, not on every keystroke", async () => {
    apiMocks.listAgentConnections.mockResolvedValue([connection({ posture: "samples" })]);
    open();
    const field = await screen.findByLabelText("Columns to hide on shop");

    fireEvent.change(field, { target: { value: "pw, *_nino ," } });
    expect(apiMocks.shareConnectionWithAgents).not.toHaveBeenCalled();

    fireEvent.blur(field);
    await waitFor(() =>
      // Trimmed, and the empty one from the trailing comma dropped.
      expect(apiMocks.shareConnectionWithAgents).toHaveBeenCalledWith("c1", "samples", undefined, [
        "pw",
        "*_nino",
      ])
    );
  });

  it("shows the patterns a connection already has", async () => {
    apiMocks.listAgentConnections.mockResolvedValue([
      connection({ posture: "samples", redact: ["pw", "*_nino"] }),
    ]);
    open();
    const field = await screen.findByLabelText("Columns to hide on shop") as HTMLInputElement;
    expect(field.value).toBe("pw, *_nino");
  });

  it("offers the schema-change unlock only on a shared production connection", async () => {
    apiMocks.listAgentConnections.mockResolvedValue([
      connection({ environment: "production", posture: "samples" }),
    ]);
    open();
    expect(await screen.findByText(/Allow schema changes this session/)).toBeTruthy();
  });

  it("does not offer the unlock on a connection nobody shared", async () => {
    apiMocks.listAgentConnections.mockResolvedValue([
      connection({ environment: "production", posture: null }),
    ]);
    open();
    await screen.findByLabelText("How shop is shared");
    expect(screen.queryByText(/Allow schema changes this session/)).toBeNull();
  });

  it("does not offer the unlock on a read-only connection", async () => {
    // Read-only refuses schema changes whatever the unlock says, so offering
    // it would be a switch that does nothing.
    apiMocks.listAgentConnections.mockResolvedValue([
      connection({ environment: "production", posture: "samples", readOnly: true }),
    ]);
    open();
    await screen.findByLabelText("How shop is shared");
    expect(screen.queryByText(/Allow schema changes this session/)).toBeNull();
  });

  it("says a grant on a disconnected connection is not live yet", async () => {
    apiMocks.listAgentConnections.mockResolvedValue([
      connection({ posture: "samples", connected: false }),
    ]);
    open();
    expect(await screen.findByText(/Takes effect when you connect/)).toBeTruthy();
  });

  it("waits for the endpoint before offering setup text", async () => {
    open();
    expect(await screen.findByText(/Start the endpoint to see the command/)).toBeTruthy();
    expect(apiMocks.agentHarnessSetup).not.toHaveBeenCalled();
  });

  it("shows the setup command once the endpoint is running", async () => {
    apiMocks.agentEndpointStatus.mockResolvedValue(running);
    open();
    expect(await screen.findByText(/claude mcp add --transport http sqlpilot/)).toBeTruthy();
  });

  it("asks for the setup text again when the harness changes", async () => {
    apiMocks.agentEndpointStatus.mockResolvedValue(running);
    open();
    await screen.findByText(/claude mcp add/);

    fireEvent.change(screen.getByLabelText("Harness"), { target: { value: "copilot" } });
    await waitFor(() => expect(apiMocks.agentHarnessSetup).toHaveBeenCalledWith("copilot"));
  });

  it("surfaces a failure rather than showing an empty screen", async () => {
    apiMocks.listAgentConnections.mockRejectedValue(new Error("no backend"));
    open();
    expect((await screen.findByRole("alert")).textContent).toContain("no backend");
  });

  it("says where approval happens, so the harness's own settings do not read as the last word", async () => {
    open();
    expect(await screen.findByText(/approved in this window/)).toBeTruthy();
  });
});
