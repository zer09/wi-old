import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readCredentialStream } from "./credential-cli.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("credential CLI private input", () => {
  it("preserves valid UTF-8 split at every multibyte boundary", async () => {
    const expected = "ab😀cd";
    const bytes = Buffer.from(expected, "utf8");
    for (const split of [3, 4, 5]) {
      const stream = new PassThrough();
      const result = readCredentialStream(stream);
      stream.write(bytes.subarray(0, split));
      stream.end(bytes.subarray(split));
      await expect(result).resolves.toBe(expected);
    }
  });

  it("bounds original UTF-8 bytes at the exact private input limit", async () => {
    const exact = `${"a".repeat(16_380)}😀`;
    const accepted = new PassThrough();
    const acceptedResult = readCredentialStream(accepted);
    accepted.end(Buffer.from(exact, "utf8"));
    await expect(acceptedResult).resolves.toBe(exact);

    const oversized = new PassThrough();
    const oversizedResult = readCredentialStream(oversized);
    oversized.end(Buffer.from(`${exact}x`, "utf8"));
    await expect(oversizedResult).rejects.toThrow("API key exceeds the private input limit.");
  });

  it("rejects and destroys a descriptor stream that does not finish before the deadline", async () => {
    vi.useFakeTimers();
    const stream = new PassThrough();
    const result = readCredentialStream(stream, 25);
    const rejection = expect(result).rejects.toThrow("Credential input timed out.");
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(stream.destroyed).toBe(true);
  });
});
