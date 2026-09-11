import { describe, expect, it } from "vitest";
import { dataUri, decodeUtf8, describeBlob, detectMime, formatBytes, hexDump, isBytes, looksLikeText } from "../blob";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
const GIF = [...Array.from("GIF89a", (c) => c.charCodeAt(0)), 0x01];
const utf8 = (s: string) => [...new TextEncoder().encode(s)];

describe("blob (#401)", () => {
  describe("isBytes", () => {
    it("recognises the array the backend sends for a BLOB", () => {
      expect(isBytes([1, 2, 3])).toBe(true);
      expect(isBytes([])).toBe(true);
    });

    it("does not mistake an array of something else for bytes", () => {
      expect(isBytes(["a"])).toBe(false);
      expect(isBytes("abc")).toBe(false);
      expect(isBytes(null)).toBe(false);
    });
  });

  describe("detectMime", () => {
    it.each([
      ["PNG", PNG, "image/png"],
      ["JPEG", JPEG, "image/jpeg"],
      ["GIF", GIF, "image/gif"],
      ["BMP", [0x42, 0x4d, 0x00], "image/bmp"],
      ["ICO", [0x00, 0x00, 0x01, 0x00, 0x01], "image/x-icon"],
    ])("recognises a %s by its magic bytes", (_name, bytes, mime) => {
      expect(detectMime(bytes)).toBe(mime);
    });

    it("recognises a WebP past its length field", () => {
      const webp = [...utf8("RIFF"), 0, 0, 0, 0, ...utf8("WEBP"), 1];
      expect(detectMime(webp)).toBe("image/webp");
    });

    it("recognises an SVG, which has no magic number", () => {
      expect(detectMime(utf8("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")))
        .toBe("image/svg+xml");
      expect(detectMime(utf8("<?xml version=\"1.0\"?><svg viewBox=\"0 0 1 1\"/>")))
        .toBe("image/svg+xml");
    });

    it("does not call arbitrary XML an SVG", () => {
      expect(detectMime(utf8("<?xml version=\"1.0\"?><root/>"))).toBeNull();
    });

    it("says nothing rather than guessing", () => {
      // Claiming a MIME an <img> cannot render offers a broken-icon preview,
      // which is worse than offering none.
      expect(detectMime(utf8("hello world"))).toBeNull();
      expect(detectMime([])).toBeNull();
    });

    it("does not match a signature longer than the data", () => {
      expect(detectMime([0x89, 0x50])).toBeNull();
    });
  });

  describe("formatBytes", () => {
    it("keeps whole bytes whole", () => {
      expect(formatBytes(0)).toBe("0 B");
      expect(formatBytes(512)).toBe("512 B");
    });

    it("scales up with one decimal", () => {
      expect(formatBytes(1024)).toBe("1.0 KB");
      expect(formatBytes(1536)).toBe("1.5 KB");
      expect(formatBytes(1024 * 1024 * 3)).toBe("3.0 MB");
      expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    });

    it("stops at the largest unit it knows", () => {
      expect(formatBytes(1024 ** 4)).toBe("1024.0 GB");
    });
  });

  describe("decodeUtf8", () => {
    it("decodes text", () => {
      expect(decodeUtf8(utf8("héllo ☃"))).toBe("héllo ☃");
    });

    it("marks a bad byte instead of refusing the whole value", () => {
      // A BLOB that is mostly text with one stray byte should still be
      // readable.
      expect(decodeUtf8([0x61, 0xff, 0x62])).toBe("a�b");
    });
  });

  describe("looksLikeText", () => {
    it("accepts text, including tabs and newlines", () => {
      expect(looksLikeText(utf8("hello\tworld\r\nsecond line"))).toBe(true);
    });

    it("rejects compiled data", () => {
      expect(looksLikeText(PNG)).toBe(false);
      expect(looksLikeText(Array.from({ length: 200 }, (_, i) => i % 256))).toBe(false);
    });

    it("rejects nothing at all", () => {
      expect(looksLikeText([])).toBe(false);
    });
  });

  describe("hexDump", () => {
    it("lays out sixteen bytes to a line with their printable form", () => {
      const [line] = hexDump(utf8("Hello, world!"));
      expect(line.offset).toBe(0);
      expect(line.hex.startsWith("48 65 6c 6c 6f 2c 20 77 6f 72 6c 64 21")).toBe(true);
      expect(line.ascii).toBe("Hello, world!");
    });

    it("pads a short last line so the columns stay aligned", () => {
      const lines = hexDump(utf8("ab"));
      expect(lines[0].hex).toHaveLength(16 * 3 - 1);
    });

    it("stands in for unprintable bytes", () => {
      expect(hexDump([0x00, 0x1f, 0x41, 0x7f])[0].ascii).toBe("..A.");
    });

    it("counts offsets in bytes", () => {
      const lines = hexDump(Array.from({ length: 40 }, () => 0x41));
      expect(lines.map((l) => l.offset)).toEqual([0, 16, 32]);
    });

    it("stops at the limit rather than building a line per sixteen bytes of a 50 MB value", () => {
      const lines = hexDump(Array.from({ length: 100_000 }, () => 0), 64);
      expect(lines).toHaveLength(4);
    });
  });

  describe("dataUri", () => {
    it("base64-encodes the bytes under the given type", () => {
      expect(dataUri(utf8("hi"), "image/png")).toBe("data:image/png;base64,aGk=");
    });

    it("survives a value too large to spread into one call", () => {
      // String.fromCharCode(...megabytes) overflows the call stack.
      const big = Array.from({ length: 200_000 }, () => 0x41);
      expect(() => dataUri(big, "image/png")).not.toThrow();
    });
  });

  describe("describeBlob", () => {
    it("names the type when it knows it", () => {
      expect(describeBlob(PNG)).toBe("image/png, 10 B");
    });

    it("says only the size when it does not", () => {
      expect(describeBlob(utf8("hello"))).toBe("BLOB, 5 B");
    });
  });
});
