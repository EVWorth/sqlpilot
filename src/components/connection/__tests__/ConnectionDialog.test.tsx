import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionDialog } from "../ConnectionDialog";

vi.mock("../../stores/connectionStore", () => ({
  useConnectionStore: vi.fn((selector: (s: unknown) => unknown) => {
    return selector({ saveProfile: vi.fn().mockResolvedValue(undefined) });
  }),
}));

vi.mock("../../lib/tauri-api", () => ({
  api: { testConnection: vi.fn().mockResolvedValue({ success: true, message: "Connected", latency_ms: 12 }) },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ConnectionDialog", () => {
  it("returns null when isOpen is false", () => {
    const { container } = render(<ConnectionDialog isOpen={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders dialog when isOpen is true", () => {
    render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText("New Connection")).toBeInTheDocument();
  });

  it("shows 'Edit Connection' title when editing", () => {
    render(
      <ConnectionDialog
        isOpen={true}
        onClose={vi.fn()}
        editProfile={{
          id: "p1",
          name: "Existing DB",
          host: "db.example.com",
          port: 3306,
          username: "admin",
          pool_min: 1,
          pool_max: 5,
          read_only: false,
          created_at: "2023-01-01",
          updated_at: "2023-01-01",
        }}
      />,
    );
    expect(screen.getByText("Edit Connection")).toBeInTheDocument();
  });

  it("renders tab navigation (General, SSL, SSH, Advanced)", () => {
    render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText("General")).toBeInTheDocument();
    expect(screen.getByText("SSL")).toBeInTheDocument();
    expect(screen.getByText("SSH Tunnel")).toBeInTheDocument();
    expect(screen.getByText("Advanced")).toBeInTheDocument();
  });

  it("shows General tab by default with form fields", () => {
    render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Host")).toBeInTheDocument();
  });

  it("populates form with default values", () => {
    render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByDisplayValue("127.0.0.1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("3306")).toBeInTheDocument();
  });

  it("switches to SSL tab", () => {
    render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("SSL"));
    expect(screen.getByText("SSL Mode")).toBeInTheDocument();
  });

  it("switches to SSH tab", () => {
    render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("SSH Tunnel"));
    expect(screen.getByText("Enable SSH Tunnel")).toBeInTheDocument();
  });

  it("switches to Advanced tab", () => {
    render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Advanced"));
    expect(screen.getByText("Read-only mode")).toBeInTheDocument();
  });

  it("renders Test Connection button", () => {
    render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText("Test Connection")).toBeInTheDocument();
  });

  it("renders Save button", () => {
    render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText("Save")).toBeInTheDocument();
  });

  it("renders color picker section", () => {
    render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText("Color")).toBeInTheDocument();
  });

  it("renders Environment select dropdown", () => {
    render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText("Environment")).toBeInTheDocument();
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(<ConnectionDialog isOpen={true} onClose={onClose} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when X button is clicked", () => {
    const onClose = vi.fn();
    render(<ConnectionDialog isOpen={true} onClose={onClose} />);
    const buttons = document.querySelectorAll("button");
    for (const btn of buttons) {
      if (btn.querySelector(".lucide-x")) {
        fireEvent.click(btn);
        break;
      }
    }
    expect(onClose).toHaveBeenCalled();
  });

  it("shows pool settings on Advanced tab", () => {
    render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Advanced"));
    expect(screen.getByText("Pool Min Connections")).toBeInTheDocument();
    expect(screen.getByText("Pool Max Connections")).toBeInTheDocument();
  });

  it("shows SSH auth toggle when SSH is enabled", () => {
    render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("SSH Tunnel"));
    const enableCheckbox = screen.getByRole("checkbox");
    fireEvent.click(enableCheckbox);
    expect(screen.getByText("Password")).toBeInTheDocument();
    expect(screen.getByText("Key File")).toBeInTheDocument();
  });

  describe("form fields", () => {
    it("updates Host field", () => {
      render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
      const hostInput = screen.getByDisplayValue("127.0.0.1");
      fireEvent.change(hostInput, { target: { value: "10.0.0.1" } });
      expect(screen.getByDisplayValue("10.0.0.1")).toBeInTheDocument();
    });

    it("updates Username field", () => {
      render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
      const userInput = screen.getByDisplayValue("root");
      fireEvent.change(userInput, { target: { value: "adminuser" } });
      expect(screen.getByDisplayValue("adminuser")).toBeInTheDocument();
    });

    it("populates edit profile values", () => {
      render(
        <ConnectionDialog
          isOpen={true}
          onClose={vi.fn()}
          editProfile={{
            id: "p1",
            name: "Existing DB",
            host: "db.example.com",
            port: 5432,
            username: "dbadmin",
            password: "secret",
            default_database: "mydb",
            pool_min: 3,
            pool_max: 10,
            read_only: true,
            created_at: "2023-01-01",
            updated_at: "2023-01-01",
          }}
        />,
      );
      expect(screen.getByDisplayValue("Existing DB")).toBeInTheDocument();
      expect(screen.getByDisplayValue("db.example.com")).toBeInTheDocument();
      expect(screen.getByDisplayValue("5432")).toBeInTheDocument();
      expect(screen.getByDisplayValue("dbadmin")).toBeInTheDocument();
    });
  });

  describe("SSL tab", () => {
    it("shows CA certificate, client cert, client key when mode is not Disabled", () => {
      render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
      fireEvent.click(screen.getByText("SSL"));
      const sslSelect = screen.getByRole("combobox");
      fireEvent.change(sslSelect, { target: { value: "Required" } });
      expect(screen.getByText("CA Certificate")).toBeInTheDocument();
      expect(screen.getByText("Client Certificate")).toBeInTheDocument();
      expect(screen.getByText("Client Key")).toBeInTheDocument();
    });

    it("shows warning for VerifyCA/VerifyIdentity without CA cert", () => {
      render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
      fireEvent.click(screen.getByText("SSL"));
      const sslSelect = screen.getByRole("combobox");
      fireEvent.change(sslSelect, { target: { value: "VerifyCA" } });
      expect(screen.getByText(/CA certificate is required/)).toBeInTheDocument();
    });
  });

  describe("SSH tab", () => {
    it("shows SSH fields when enabled", () => {
      render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
      fireEvent.click(screen.getByText("SSH Tunnel"));
      fireEvent.click(screen.getByRole("checkbox"));
      expect(screen.getByText("SSH Host")).toBeInTheDocument();
      expect(screen.getByText("SSH Port")).toBeInTheDocument();
      expect(screen.getByText("SSH Username")).toBeInTheDocument();
    });

    it("shows SSH password field when password auth selected", () => {
      render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
      fireEvent.click(screen.getByText("SSH Tunnel"));
      fireEvent.click(screen.getByRole("checkbox"));
      expect(screen.getByText("SSH Password")).toBeInTheDocument();
    });

    it("switches to key file auth and shows key fields", () => {
      render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
      fireEvent.click(screen.getByText("SSH Tunnel"));
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByText("Key File"));
      expect(screen.getByText("Private Key File")).toBeInTheDocument();
      expect(screen.getByText("Passphrase")).toBeInTheDocument();
    });
  });

  describe("advanced tab", () => {
    it("toggles read-only mode", () => {
      render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
      fireEvent.click(screen.getByText("Advanced"));
      const readOnlyCheckbox = screen.getByLabelText("Read-only mode") as HTMLInputElement;
      expect(readOnlyCheckbox).not.toBeChecked();
      fireEvent.click(readOnlyCheckbox);
      expect(readOnlyCheckbox).toBeChecked();
    });

    it("shows pool min/max input fields", () => {
      render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
      fireEvent.click(screen.getByText("Advanced"));
      expect(screen.getByDisplayValue("1")).toBeInTheDocument();
      expect(screen.getByDisplayValue("5")).toBeInTheDocument();
    });
  });

  describe("color picker", () => {
    it("renders color buttons for preset colors", () => {
      render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
      const colorBtns = document.querySelectorAll("[title=\"#3B82F6\"]");
      expect(colorBtns.length).toBeGreaterThan(0);
    });

    it("shows Clear button when color is selected", () => {
      render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
      const colorBtn = document.querySelector("[title=\"#F97316\"]");
      if (colorBtn) fireEvent.click(colorBtn);
      expect(screen.getByText("Clear")).toBeInTheDocument();
    });
  });

  describe("environment select", () => {
    it("has None option by default", () => {
      render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
      expect(screen.getByText("None")).toBeInTheDocument();
      expect(screen.getByText("Development")).toBeInTheDocument();
      expect(screen.getByText("Staging")).toBeInTheDocument();
      expect(screen.getByText("Production")).toBeInTheDocument();
    });
  });

  it("save button is disabled without name", () => {
    render(<ConnectionDialog isOpen={true} onClose={vi.fn()} />);
    const saveBtn = screen.getByText("Save");
    expect(saveBtn.closest("button")?.disabled).toBe(true);
  });
});
