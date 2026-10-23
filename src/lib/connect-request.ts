/**
 * Ask the app to connect to a saved profile, or to open the New Connection
 * dialog, from anywhere: the menu bar, the palette, the sidebar.
 *
 * `ConnectionTabs` owns the connect flow — the placeholder tab, the new editor
 * tab, the failure panel — so everything else asks it rather than repeating
 * that flow (#817). Same route as the existing `open-new-connection` event.
 */

export const CONNECT_PROFILE_EVENT = "connect-profile";
export const NEW_CONNECTION_EVENT = "open-new-connection";

export function requestConnect(profileId: string): void {
  window.dispatchEvent(new CustomEvent<string>(CONNECT_PROFILE_EVENT, { detail: profileId }));
}

export function requestNewConnection(): void {
  window.dispatchEvent(new CustomEvent(NEW_CONNECTION_EVENT));
}
