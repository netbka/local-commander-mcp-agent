import { spawn } from "node:child_process";
import { buildChildEnvironment } from "./child-environment.js";

interface ProcessRow { pid: number; parent: number; created: number }

// Windows keeps a child's ParentProcessId after its parent exits, so descendants that
// outlive the launched process (detached helpers holding its pipes) remain discoverable
// while taskkill /T against the dead root finds nothing. Only descendants created after
// the root started are followed, which rejects reused parent ids.
export function selectDescendants(rows: ProcessRow[], rootPid: number, startedAtMs: number, ownPid = process.pid): number[] {
  const known = new Set<number>([rootPid]);
  const result: number[] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (known.has(row.pid) || row.pid === ownPid || !known.has(row.parent) || row.created < startedAtMs) continue;
      known.add(row.pid); result.push(row.pid); grew = true;
    }
  }
  return result;
}

function run(command: string, args: string[], captureOutput: boolean): Promise<string> {
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(command, args, {
      windowsHide: true, stdio: ["ignore", captureOutput ? "pipe" : "ignore", "ignore"],
      env: buildChildEnvironment(process.env, process.platform)
    });
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.once("error", () => resolve(""));
    child.once("close", () => resolve(output));
  });
}

async function listWindowsProcesses(): Promise<ProcessRow[]> {
  const script = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
  const output = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], true);
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [pid, parent, created] = line.trim().split(" ").map(Number);
    if (Number.isSafeInteger(pid) && Number.isSafeInteger(parent) && Number.isFinite(created)) rows.push({ pid: pid!, parent: parent!, created: created! });
  }
  return rows;
}

export async function killWindowsDescendants(rootPid: number, startedAtMs: number): Promise<number> {
  const victims = selectDescendants(await listWindowsProcesses(), rootPid, startedAtMs - 2_000);
  await Promise.all(victims.map((pid) => run("taskkill", ["/PID", String(pid), "/T", "/F"], false)));
  return victims.length;
}

export interface RecordedProcess { pid: number; startedAtMs: number }

// Reclaim what a previous server run left behind. A recorded root that is still alive with
// a matching creation time is killed with its tree; a root that is gone has its newer
// children swept. A live process with the same id but a different creation time is a
// reused id and is left alone.
export async function reclaimWindowsProcesses(records: RecordedProcess[]): Promise<number> {
  if (records.length === 0) return 0;
  const rows = await listWindowsProcesses();
  let reclaimed = 0;
  for (const record of records) {
    const live = rows.find((row) => row.pid === record.pid);
    if (live && Math.abs(live.created - record.startedAtMs) > 5_000) continue;
    const victims = selectDescendants(rows, record.pid, record.startedAtMs - 2_000);
    if (live) victims.unshift(record.pid);
    await Promise.all(victims.map((pid) => run("taskkill", ["/PID", String(pid), "/T", "/F"], false)));
    reclaimed += victims.length;
  }
  return reclaimed;
}
