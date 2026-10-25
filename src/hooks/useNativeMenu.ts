import { useEffect, useMemo } from "react";
import { actionById, type ActionContext, isEnabled, MENUS } from "../lib/actions";
import type { NativeMenu, NativeMenuEntry } from "../lib/bindings";
import { api } from "../lib/tauri-api";
import { useConnectionStore } from "../stores/connectionStore";
import { useActionContext } from "./useActionContext";

const isMac = navigator.platform.toLowerCase().includes("mac");

/** A saved profile, as far as the "Connect to" list needs one. */
interface MenuProfile {
  id: string;
  name: string;
  host: string;
}

/**
 * A shortcut from `actions.ts` in Tauri's accelerator syntax.
 *
 * The actions are written as Windows and Linux show them ("Ctrl+T"); on macOS
 * the same binding is Command, which `CmdOrCtrl` means there.
 */
export function toAccelerator(shortcut: string | undefined): string | null {
  if (!shortcut) return null;
  return shortcut.replace(/^Ctrl\+/, "CmdOrCtrl+");
}

/**
 * The native menu bar, described from the same `MENUS` and `ACTIONS` the
 * in-app menu bar renders (#892), with the saved profiles under Connection →
 * Connect to (#863). Profiles that are open or opening are disabled, and an
 * empty list says so, as in the in-app menu.
 */
export function buildNativeMenu(
  context: ActionContext,
  profiles: MenuProfile[],
  openProfileIds: ReadonlySet<string>,
  connecting: readonly string[],
): NativeMenu[] {
  return MENUS.map((menu) => ({
    label: menu.label,
    entries: menu.entries.flatMap((entry): NativeMenuEntry[] => {
      if (entry.type === "separator") return [{ type: "separator" }];
      if (entry.type === "connect-to") {
        const items: NativeMenuEntry[] = profiles.length === 0
          ? [{ type: "item", id: "connect:none", label: "No saved connections", accelerator: null, enabled: false }]
          : profiles.map((profile) => {
            const opening = connecting.includes(profile.id);
            const name = profile.name || profile.host;
            return {
              type: "item",
              id: `connect:${profile.id}`,
              label: opening ? `${name} (connecting…)` : name,
              accelerator: null,
              enabled: !openProfileIds.has(profile.id) && !opening,
            };
          });
        return [{ type: "submenu", label: "Connect to", enabled: true, entries: items }];
      }
      const action = actionById(entry.id);
      if (!action) return [];
      return [{
        type: "item",
        id: action.id,
        label: action.label,
        accelerator: toAccelerator(action.shortcut),
        enabled: isEnabled(action, context),
      }];
    }),
  }));
}

/**
 * Keep the macOS menu bar in step with the app: rebuilt whenever what it
 * shows changes. Does nothing elsewhere, where the in-app menu bar is used.
 */
export function useNativeMenu(enabled: boolean = isMac): void {
  const { connected } = useActionContext();
  const profiles = useConnectionStore((s) => s.profiles);
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const connecting = useConnectionStore((s) => s.connecting);

  // Serialised so a store update that changes nothing the menu shows does
  // not rebuild it.
  const description = useMemo(
    () =>
      JSON.stringify(
        buildNativeMenu(
          { connected },
          profiles,
          new Set(activeConnections.map((c) => c.profile_id)),
          connecting,
        ),
      ),
    [connected, profiles, activeConnections, connecting],
  );

  useEffect(() => {
    if (!enabled) return;
    api.setNativeMenu(JSON.parse(description) as NativeMenu[]).catch((error: unknown) => {
      // The previous menu stays up; nothing the user does is lost by it.
      console.warn("Could not update the native menu", error);
    });
  }, [enabled, description]);
}
