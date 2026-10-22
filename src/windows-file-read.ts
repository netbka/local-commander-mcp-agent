import { execFile } from "node:child_process";
import path from "node:path";
import { buildChildEnvironment } from "./child-environment.js";

/** Read only an already-authorized canonical path, using the helper's same-handle check. */
export function readWindowsFile(bridge: string, file: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  return invokeRead(bridge, file, maxBytes, false, signal);
}

export async function readWindowsFilePrefix(bridge: string, file: string, maxBytes: number, signal?: AbortSignal): Promise<{
  data: Buffer; size: number; modifiedAt: string; truncated: boolean;
}> {
  const output = await invokeRead(bridge, file, maxBytes, true, signal);
  try {
    const value = JSON.parse(output.toString("utf8"));
    if (!value || Object.keys(value).length !== 4 || typeof value.data !== "string" ||
        !Number.isSafeInteger(value.size) || value.size < 0 || typeof value.modifiedAt !== "string" ||
        new Date(value.modifiedAt).toISOString() !== value.modifiedAt || value.truncated !== (value.size > maxBytes)) throw Error();
    const data = Buffer.from(value.data, "base64");
    if (data.toString("base64") !== value.data || data.length !== Math.min(value.size, maxBytes)) throw Error();
    return { data, size: value.size, modifiedAt: value.modifiedAt, truncated: value.truncated };
  } catch { throw new Error("FILE_READ_FAILED"); }
}

/** Read up to 64 already-authorized canonical paths in one helper process. Each file gets read-file's
 * same-handle checks and its own result: the bytes, or the helper's code for that file. */
export function readWindowsFiles(bridge: string, files: readonly string[], maxBytes: number, maxTotalBytes: number, signal?: AbortSignal): Promise<({ data: Buffer } | { code: string })[]> {
  const input = JSON.stringify({ paths: files });
  if (process.platform !== "win32" || !path.isAbsolute(bridge) || files.length < 1 || files.length > 64 || files.some(file => !path.isAbsolute(file)) ||
      Buffer.byteLength(input) > 300000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576 ||
      !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > 16777216) {
    return Promise.reject(new Error("FILE_READ_ARGUMENT_INVALID"));
  }
  if (signal?.aborted) return Promise.reject(new Error("CANCELLED"));
  return new Promise((resolve, reject) => {
    const child = execFile(bridge, ["read-files", String(maxBytes), String(maxTotalBytes)], {
      encoding: "buffer", timeout: 30000, maxBuffer: Math.ceil(maxTotalBytes / 3) * 4 + files.length * 64 + 512, windowsHide: true,
      shell: false, env: buildChildEnvironment(process.env, "win32"), signal
    }, (error, stdout) => {
      if (error) return reject(new Error(signal?.aborted ? "CANCELLED" : "FILE_READ_FAILED"));
      try {
        // Exactly one line per requested path, in order; anything else is a helper failure.
        const lines = stdout.toString("utf8").split("\n"); if (lines.pop() !== "" || lines.length !== files.length) throw Error();
        let total = 0;
        resolve(lines.map(line => {
          const value = JSON.parse(line); if (!value || Object.keys(value).length !== 1) throw Error();
          if (/^(ENOENT|FILE_CHANGED|FILE_UNSUPPORTED_OR_TOO_LARGE|PATH_INVALID|ACCESS_DENIED|IO_FAILED)$/.test(value.error)) return { code: value.error as string };
          if (typeof value.data !== "string") throw Error();
          const data = Buffer.from(value.data, "base64");
          if (data.toString("base64") !== value.data || data.length > maxBytes || (total += data.length) > maxTotalBytes) throw Error();
          return { data };
        }));
      } catch { reject(new Error("FILE_READ_FAILED")); }
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(input);
  });
}

function invokeRead(bridge: string, file: string, maxBytes: number, prefix: boolean, signal?: AbortSignal): Promise<Buffer> {
  if (process.platform !== "win32" || !path.isAbsolute(bridge) || !path.isAbsolute(file) ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > (prefix ? 16777216 : 1048576)) {
    return Promise.reject(new Error("FILE_READ_ARGUMENT_INVALID"));
  }
  if (signal?.aborted) return Promise.reject(new Error("CANCELLED"));
  return new Promise((resolve, reject) => {
    // One hidden helper per file; search batches through readWindowsFiles (one helper per file cost 18-20 s per 300 files).
    const child = execFile(bridge, prefix ? ["read-prefix", String(maxBytes)] : ["read-file"], {
      encoding: "buffer", timeout: 10000, maxBuffer: prefix ? Math.ceil(maxBytes / 3) * 4 + 512 : 1048576, windowsHide: true,
      shell: false, env: buildChildEnvironment(process.env, "win32"), signal
    }, (error, stdout, stderr) => {
      if (error) {
        const code = signal?.aborted ? "CANCELLED" :
          /^\{"error":"(ENOENT|FILE_CHANGED|FILE_UNSUPPORTED_OR_TOO_LARGE|PATH_INVALID|ACCESS_DENIED|IO_FAILED)"\}$/.exec(stderr.toString("utf8"))?.[1] ?? "FILE_READ_FAILED";
        reject(Object.assign(new Error(code), { code }));
      } else if (!prefix && stdout.length > maxBytes) {
        reject(new Error("FILE_UNSUPPORTED_OR_TOO_LARGE"));
      } else resolve(stdout);
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(JSON.stringify({ path: file }));
  });
}
