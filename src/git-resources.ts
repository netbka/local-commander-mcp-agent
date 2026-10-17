import { lstat } from "node:fs/promises";
import path from "node:path";
import { readFilePrefix } from "./file-read.js";
import type { PathGuard } from "./guard.js";

async function statIfPresent(filename: string) {
  try { return await lstat(filename); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return null; }
}

async function metadataText(guard: PathGuard, filename: string): Promise<string> {
  const file = await readFilePrefix(guard, filename, 4096);
  if (file.truncated) throw new Error("GIT_METADATA_INVALID");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(file.data).replace(/\r?\n$/, "");
  if (!text || /[\0\r\n]/.test(text)) throw new Error("GIT_METADATA_INVALID");
  return text;
}

async function metadataPaths(guard: PathGuard, marker: string): Promise<string[]> {
  if ((await lstat(marker)).isSymbolicLink()) throw new Error("GIT_METADATA_INVALID");
  const canonical = await guard.resolveExisting(marker);
  let gitDir = canonical;
  if (!(await lstat(canonical)).isDirectory()) {
    const text = await metadataText(guard, canonical);
    if (!text.startsWith("gitdir: ") || text.length === 8) throw new Error("GIT_METADATA_INVALID");
    gitDir = await guard.resolveDirectory(path.resolve(path.dirname(canonical), text.slice(8)));
  }
  const commonFile = path.join(gitDir, "commondir");
  // Check authority before reading a pointer's target; a broken pointer must not fall back to an ancestor.
  const common = await statIfPresent(commonFile)
    ? await guard.resolveDirectory(path.resolve(gitDir, await metadataText(guard, commonFile))) : gitDir;
  return [gitDir, common];
}

/** Known, approved resources only; scripts, aliases, hooks and config-driven paths are not a sandbox. */
export async function gitResourcePaths(guard: PathGuard, cwd: string, args: readonly string[] = []): Promise<string[]> {
  let effectiveCwd = cwd, gitDir: string | undefined, worktree: string | undefined;
  const targets: string[] = [];
  // ponytail: parse only Git's global target options; no speculative per-command effect inference.
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) break;
    if (arg === "-C") {
      const target = args[++index];
      if (target === undefined) throw new Error("GIT_TARGET_INVALID");
      if (target) {
        let descended = false;
        for (const part of target.split(/[\\/]/)) {
          if (part === ".." && descended) throw new Error("GIT_TARGET_AMBIGUOUS");
          if (part && part !== "." && part !== "..") descended = true;
        }
        const candidate = path.resolve(effectiveCwd, target);
        const canonical = await guard.resolveDirectory(candidate);
        // Git for Windows retains a junction's logical cwd during parent discovery and later -C.
        // Reject that ambiguity instead of claiming the wrong repository; canonical targets work.
        if (!guard.isWithin(candidate, canonical) || !guard.isWithin(canonical, candidate)) throw new Error("GIT_TARGET_AMBIGUOUS");
        effectiveCwd = canonical;
      }
      targets.push(effectiveCwd);
    } else if (arg === "--git-dir" || arg.startsWith("--git-dir=")) {
      gitDir = arg === "--git-dir" ? args[++index] : arg.slice(10);
      if (!gitDir) throw new Error("GIT_TARGET_INVALID");
    } else if (arg === "--work-tree" || arg.startsWith("--work-tree=")) {
      worktree = arg === "--work-tree" ? args[++index] : arg.slice(12);
      if (!worktree) throw new Error("GIT_TARGET_INVALID");
    } else if (arg === "--bare") {
      // Git preserves an explicit GIT_DIR, otherwise uses this cwd before any later -C.
      gitDir ??= effectiveCwd;
    } else if (arg === "-c" || arg === "--namespace" || arg === "--config-env") {
      if (args[++index] === undefined) throw new Error("GIT_TARGET_INVALID");
    }
  }
  if (worktree) targets.push(await guard.resolveDirectory(path.resolve(effectiveCwd, worktree)));
  if (gitDir) return [...targets, ...await metadataPaths(guard, path.resolve(effectiveCwd, gitDir))];

  let directory = effectiveCwd;
  while (guard.roots.some(root => guard.isWithin(directory, root))) {
    const marker = path.join(directory, ".git");
    if (await statIfPresent(marker)) return [...targets, directory, ...await metadataPaths(guard, marker)];
    // Bare repositories have no .git entry. Only inspect names; no config or object payload is read.
    if ((await statIfPresent(path.join(directory, "HEAD")))?.isFile() &&
        (await statIfPresent(path.join(directory, "objects")))?.isDirectory() &&
        (await statIfPresent(path.join(directory, "refs")))?.isDirectory()) {
      return [...targets, ...await metadataPaths(guard, directory)];
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return targets;
}
