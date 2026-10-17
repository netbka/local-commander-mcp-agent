# Local Commander MCP Agent

A small self-hosted MCP server for controlled access to a development machine: read and edit files inside chosen folders, inspect Git, run allowlisted developer commands, manage dev processes and call localhost services.

It is intentionally narrower than a general remote-desktop agent. There is no free-form shell string, no telemetry, and audit logging is off unless you turn it on.

MIT licensed. The hosted service at [localcmd.app](https://localcmd.app) (accounts, multiple computers, statistics) is a separate product and is not required.

## Tools

| Tool | Purpose |
| --- | --- |
| `project_snapshot` | One-call repo context: status, diff stat, recent commits, package scripts, managed processes |
| `fs_read`, `fs_list`, `fs_search` | Bounded reads, listings and text search inside allowed roots |
| `fs_write`, `fs_replace` | Create/replace a file, or an exact targeted replacement |
| `git_status`, `git_diff`, `git_log` | Compact Git inspection |
| `command_run`, `parallel_command_run` | One or several allowlisted executables with separate arguments |
| `process_start`, `process_list`, `process_output`, `process_kill` | Long-running dev processes |
| `scheduler_status` | Active/queued work and resource locks |
| `localhost_request` | Bounded HTTP to allowlisted local hosts only |

## Claude Desktop extension

Download `local-commander-mcp-agent-<version>.mcpb` from the [latest release](https://github.com/netbka/local-commander-mcp-agent/releases/latest) and open it with Claude Desktop. Choose the folders it may access when asked. No Node.js installation is needed.

## One-command setup (Claude Desktop, Cursor)

Requirements: Node.js 20+.

```bash
npx -y local-commander-mcp-agent setup --root /path/to/your/projects --client all
```

This adds a `local-commander` entry to the Claude Desktop and/or Cursor MCP configuration, keeping a timestamped backup of the previous file. Repeat `--root` for more folders, use `--client claude-desktop` or `--client cursor` for one client, `--dry-run` to preview, and `setup --remove` to take the entry out again. Restart the client afterwards.

## Run with npx (stdio)

Requirements: Node.js 20+. Folders the server may access follow `--stdio`:

```json
{
  "mcpServers": {
    "local-commander": {
      "command": "npx",
      "args": ["-y", "local-commander-mcp-agent", "--stdio", "/path/to/your/projects"]
    }
  }
}
```

On Windows some clients need `"command": "cmd"` with `"args": ["/c", "npx", "-y", ...]`; `setup` writes that form for you.

Claude Code: `claude mcp add local-commander -- npx -y local-commander-mcp-agent --stdio /path/to/your/projects`

`LCMCP_ROOTS` still works instead of folder arguments. In stdio mode local state is kept in `~/.local-commander-mcp-agent` unless `LCMCP_OAUTH_STATE_PATH` is set.

On Windows use `;` between several roots and paths such as `C:\\Users\\you\\source\\repos`. The package includes the small Windows file-read helper, so nothing is compiled at install time.

## Run with Docker (stdio)

The container is the sandbox: the server only sees the folders you mount under `/workspace`.

The image is published as `ghcr.io/netbka/local-commander-mcp-agent` (tags `latest` and each version). To build it yourself: `docker build -t local-commander-mcp-agent .`

MCP client configuration (Claude Desktop, Cursor, Claude Code, Codex and others):

```json
{
  "mcpServers": {
    "local-commander": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-v", "/path/to/your/projects:/workspace/projects",
        "ghcr.io/netbka/local-commander-mcp-agent"
      ]
    }
  }
}
```

On Windows use a path such as `C:\\Users\\you\\source\\repos:/workspace/repos`.

The image contains Node.js 22, Git and Python 3. Add tools by extending the image.

## Run with Docker (HTTP)

```bash
docker run --rm -p 127.0.0.1:17321:17321 \
  -e LCMCP_TOKEN=generate-a-long-random-token \
  -v /path/to/your/projects:/workspace/projects \
  ghcr.io/netbka/local-commander-mcp-agent --http
```

The image defaults to `--stdio`; any other argument after the image name (here `--http`) replaces it and starts the HTTP server. The endpoint is `http://127.0.0.1:17321/mcp` with `Authorization: Bearer <token>`. Publish the port on `127.0.0.1` only.

## Run with Node.js (stdio)

Requirements: Node.js 20+.

```bash
npm install
npm run build
```

```json
{
  "mcpServers": {
    "local-commander": {
      "command": "node",
      "args": ["/path/to/local-commander-mcp-agent/dist/index.js", "--stdio"],
      "env": {
        "LCMCP_ROOTS": "/path/to/your/projects",
        "LCMCP_OAUTH_STATE_PATH": "/path/to/a/private/state/dir/oauth.json"
      }
    }
  }
}
```

`LCMCP_ROOTS` takes several folders separated by the OS path delimiter (`;` on Windows, `:` elsewhere). Local state (managed process registry) is kept next to `LCMCP_OAUTH_STATE_PATH`; set it, because MCP clients often start servers from an unpredictable working directory.

In stdio mode stdout carries only MCP messages and logs go to stderr. HTTP authentication settings do not apply, because only the client that started the process can talk to it.

On Windows the build also compiles a small file-read helper (`release/personal/OwnerBridge.exe`) with the .NET Framework compiler that ships with Windows. Other platforms use the Node reader.

## Run with Node.js (HTTP, ChatGPT over a tunnel)

```bash
cp local-commander.config.example.json local-commander.config.json   # set "roots"
LCMCP_AUTH_MODE=oauth LCMCP_PUBLIC_BASE_URL=https://your-tunnel.example.com npm start
```

When the client starts authorization, a one-time approval code is printed in the local terminal. Bearer mode (`LCMCP_AUTH_MODE=bearer`, `LCMCP_TOKEN=...`) is available for local clients.

## Security model

- Direct file operations are constrained to the configured roots; existing paths are resolved with `realpath`, so symlinks cannot escape a root.
- Common secret files (`.env`, private keys, credential files) are blocked by default.
- `command_run` takes an executable and an argument array, never a shell string. Executables are allowlisted and resolved from absolute `PATH` directories only.
- Command time and output are capped; HTTP is limited to localhost and redirects are not followed.
- Child processes are **not** OS-sandboxed outside Docker: an allowed interpreter can read anything the account can read. For hard containment use the Docker image, a separate low-privilege account or a VM.

## Configuration

| Variable | Meaning |
| --- | --- |
| `LCMCP_TRANSPORT` | `stdio` to serve over stdio (same as `--stdio`) |
| `LCMCP_ROOTS` | Allowed roots separated by the OS path delimiter |
| `LCMCP_CONFIG` | Config file path (default `local-commander.config.json` in the working directory) |
| `LCMCP_HOST`, `LCMCP_PORT`, `LCMCP_MCP_PATH` | HTTP bind and path |
| `LCMCP_AUTH_MODE` | HTTP only: `oauth`, `bearer` or `none` |
| `LCMCP_TOKEN` | Token for bearer mode |
| `LCMCP_PUBLIC_BASE_URL` | Public HTTPS origin used as OAuth issuer/resource |
| `LCMCP_OAUTH_STATE_PATH` | OAuth and local state file path |
| `LCMCP_AUDIT_MODE` | `off` (default), `minimal`, `diagnostic` or `full` (full requires `LCMCP_AUDIT_RECOVERY_KEY`) |

The config file can also set the command allowlist (`shell.allowedCommands`), size limits and localhost hosts; see `local-commander.config.example.json`.

## Development

```bash
npm run typecheck
npm test
npm run build
```
