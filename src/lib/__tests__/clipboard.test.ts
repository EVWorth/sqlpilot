import { CopyRefused, writeClipboardText } from "@/lib/clipboard";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `writeClipboardText` starts the write inside the gesture where the browser
 * offers `ClipboardItem`, and falls back to `writeText` once the text is
 * ready where it does not. jsdom has neither, so both are stubbed.
 */

const original = { clipboard: navigator.clipboard, item: (globalThis as { ClipboardItem?: unknown }).ClipboardItem };

function stubClipboard(withItem: boolean) {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const write = vi.fn(async (items: { data: Record<string, Promise<Blob>> }[]) => {
    // A real browser waits for the item's data, and fails if it does.
    await Promise.all(items.flatMap((i) => Object.values(i.data)));
  });
  Object.defineProperty(navigator, "clipboard", { value: { writeText, write }, configurable: true });
  if (withItem) {
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = class {
      constructor(readonly data: Record<string, Promise<Blob>>) {}
    };
  } else {
    delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
  }
  return { writeText, write };
}

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: original.clipboard, configurable: true });
  (globalThis as { ClipboardItem?: unknown }).ClipboardItem = original.item;
});

describe("writeClipboardText", () => {
  it("starts a ClipboardItem write at once, before the text is ready", async () => {
    const { write, writeText } = stubClipboard(true);
    let finish!: (text: string) => void;
    const pending = writeClipboardText(new Promise<string>((resolve) => (finish = resolve)));

    // Called synchronously: this is what keeps it inside the user's gesture.
    expect(write).toHaveBeenCalledTimes(1);
    finish("a\tb");
    await pending;

    const [[items]] = write.mock.calls;
    const blob = await (items[0] as { data: Record<string, Promise<Blob>> }).data["text/plain"];
    expect(await blob.text()).toBe("a\tb");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to writeText once the text is ready where ClipboardItem is missing", async () => {
    const { write, writeText } = stubClipboard(false);
    await writeClipboardText(Promise.resolve("x"));
    expect(writeText).toHaveBeenCalledWith("x");
    expect(write).not.toHaveBeenCalled();
  });

  it("writes nothing, and rejects, when the text fails", async () => {
    const { writeText } = stubClipboard(false);
    await expect(writeClipboardText(Promise.reject(new CopyRefused("no table")))).rejects.toBeInstanceOf(
      CopyRefused,
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it("rejects a ClipboardItem write whose text fails", async () => {
    stubClipboard(true);
    await expect(writeClipboardText(Promise.reject(new Error("source failed")))).rejects.toThrow("source failed");
  });
});
