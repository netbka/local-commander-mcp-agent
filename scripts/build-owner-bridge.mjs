import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const personal = process.argv.length === 3 && process.argv[2] === "--personal";
if (process.argv.length > 2 && !personal) throw Error("BUILD_ARGUMENT_INVALID");
if (process.platform !== "win32") {
  if (personal) process.exit(0);
  console.error("OWNER_BRIDGE_WINDOWS_REQUIRED");
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe"
];
const compiler = candidates.find(fs.existsSync);
if (!compiler) {
  console.error("CSC_NOT_FOUND");
  process.exit(1);
}
const source = path.join(root, "agent", "windows", "OwnerBridge.cs");
const outputDir = path.join(root, "release", personal ? "personal" : "windows");
const output = path.join(outputDir, "OwnerBridge.exe");
fs.mkdirSync(outputDir, { recursive: true });
if (fs.realpathSync(outputDir).toLowerCase() !== outputDir.toLowerCase()) throw Error("BUILD_PATH_INVALID");
if (fs.existsSync(output) && (!fs.lstatSync(output).isFile() || fs.lstatSync(output).isSymbolicLink())) throw Error("BUILD_PATH_INVALID");
const args = [
  "/nologo", "/target:exe", "/optimize+", "/out:" + output,
  "/r:System.Security.dll", "/r:System.Windows.Forms.dll", source
];
// Personal builds run before dev/build/test; a running Local Commander locks the exe, so skip
// recompiling identical inputs. A pre-stamp exe is adopted only when newer than its source.
const stamp = output + ".inputs.sha256";
const inputs = crypto.createHash("sha256").update(JSON.stringify([compiler, args])).update(fs.readFileSync(source)).digest("hex");
if (personal && fs.existsSync(output)) {
  const upToDate = fs.existsSync(stamp)
    ? fs.readFileSync(stamp, "utf8").trim() === inputs
    : fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs;
  if (upToDate) {
    fs.writeFileSync(stamp, inputs + "\n");
    console.log(JSON.stringify({ built: false, upToDate: true, path: path.relative(root, output).replaceAll("\\", "/") }));
    process.exit(0);
  }
}
const result = spawnSync(compiler, args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30000 });
if (result.status !== 0) {
  process.stderr.write(result.stdout || result.stderr || "OWNER_BRIDGE_BUILD_FAILED\n");
  process.exit(result.status ?? 1);
}
if (personal) fs.writeFileSync(stamp, inputs + "\n");
const stat = fs.statSync(output);
console.log(JSON.stringify({ built: true, path: path.relative(root, output).replaceAll("\\", "/"), bytes: stat.size }));
