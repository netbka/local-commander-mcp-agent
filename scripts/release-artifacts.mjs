// Builds the Claude Desktop extension (.mcpb) and stamps the release version and its SHA-256 into
// manifest.json and server.json. Run after `npm run build` on Windows: npm run release:artifacts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const REPO = "https://github.com/netbka/local-commander-mcp-agent";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run through npm: npm run release:artifacts");

function npm(args, cwd) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd, stdio: "inherit", windowsHide: true });
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} failed`);
}

const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
const write = (rel, value) => fs.writeFileSync(path.join(root, rel), JSON.stringify(value, null, 2) + "\n");
const { version } = read("package.json");
for (const rel of ["dist/index.js", "release/personal/OwnerBridge.exe", "package-lock.json"]) {
  if (!fs.existsSync(path.join(root, rel))) throw new Error(`Missing ${rel}; run npm install and npm run build on Windows first.`);
}

const manifest = read("manifest.json");
manifest.version = version;
write("manifest.json", manifest);

const staging = path.join(root, ".mcpb-staging");
fs.rmSync(staging, { recursive: true, force: true });
for (const rel of ["dist", "packages", "release/personal/OwnerBridge.exe", "LICENSE", "README.md", "package.json", "package-lock.json", "manifest.json"]) {
  fs.cpSync(path.join(root, rel), path.join(staging, rel), { recursive: true });
}
npm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], staging);
fs.rmSync(path.join(staging, "package-lock.json"));

const fileName = `local-commander-mcp-agent-${version}.mcpb`;
const output = path.join(root, fileName);
fs.rmSync(output, { force: true });
npm(["exec", "--yes", "--", MCPB_CLI, "pack", staging, output], root);
fs.rmSync(staging, { recursive: true, force: true });
const fileSha256 = createHash("sha256").update(fs.readFileSync(output)).digest("hex");

const server = read("server.json");
server.version = version;
server.packages = server.packages.filter((entry) => entry.registryType !== "mcpb").map((entry) => {
  if (entry.registryType === "npm") return { ...entry, version };
  if (entry.registryType === "oci") return { ...entry, identifier: entry.identifier.replace(/:[^:/]+$/, `:${version}`) };
  return entry;
});
server.packages.push({
  registryType: "mcpb",
  identifier: `${REPO}/releases/download/v${version}/${fileName}`,
  fileSha256,
  transport: { type: "stdio" }
});
write("server.json", server);
console.log(JSON.stringify({ version, mcpb: fileName, bytes: fs.statSync(output).size, fileSha256 }, null, 2));
