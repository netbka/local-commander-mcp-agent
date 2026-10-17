import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export interface PathGuardOptions {
  protectedPaths?: string[];
}

const SENSITIVE_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  ".netrc",
  "_netrc",
  ".pgpass",
  "credentials.json",
  "application_default_credentials.json"
]);

const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".ppk", ".kdbx"]);

// Credential stores with generic file names: the parent directory identifies them.
const SENSITIVE_IN_DIRECTORY: ReadonlyArray<readonly [string, string]> = [
  [".aws", "credentials"],
  [".kube", "config"],
  [".docker", "config.json"],
  [".claude", ".credentials.json"],
  [".codex", "auth.json"],
  [".azure", "msal_token_cache.json"],
  [".azure", "accesstokens.json"],
  ["gh", "hosts.yml"],
  ["github cli", "hosts.yml"]
];

const SENSITIVE_DIRECTORIES = new Set([".ssh", ".gnupg"]);

const PROTECTED_FILE_NAMES = new Set([
  ".local-commander-oauth.json",
  "local-commander.config.json"
]);

const PROTECTED_DIRECTORY_NAMES = new Set([".local-commander"]);

function comparePath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function splitPathSegments(filePath: string): string[] {
  const parsed = path.parse(path.resolve(filePath));
  return path
    .relative(parsed.root, path.resolve(filePath))
    .split(path.sep)
    .filter((segment) => segment.length > 0);
}

function isProtectedAuditFile(base: string): boolean {
  return base === ".local-commander-audit.jsonl" || base.startsWith(".local-commander-audit.jsonl.");
}

function looksProtected(filePath: string): boolean {
  const segments = splitPathSegments(filePath).map((segment) => segment.toLowerCase());
  if (segments.some((segment) => PROTECTED_DIRECTORY_NAMES.has(segment))) return true;

  const base = segments.at(-1);
  if (!base) return false;
  if (PROTECTED_FILE_NAMES.has(base)) return true;
  if (isProtectedAuditFile(base)) return true;
  return false;
}

export function looksSensitive(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) return true;
  if (SENSITIVE_NAMES.has(base)) return true;
  if (SENSITIVE_EXTENSIONS.has(path.extname(base))) return true;
  const segments = splitPathSegments(filePath).map((segment) => segment.toLowerCase());
  if (segments.slice(0, -1).some((segment) => SENSITIVE_DIRECTORIES.has(segment))) return true;
  const parent = segments.at(-2);
  return SENSITIVE_IN_DIRECTORY.some(([directory, name]) => directory === parent && name === base);
}

async function canonicalizePossiblyMissing(inputPath: string, base: string): Promise<string> {
  const absolute = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(base, inputPath);
  const parsed = path.parse(absolute);
  let current = absolute;
  const missing: string[] = [];

  while (current !== parsed.root) {
    try {
      const resolved = await realpath(current);
      return path.join(resolved, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      let exists = false;
      try { await lstat(current); exists = true; } catch (statError) { if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError; }
      if (exists) throw error; // Dangling links and unknown targets must not become new-file paths.
      missing.push(path.basename(current));
      current = path.dirname(current);
    }
  }

  const root = await realpath(parsed.root);
  return path.join(root, ...missing.reverse());
}

export class PathGuard {
  private constructor(
    readonly roots: string[],
    private readonly allowSensitiveFiles: boolean,
    private readonly protectedPaths: string[]
  ) {}

  static async create(
    roots: string[],
    allowSensitiveFiles: boolean,
    options: PathGuardOptions = {}
  ): Promise<PathGuard> {
    const canonical: string[] = [];
    for (const root of roots) {
      let resolved: string;
      try {
        resolved = await realpath(path.resolve(root));
      } catch {
        throw new Error(`Configured root does not exist: ${root}`);
      }
      const stat = await lstat(resolved);
      if (!stat.isDirectory()) throw new Error(`Configured root is not a directory: ${root}`);
      if (!canonical.some((existing) => comparePath(existing) === comparePath(resolved))) {
        canonical.push(resolved);
      }
    }

    if (canonical.length === 0) throw new Error("At least one allowed root is required");
    const protectedPaths: string[] = [];
    for (const protectedPath of options.protectedPaths ?? []) {
      const base = path.isAbsolute(protectedPath) ? path.parse(path.resolve(protectedPath)).root : canonical[0]!;
      const absolute = path.resolve(base, protectedPath);
      if (!protectedPaths.some(existing => comparePath(existing) === comparePath(absolute))) protectedPaths.push(absolute);
      const resolved = await canonicalizePossiblyMissing(protectedPath, base);
      if (!protectedPaths.some((existing) => comparePath(existing) === comparePath(resolved))) {
        protectedPaths.push(resolved);
      }
    }

    return new PathGuard(canonical, allowSensitiveFiles, protectedPaths);
  }

  private assertWithinRoots(candidate: string): void {
    if (!this.roots.some((root) => isInside(comparePath(root), comparePath(candidate)))) {
      throw new Error(`Path is outside configured roots: ${candidate}`);
    }
  }

  private assertNotProtected(candidate: string): void {
    if (looksProtected(candidate)) {
      throw new Error(`Local Commander protected state is blocked: ${path.basename(candidate)}`);
    }

    const normalizedCandidate = comparePath(candidate);
    for (const protectedPath of this.protectedPaths) {
      if (isInside(comparePath(protectedPath), normalizedCandidate)) {
        throw new Error(`Protected path access is blocked: ${candidate}`);
      }
    }
  }

  assertSafeFile(filePath: string): void {
    this.assertNotProtected(filePath);
    if (!this.allowSensitiveFiles && looksSensitive(filePath)) {
      throw new Error(
        `Sensitive file access is blocked by default: ${path.basename(filePath)}. Enable files.allowSensitiveFiles only if you really need it.`
      );
    }
  }

  async resolveExisting(inputPath: string, cwd?: string): Promise<string> {
    const base = cwd ? await this.resolveExisting(cwd) : this.roots[0]!;
    const candidate = path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(base, inputPath);

    this.assertNotProtected(candidate);
    const resolved = await realpath(candidate);
    this.assertWithinRoots(resolved);
    this.assertNotProtected(resolved);
    return resolved;
  }

  async resolveDirectory(inputPath: string, cwd?: string): Promise<string> {
    const resolved = await this.resolveExisting(inputPath, cwd);
    const stat = await lstat(resolved);
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
    return resolved;
  }

  async resolveForWrite(inputPath: string, cwd?: string): Promise<string> {
    const base = cwd ? await this.resolveDirectory(cwd) : this.roots[0]!;
    const candidate = path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(base, inputPath);

    this.assertNotProtected(candidate);

    let existing: string | undefined;
    try {
      existing = await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      let exists = false;
      try { await lstat(candidate); exists = true; } catch (statError) { if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError; }
      if (exists) throw error;
    }

    if (existing) {
      this.assertWithinRoots(existing);
      this.assertNotProtected(existing);
      this.assertSafeFile(existing);
      return existing;
    }

    const parent = await realpath(path.dirname(candidate));
    this.assertWithinRoots(parent);
    this.assertNotProtected(parent);
    this.assertSafeFile(candidate);
    const target = path.join(parent, path.basename(candidate));
    this.assertSafeFile(target);
    return target;
  }

  isWithin(candidate: string, root: string): boolean {
    return isInside(comparePath(root), comparePath(candidate));
  }
}
