import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SERVER_KEY = "local-commander";
const PACKAGE_SPEC = "local-commander-mcp-agent@latest";
const CLIENTS = ["claude-desktop", "cursor"] as const;
type Client = (typeof CLIENTS)[number];

const USAGE = [
  "Usage: local-commander-mcp-agent setup --root <folder> [--root <folder> ...] [--client claude-desktop|cursor|all] [--dry-run]",
  "       local-commander-mcp-agent setup --remove [--client claude-desktop|cursor|all] [--dry-run]"
].join("\n");

export function clientConfigPath(client: Client, platform: NodeJS.Platform = process.platform, env = process.env, home = os.homedir()): string {
  if (client === "cursor") return path.join(home, ".cursor", "mcp.json");
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude", "claude_desktop_config.json");
}

export function serverEntry(roots: string[], platform: NodeJS.Platform = process.platform) {
  const args = ["-y", PACKAGE_SPEC, "--stdio", ...roots];
  // Windows clients cannot start npx.cmd without a command shell.
  return platform === "win32" ? { command: "cmd", args: ["/c", "npx", ...args] } : { command: "npx", args };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function runSetup(args: string[]): Promise<number> {
  const roots: string[] = [];
  let clients: Client[] = ["claude-desktop"];
  let remove = false;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--root" || arg === "--client") {
      const value = args[index + 1];
      index += 1;
      if (!value) {
        console.error(`${arg} needs a value.\n${USAGE}`);
        return 2;
      }
      if (arg === "--root") {
        roots.push(path.resolve(value));
      } else if (value === "all") {
        clients = [...CLIENTS];
      } else if ((CLIENTS as readonly string[]).includes(value)) {
        clients = [value as Client];
      } else {
        console.error(`Unknown client "${value}".\n${USAGE}`);
        return 2;
      }
    } else if (arg === "--remove") {
      remove = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      return 0;
    } else {
      console.error(`Unknown argument "${arg}".\n${USAGE}`);
      return 2;
    }
  }

  if (!remove && roots.length === 0) {
    console.error(`Choose at least one folder the server may access with --root.\n${USAGE}`);
    return 2;
  }
  for (const root of roots) {
    const info = await stat(root).catch(() => undefined);
    if (!info?.isDirectory()) {
      console.error(`Not a folder: ${root}`);
      return 2;
    }
    if (process.platform === "win32" && /[&|<>^%!"]/.test(root)) {
      console.error(`Folder paths with & | < > ^ % ! or quotes cannot be passed through cmd: ${root}`);
      return 2;
    }
  }

  const entry = serverEntry(roots);
  for (const client of clients) {
    const file = clientConfigPath(client);
    let config: Record<string, unknown> = {};
    if (existsSync(file)) {
      try {
        const parsed: unknown = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
        if (!isPlainObject(parsed)) throw new Error("not a JSON object");
        config = parsed;
      } catch (error) {
        console.error(`Cannot read ${file} (${error instanceof Error ? error.message : String(error)}); it was not changed.`);
        return 1;
      }
    }
    const servers = config.mcpServers ?? {};
    if (!isPlainObject(servers)) {
      console.error(`"mcpServers" in ${file} is not an object; it was not changed.`);
      return 1;
    }
    const next = { ...servers };
    if (remove) {
      if (!(SERVER_KEY in next)) {
        console.log(`${client}: ${SERVER_KEY} is not configured in ${file}.`);
        continue;
      }
      delete next[SERVER_KEY];
    } else {
      next[SERVER_KEY] = entry;
    }
    if (dryRun) {
      console.log(`[dry-run] ${client}: ${file}`);
      console.log(JSON.stringify(remove ? { remove: SERVER_KEY } : { [SERVER_KEY]: entry }, null, 2));
      continue;
    }
    await mkdir(path.dirname(file), { recursive: true });
    let backup = "";
    if (existsSync(file)) {
      backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await copyFile(file, backup);
    }
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...config, mcpServers: next }, null, 2) + "\n");
    await rename(temporary, file);
    console.log(`${remove ? "Removed" : "Configured"} ${SERVER_KEY} for ${client}: ${file}${backup ? ` (backup: ${backup})` : ""}`);
  }
  if (!dryRun) console.log("Restart the client to load the change.");
  return 0;
}
