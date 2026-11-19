/**
 * Write text to the clipboard when the text may not be ready yet.
 *
 * The grid's copies wait for their values: a row source reads them on
 * demand, and over the backend's result store that is an IPC round trip
 * (docs/design/RESULT_STORE.md). Browsers allow a clipboard write only while
 * handling the click or key press that asked for it, and WebKit (the webview
 * on macOS and Linux) is strict about it: `writeText` called after an await
 * can be refused.
 *
 * `navigator.clipboard.write` with a `ClipboardItem` whose data is a promise
 * is made inside the gesture and filled in later, which is the pattern the
 * browsers that are strict about gestures accept. Where `ClipboardItem` is
 * missing, the text is awaited and written with `writeText`, as before.
 *
 * Only jsdom exercises this in tests; the behaviour in a real WebKit window
 * has not been checked.
 *
 * Call it synchronously from the event handler, before any await of your
 * own, and pass the text as a promise. The returned promise rejects if the
 * text does, and then nothing is written.
 */
export function writeClipboardText(text: string | Promise<string>): Promise<void> {
  const clipboard: Clipboard | undefined = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard) return Promise.reject(new Error("The clipboard is not available"));
  if (typeof ClipboardItem !== "undefined" && typeof clipboard.write === "function") {
    // A rejected `text` rejects the item, and the write with it.
    const data = Promise.resolve(text).then((t) => new Blob([t], { type: "text/plain" }));
    return clipboard.write([new ClipboardItem({ "text/plain": data })]);
  }
  return Promise.resolve(text).then((t) => clipboard.writeText(t));
}

/**
 * Thrown from inside the text a copy was given, to stop the copy with a
 * message for the user rather than an error: the write is abandoned and the
 * clipboard keeps what it had.
 */
export class CopyRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CopyRefused";
  }
}
