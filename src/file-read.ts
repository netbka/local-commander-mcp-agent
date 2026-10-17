import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PathGuard } from "./guard.js";
import { readWindowsFilePrefix } from "./windows-file-read.js";

export async function readFilePrefix(guard: PathGuard, inputPath: string, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16777216) throw new Error("FILE_READ_LIMIT_INVALID");
  const filePath = await guard.resolveExisting(inputPath);
  guard.assertSafeFile(filePath);
  if (process.platform === "win32") {
    const bridge = fileURLToPath(new URL("../release/personal/OwnerBridge.exe", import.meta.url));
    return { path: filePath, ...await readWindowsFilePrefix(bridge, filePath, maxBytes) };
  }
  // POSIX keeps the existing path boundary; O_NOFOLLOW alone does not protect parent races.
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Not a file: ${filePath}`);
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    return { path: filePath, data: buffer.subarray(0, count), size: info.size, modifiedAt: info.mtime.toISOString(), truncated: info.size > maxBytes };
  } finally { await handle.close(); }
}
