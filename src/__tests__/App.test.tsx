import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "../App";

vi.mock("monaco-editor", () => ({}));

vi.mock("@monaco-editor/react", () => ({
  default: () => null,
}));

vi.mock("../lib/tauri-api", () => ({
  api: {
    executeQuery: vi.fn(),
    getDatabases: vi.fn(),
    getTables: vi.fn(),
    getColumns: vi.fn(),
    getIndexes: vi.fn(),
    getTableDdl: vi.fn(),
    getViews: vi.fn(),
    getRoutines: vi.fn(),
    getTriggers: vi.fn(),
    getViewDdl: vi.fn(),
    getRoutineDdl: vi.fn(),
    getTriggerDdl: vi.fn(),
    getProcessList: vi.fn(),
    getServerVariables: vi.fn(),
    killProcess: vi.fn(),
    saveConnectionProfile: vi.fn(),
    listConnectionProfiles: vi.fn(),
    deleteConnectionProfile: vi.fn(),
    testConnection: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    listConnections: vi.fn(),
    exportResults: vi.fn(),
    readFileContents: vi.fn(),
    pickFile: vi.fn(),
    writeFileContents: vi.fn(),
    pickSaveFile: vi.fn(),
    aiChat: vi.fn(),
    aiGetStatus: vi.fn(),
    aiSetConfig: vi.fn(),
    aiCancel: vi.fn(),
    aiApprovePermission: vi.fn(),
    getAppVersion: vi.fn(),
  },
}));

vi.mock("../components/layout/AppLayout", () => ({
  AppLayout: () => <div data-testid="app-layout">AppLayout mock</div>,
}));

describe("App", () => {
  it("renders AppLayout component", () => {
    render(<App />);
    expect(screen.getByTestId("app-layout")).toBeDefined();
    expect(screen.getByText("AppLayout mock")).toBeDefined();
  });

  it("renders without crashing", () => {
    const { container } = render(<App />);
    expect(container).toBeTruthy();
  });
});
