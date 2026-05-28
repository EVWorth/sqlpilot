import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ConnectionProfileSummary, ConnectionInfo, ConnectionProfile } from "../../types";
import { api } from "../../lib/tauri-api";
import { useConnectionStore } from "../connectionStore";

vi.mock("../../lib/tauri-api", () => ({
  api: {
    listConnectionProfiles: vi.fn(),
    saveConnectionProfile: vi.fn(),
    deleteConnectionProfile: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
}));

const mockProfileSummary: ConnectionProfileSummary = {
  id: "profile-1",
  name: "Test Connection",
  host: "localhost",
  port: 3306,
  username: "root",
  default_database: "test",
  group: "dev",
  color: "#ff0000",
  environment: "development",
  pool_min: 1,
  pool_max: 5,
  read_only: false,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

const mockProfileSummaries: ConnectionProfileSummary[] = [mockProfileSummary];

const mockConnectionInfo: ConnectionInfo = {
  id: "conn-1",
  profile_id: "profile-1",
  name: "Test Connection",
  host: "localhost",
  port: 3306,
  database: "test",
  server_version: "8.0.0",
  connected_at: "2024-01-01T00:00:00Z",
  color: "#ff0000",
  environment: "development",
};

const mockConnectionProfile: ConnectionProfile = {
  ...mockProfileSummary,
  password: "secret",
};

describe("connectionStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConnectionStore.setState({
      profiles: [],
      activeConnections: [],
      selectedConnectionId: null,
      loading: false,
      error: null,
    });
  });

  describe("loadProfiles", () => {
    it("loads profiles successfully", async () => {
      vi.mocked(api.listConnectionProfiles).mockResolvedValue(mockProfileSummaries);

      await useConnectionStore.getState().loadProfiles();

      const state = useConnectionStore.getState();
      expect(state.profiles).toEqual(mockProfileSummaries);
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });

    it("sets loading to true during load", async () => {
      vi.mocked(api.listConnectionProfiles).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(mockProfileSummaries), 10)),
      );

      const promise = useConnectionStore.getState().loadProfiles();
      expect(useConnectionStore.getState().loading).toBe(true);

      await promise;
    });

    it("handles loadProfiles error", async () => {
      vi.mocked(api.listConnectionProfiles).mockRejectedValue(new Error("API error"));

      await useConnectionStore.getState().loadProfiles();

      const state = useConnectionStore.getState();
      expect(state.error).toBe("Error: API error");
      expect(state.loading).toBe(false);
    });

    it("clears previous error on new loadProfiles call", async () => {
      vi.mocked(api.listConnectionProfiles).mockRejectedValue(new Error("First error"));
      await useConnectionStore.getState().loadProfiles();

      vi.mocked(api.listConnectionProfiles).mockResolvedValue(mockProfileSummaries);
      await useConnectionStore.getState().loadProfiles();

      const state = useConnectionStore.getState();
      expect(state.error).toBeNull();
      expect(state.profiles).toEqual(mockProfileSummaries);
    });
  });

  describe("saveProfile", () => {
    it("saves profile and reloads profiles on success", async () => {
      vi.mocked(api.saveConnectionProfile).mockResolvedValue("profile-1");
      vi.mocked(api.listConnectionProfiles).mockResolvedValue(mockProfileSummaries);

      await useConnectionStore.getState().saveProfile(mockConnectionProfile);

      expect(api.saveConnectionProfile).toHaveBeenCalledWith(mockConnectionProfile);
      expect(api.listConnectionProfiles).toHaveBeenCalled();
      expect(useConnectionStore.getState().profiles).toEqual(mockProfileSummaries);
    });

    it("handles saveProfile error", async () => {
      vi.mocked(api.saveConnectionProfile).mockRejectedValue(new Error("Save failed"));

      await useConnectionStore.getState().saveProfile(mockConnectionProfile);

      const state = useConnectionStore.getState();
      expect(state.error).toBe("Error: Save failed");
      expect(state.loading).toBe(false);
    });
  });

  describe("deleteProfile", () => {
    it("deletes profile and reloads profiles on success", async () => {
      vi.mocked(api.deleteConnectionProfile).mockResolvedValue(undefined);
      vi.mocked(api.listConnectionProfiles).mockResolvedValue([]);

      await useConnectionStore.getState().deleteProfile("profile-1");

      expect(api.deleteConnectionProfile).toHaveBeenCalledWith("profile-1");
      expect(api.listConnectionProfiles).toHaveBeenCalled();
      expect(useConnectionStore.getState().profiles).toEqual([]);
    });

    it("handles deleteProfile error", async () => {
      vi.mocked(api.deleteConnectionProfile).mockRejectedValue(new Error("Delete failed"));

      await useConnectionStore.getState().deleteProfile("profile-1");

      expect(useConnectionStore.getState().error).toBe("Error: Delete failed");
    });
  });

  describe("connect", () => {
    it("connects successfully and adds to activeConnections", async () => {
      vi.mocked(api.connect).mockResolvedValue(mockConnectionInfo);

      const result = await useConnectionStore.getState().connect("profile-1");

      expect(api.connect).toHaveBeenCalledWith("profile-1");
      const state = useConnectionStore.getState();
      expect(state.activeConnections).toEqual([mockConnectionInfo]);
      expect(state.selectedConnectionId).toBe("conn-1");
      expect(state.loading).toBe(false);
      expect(result).toEqual(mockConnectionInfo);
    });

    it("sets loading to true during connect", async () => {
      vi.mocked(api.connect).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(mockConnectionInfo), 10)),
      );

      const promise = useConnectionStore.getState().connect("profile-1");
      expect(useConnectionStore.getState().loading).toBe(true);

      await promise;
    });

    it("handles connect error and throws", async () => {
      vi.mocked(api.connect).mockRejectedValue(new Error("Connection refused"));

      await expect(useConnectionStore.getState().connect("profile-1")).rejects.toThrow(
        "Connection refused",
      );

      const state = useConnectionStore.getState();
      expect(state.error).toBe("Error: Connection refused");
      expect(state.loading).toBe(false);
    });

    it("appends to existing activeConnections", async () => {
      useConnectionStore.setState({
        activeConnections: [mockConnectionInfo],
      });

      const secondConn: ConnectionInfo = {
        ...mockConnectionInfo,
        id: "conn-2",
        profile_id: "profile-2",
        name: "Second Connection",
      };
      vi.mocked(api.connect).mockResolvedValue(secondConn);

      await useConnectionStore.getState().connect("profile-2");

      const state = useConnectionStore.getState();
      expect(state.activeConnections).toHaveLength(2);
      expect(state.activeConnections[0]).toEqual(mockConnectionInfo);
      expect(state.activeConnections[1]).toEqual(secondConn);
      expect(state.selectedConnectionId).toBe("conn-2");
    });
  });

  describe("disconnect", () => {
    it("disconnects and removes from activeConnections", async () => {
      useConnectionStore.setState({
        activeConnections: [mockConnectionInfo],
      });
      vi.mocked(api.disconnect).mockResolvedValue(undefined);

      await useConnectionStore.getState().disconnect("conn-1");

      expect(api.disconnect).toHaveBeenCalledWith("conn-1");
      expect(useConnectionStore.getState().activeConnections).toEqual([]);
    });

    it("sets selectedConnectionId to null when disconnecting the selected connection", async () => {
      useConnectionStore.setState({
        activeConnections: [mockConnectionInfo],
        selectedConnectionId: "conn-1",
      });
      vi.mocked(api.disconnect).mockResolvedValue(undefined);

      await useConnectionStore.getState().disconnect("conn-1");

      expect(useConnectionStore.getState().selectedConnectionId).toBeNull();
    });

    it("preserves selectedConnectionId when disconnecting a different connection", async () => {
      const secondConn: ConnectionInfo = {
        ...mockConnectionInfo,
        id: "conn-2",
        name: "Second Connection",
      };
      useConnectionStore.setState({
        activeConnections: [mockConnectionInfo, secondConn],
        selectedConnectionId: "conn-1",
      });
      vi.mocked(api.disconnect).mockResolvedValue(undefined);

      await useConnectionStore.getState().disconnect("conn-2");

      const state = useConnectionStore.getState();
      expect(state.activeConnections).toHaveLength(1);
      expect(state.activeConnections[0].id).toBe("conn-1");
      expect(state.selectedConnectionId).toBe("conn-1");
    });

    it("handles disconnect error", async () => {
      vi.mocked(api.disconnect).mockRejectedValue(new Error("Disconnect failed"));

      await useConnectionStore.getState().disconnect("conn-1");

      expect(useConnectionStore.getState().error).toBe("Error: Disconnect failed");
    });
  });

  describe("setSelectedConnection", () => {
    it("sets selectedConnectionId", () => {
      useConnectionStore.getState().setSelectedConnection("conn-1");
      expect(useConnectionStore.getState().selectedConnectionId).toBe("conn-1");
    });

    it("sets selectedConnectionId to null", () => {
      useConnectionStore.setState({ selectedConnectionId: "conn-1" });
      useConnectionStore.getState().setSelectedConnection(null);
      expect(useConnectionStore.getState().selectedConnectionId).toBeNull();
    });
  });

  describe("clearError", () => {
    it("clears the error state", () => {
      useConnectionStore.setState({ error: "Something went wrong" });
      useConnectionStore.getState().clearError();
      expect(useConnectionStore.getState().error).toBeNull();
    });
  });
});
