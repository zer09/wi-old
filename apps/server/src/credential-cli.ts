import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

import { CredentialProvisioner, initializeCredentialRoots } from "@wi/credentials";

const MAXIMUM_INPUT_BYTES = 16_384;
export const CREDENTIAL_INPUT_TIMEOUT_MS = 30_000;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

export function readCredentialStream(
  stream: Readable,
  timeoutMs = CREDENTIAL_INPUT_TIMEOUT_MS,
): Promise<string> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CREDENTIAL_INPUT_TIMEOUT_MS) {
    return Promise.reject(new RangeError("Credential input timeout is outside the allowed range."));
  }
  return new Promise((resolve, reject) => {
    let value = "";
    let bytes = 0;
    let settled = false;
    const decoder = new StringDecoder("utf8");
    const finish = (error?: Error, flush = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) {
        if (flush) value += decoder.end();
        resolve(value);
      } else reject(error);
    };
    const timer = setTimeout(() => {
      stream.destroy();
      finish(new Error("Credential input timed out."));
    }, timeoutMs);
    timer.unref();
    stream.on("data", (chunk: string | Buffer) => {
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
      if (bytes > MAXIMUM_INPUT_BYTES) {
        stream.destroy();
        finish(new Error("API key exceeds the private input limit."));
        return;
      }
      value += typeof chunk === "string" ? chunk : decoder.write(chunk);
    });
    stream.once("end", () => finish(undefined, true));
    stream.once("error", (error: Error) => finish(error));
  });
}

function readDescriptor(fd: number): Promise<string> {
  return readCredentialStream(createReadStream("", {
    fd,
    autoClose: false,
    encoding: "utf8",
    highWaterMark: 4_096,
  }));
}

async function readMaskedStdin(): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Masked stdin requires a TTY; use --api-key-fd with an already-open descriptor.");
  }
  process.stderr.write("API key: ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error): void => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stderr.write("\n");
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish(new Error("Credential provisioning cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
        if (Buffer.byteLength(value, "utf8") > MAXIMUM_INPUT_BYTES) {
          finish(new Error("API key exceeds the private input limit."));
          return;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const providerId = argument("--provider") ?? "openai_platform";
  const authMode = argument("--auth-mode") ?? "api_key";
  const descriptorText = argument("--api-key-fd");
  let apiKey: string;
  if (descriptorText === undefined) {
    apiKey = await readMaskedStdin();
  } else {
    const descriptor = Number(descriptorText);
    if (!Number.isSafeInteger(descriptor) || descriptor < 3) {
      throw new Error("--api-key-fd must name an already-open descriptor of 3 or greater.");
    }
    apiKey = await readDescriptor(descriptor);
  }
  apiKey = apiKey.replace(/[\r\n]+$/u, "");
  const wiHome = process.env.WI_HOME ?? `${process.env.HOME ?? ""}/.wi`;
  const roots = await initializeCredentialRoots({
    wiHome,
    ...(process.env.XDG_STATE_HOME === undefined
      ? {}
      : { xdgStateHome: process.env.XDG_STATE_HOME }),
  });
  const result = await new CredentialProvisioner(roots.stagingRoot).stageApiKey(
    providerId,
    authMode,
    apiKey,
  );
  // This output is intentionally nonsecret and safe to paste into the browser command.
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Credential provisioning failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
