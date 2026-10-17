import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { resolveWindowsLauncher, type CommandRequest, type CommandResult } from "./process.js";
import { LOCAL_RUNTIME_PROVIDERS } from "./controller-runtime-router.js";

// Inspect only known launchers. Never run login, read credential stores, or inventory unrelated software.
// A generic "agent" executable is not sufficient evidence of Cursor identity.
const COMMANDS = { chatgpt: ["codex"], claude: ["claude"], cursor: ["cursor-agent"] } as const;
function installed(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return !!resolveWindowsLauncher(command, env);
  return (env.PATH || "").split(path.delimiter).some(dir => {
    if (!path.isAbsolute(dir)) return false;
    try { const file = path.join(dir, command); accessSync(file, constants.X_OK); return statSync(file).isFile(); }
    catch { return false; }
  });
}
export function discoverLocalRuntimes(allowedCommands: readonly string[], env = process.env, platform = process.platform) {
  return LOCAL_RUNTIME_PROVIDERS.map(provider => {
    const found = COMMANDS[provider].filter(command => installed(command, env, platform));
    const permitted = found.find(command => allowedCommands.includes(command));
    return {
      provider, installed: found.length > 0,
      command: permitted ?? found[0] ?? null, commandAllowed: !!permitted,
      authentication: "unknown" as const,
      // An executable on PATH is not proof of an authenticated, mediated controller adapter.
      executionReady: false,
      reason: !found.length ? "not_installed" : !permitted ? "local_permission_required" : "adapter_verification_required"
    };
  });
}

// These commands report credentials already available to the CLI; they never log in or run a model.
const AUTH_STATUS = { chatgpt: ["login", "status"], claude: ["auth", "status", "--json"] } as const;
type ProbeResult = Pick<CommandResult, "exitCode" | "signal" | "stdout" | "stderr" | "stdoutTruncated" | "stderrTruncated" | "timedOut" | "descendantsHeldOutput">;
export async function inspectRuntimeAuthentication(
  facts: ReturnType<typeof discoverLocalRuntimes>,
  probe: (request: CommandRequest) => Promise<ProbeResult>
) {
  const results = [];
  for (const fact of facts) {
    let authentication: "unknown" | "signed_in" | "sign_in_required" = "unknown";
    let reason = fact.reason;
    if (fact.commandAllowed && fact.command && fact.provider !== "cursor") {
      try {
        const result = await probe({ command: fact.command, args: [...AUTH_STATUS[fact.provider]], timeoutMs: 10_000 });
        if (!result.timedOut && !result.signal && !result.stdoutTruncated && !result.stderrTruncated && !result.descendantsHeldOutput &&
            Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 16_384) {
          if (fact.provider === "claude") {
            const data = JSON.parse(result.stdout);
            if (data?.loggedIn === true && result.exitCode === 0) authentication = "signed_in";
            else if (data?.loggedIn === false && (result.exitCode === 0 || result.exitCode === 1)) authentication = "sign_in_required";
          } else {
            const lines = (result.stdout + "\n" + result.stderr).split(/\r?\n/).map(line => line.trim());
            if (result.exitCode === 0 && lines.some(line => /^Logged in using (ChatGPT|an API key)(?:$|[ \t-])/.test(line))) authentication = "signed_in";
            else if (result.exitCode === 1 && lines.includes("Not logged in")) authentication = "sign_in_required";
          }
        }
      } catch { /* A probe failure reveals no diagnostic, credentials or permission and starts no work. */ }
      reason = authentication === "signed_in" ? "adapter_verification_required" : authentication === "sign_in_required" ? "sign_in_required" : "authentication_unavailable";
    } else if (fact.commandAllowed) reason = "authentication_probe_unavailable";
    results.push({ ...fact, authentication, reason });
  }
  return results;
}
