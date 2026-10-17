import type { FabricSnapshot, RuntimeHealth } from "./agent-fabric-local.js";

// A single self-contained HTML file: no stylesheet, script, font or image is
// fetched, and the data is embedded rather than requested, so the page works
// from file:// with no server, no listener and no network traffic. "Live" is a
// meta refresh re-reading the regenerated local file; a push channel would need
// a new listener, which this slice deliberately does not open.
export interface MonitorTask {
  id: string;
  status: string;
  assignee: string | null;
  attempts: number;
  run: string | null;
}
export interface MonitorInput {
  snapshot: FabricSnapshot;
  tasks?: MonitorTask[];
  refreshSeconds?: number;
  title?: string;
}

const HEALTH_LABEL: Record<RuntimeHealth, string> = {
  active: "active", stale: "not reporting", lost: "lost", stopped: "stopped"
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
function age(ms: number): string {
  if (ms < 1000) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds + "s ago";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? hours + "h ago" : Math.floor(hours / 24) + "d ago";
}
function clock(at: number): string {
  return new Date(at).toISOString().replace("T", " ").slice(0, 19) + "Z";
}
function cell(value: string): string {
  return "<td>" + escapeHtml(value) + "</td>";
}

export function renderAgentMonitor(input: MonitorInput): string {
  const { snapshot } = input;
  const refresh = Math.max(2, Math.min(3600, input.refreshSeconds ?? 10));
  const title = input.title ?? "Local Commander agents";
  const runtimes = [...snapshot.runtimes].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const counts = runtimes.reduce<Record<string, number>>((totals, runtime) => {
    totals[runtime.health] = (totals[runtime.health] ?? 0) + 1;
    return totals;
  }, {});
  const summary = (["active", "stale", "lost", "stopped"] as RuntimeHealth[])
    .filter(health => counts[health])
    .map(health => counts[health] + " " + HEALTH_LABEL[health])
    .join(", ") || "no agents have announced yet";

  const runtimeRows = runtimes.map(runtime => "<tr class=\"h-" + runtime.health + "\">" +
    cell(runtime.label) + cell(runtime.node) + cell(runtime.source.replace(/_/g, " ")) +
    "<td><span class=\"dot\"></span>" + escapeHtml(HEALTH_LABEL[runtime.health]) + "</td>" +
    cell(runtime.activity ?? "-") + cell(runtime.taskId ?? "-") +
    cell(runtime.unreadCount ? String(runtime.unreadCount) : "-") +
    cell(age(runtime.idleMs)) + "</tr>").join("");

  const taskRows = (input.tasks ?? []).map(task => "<tr>" +
    cell(task.id) + cell(task.status) + cell(task.assignee ?? "unassigned") +
    cell(String(task.attempts)) + cell(task.run ?? "-") + "</tr>").join("");

  // Opaque runtime ids are unreadable in a monitoring view, so show the label a
  // runtime announced and fall back to the raw id for a role mailbox or a runtime
  // that has since been pruned.
  const labels = new Map(runtimes.map(runtime => [runtime.id, runtime.label]));
  const named = (address: string): string => labels.get(address) ?? address;

  const messageRows = [...snapshot.messages]
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 40)
    .map(message => "<tr>" + cell(clock(message.createdAt)) + cell(message.kind) +
      cell(named(message.from)) + cell(named(message.to)) + cell(message.taskId) +
      cell(message.ackedBy.length ? "read" : "unread") +
      "<td class=\"body\">" + escapeHtml(message.body) + "</td></tr>").join("");

  const section = (heading: string, columns: string[], rows: string, empty: string) =>
    "<h2>" + escapeHtml(heading) + "</h2>" + (rows
      ? "<table><thead><tr>" + columns.map(column => "<th>" + escapeHtml(column) + "</th>").join("") +
        "</tr></thead><tbody>" + rows + "</tbody></table>"
      : "<p class=\"empty\">" + escapeHtml(empty) + "</p>");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${refresh}">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; }
body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; }
h1 { font-size: 18px; margin: 0 0 4px; }
h2 { font-size: 14px; margin: 28px 0 8px; text-transform: uppercase; letter-spacing: .06em; opacity: .7; }
p.sub { margin: 0; opacity: .7; }
p.empty { opacity: .6; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid rgba(128,128,128,.3); vertical-align: top; }
th { font-weight: 600; opacity: .7; font-size: 12px; }
td.body { white-space: pre-wrap; max-width: 46ch; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 7px; background: #999; }
.h-active .dot { background: #1a9d41; }
.h-stale .dot { background: #d79c20; }
.h-lost .dot { background: #cc3b3b; }
.h-stopped .dot { background: #888; }
.h-lost td, .h-stopped td { opacity: .65; }
footer { margin-top: 32px; font-size: 12px; opacity: .6; }
</style>
</head><body>
<h1>${escapeHtml(title)}</h1>
<p class="sub">${escapeHtml(summary)} &middot; generated ${escapeHtml(clock(snapshot.generatedAt))} &middot; refreshes every ${refresh}s</p>
${section("Agents", ["Agent", "Node", "Source", "Health", "Doing", "Task", "Unread", "Last seen"], runtimeRows, "No agent runtime has announced itself yet.")}
${section("Controller tasks", ["Task", "Status", "Assignee", "Attempts", "Run"], taskRows, "No controller state was supplied.")}
${section("Recent messages", ["Time", "Kind", "From", "To", "Task", "State"].concat("Body"), messageRows, "No task messages.")}
<footer>Presence and messages are facts, not permissions. A message never transfers a permission, lease or task assignment.</footer>
</body></html>`;
}
