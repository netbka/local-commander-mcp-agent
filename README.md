<div align="center">

# Local Commander

### Your AI, on your computer.

Let Claude, Cursor, Codex or your own agent work with the files, Git and dev tools on your machine.<br>
You choose the folders. No account, no cloud, no telemetry.

[![npm](https://img.shields.io/npm/v/local-commander-mcp-agent?label=npm&color=cb3837)](https://www.npmjs.com/package/local-commander-mcp-agent)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-2496ed)](https://github.com/netbka/local-commander-mcp-agent/pkgs/container/local-commander-mcp-agent)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-listed-6e56cf)](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.netbka/local-commander-mcp-agent)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[Get started](#get-started) · [What people use it for](#what-people-use-it-for) · [Why Local Commander](#why-local-commander) · [Questions](#before-you-install) · [Technical reference](#technical-reference)

</div>

---

## The problem

Your AI can write the code, but it can't see your project. You copy files into the chat, paste test output back, and run every command yourself. Giving it a raw terminal solves that, but then it can touch everything.

Local Commander sits in between. Your AI gets real tools for real work on your machine, inside the folders you pick, with commands you allow. You keep working in the chat you already have open.

## What people use it for

| | |
| --- | --- |
| **Code** | Run tests and builds · Fix a bug in the real repo · Review a diff before you push |
| **Local services** | Start a dev server · Check a service is up · Read its logs |
| **Project context** | Get status, recent commits and scripts in one ask · Search the codebase · Edit files in place |

Try asking:

> "Run the tests in my-app and tell me what fails."<br>
> "Start the dev server and check that port 3000 answers."<br>
> "Show me what changed in the repo since yesterday."

## Why Local Commander

**🔒 You choose the access.** Your AI sees only the folders you pick. Secret files such as `.env` and private keys are blocked by default.

**🧰 Real tools, not a raw shell.** Commands run from an allowlist (Git, Node, npm, Python and similar) with separate arguments. There is no free-form shell string to inject into.

**⚡ Parallel work without collisions.** Independent commands run side by side. Long-running processes such as dev servers keep running while your AI checks their output.

**🏠 Stays on your machine.** The server runs locally and talks only to the AI client that started it. No account, no telemetry, and the audit log is off unless you turn it on.

**🔌 Works with the AI you already have.** Claude Desktop, Claude Code, Cursor, Codex, ChatGPT over a tunnel, or anything that speaks MCP.

## Get started

Pick the way that fits you. Each takes a couple of minutes.

| You use | Do this |
| --- | --- |
| **Claude Desktop** | Download the `.mcpb` file from the [latest release](https://github.com/netbka/local-commander-mcp-agent/releases/latest) and open it. Choose your folders. No Node.js needed. |
| **Claude Desktop or Cursor, with Node.js 20+** | `npx -y local-commander-mcp-agent setup --root /path/to/your/projects --client all` and restart the app. |
| **Claude Code** | `claude mcp add local-commander -- npx -y local-commander-mcp-agent --stdio /path/to/your/projects` |
| **Docker** | Mount your projects into `ghcr.io/netbka/local-commander-mcp-agent`. See [Docker](#docker). |
| **Any other MCP client** | Run `npx -y local-commander-mcp-agent --stdio /path/to/your/projects`. See [npx](#npx). |

## Before you install

<details>
<summary><b>What can my AI touch?</b></summary>

Only the folders you choose, and only through Local Commander's tools: reading and editing files, Git inspection, allowlisted commands, dev processes and requests to `localhost`. You can change the command list in the config file.
</details>

<details>
<summary><b>Is it a sandbox?</b></summary>

No. File tools are limited to your folders, but an allowed program such as `node` or `python` runs with your account's permissions and can read what you can read. For hard isolation, use the Docker image, a separate low-privilege account or a VM.
</details>

<details>
<summary><b>Does my data go anywhere?</b></summary>

No. The server runs on your computer and talks only to the AI client that started it. There is no telemetry. What your AI client sends to its own provider is between you and that provider.
</details>

<details>
<summary><b>Can I remove it?</b></summary>

Yes. `npx -y local-commander-mcp-agent setup --remove` takes it out of Claude Desktop and Cursor and keeps a backup of the previous config. In Claude Desktop you can also disable or remove the extension.
</details>

<details>
<summary><b>What about several computers or a team?</b></summary>

This open-source edition runs one computer at a time. The hosted service at [localcmd.app](https://localcmd.app) connects ChatGPT, Claude or your own agent to all your Windows PCs at once, runs tasks on several machines in parallel and shows which computer ran what. It is a separate product and is not needed for this one.
</details>

---

## Technical reference

- [Tools](#tools)
- [Install options](#install-options): [setup](#one-command-setup) · [npx](#npx) · [Docker](#docker) · [Node.js](#nodejs) · [HTTP and ChatGPT](#http-and-chatgpt)
- [Security model](#security-model)
- [Configuration](#configuration)
- [Development](#development)

### Tools

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

### Install options

#### One-command setup

Requirements: Node.js 20+.

```bash
npx -y local-commander-mcp-agent setup --root /path/to/your/projects --client all
```

This adds a `local-commander` entry to the Claude Desktop and/or Cursor MCP configuration, keeping a timestamped backup of the previous file. Repeat `--root` for more folders, use `--client claude-desktop` or `--client cursor` for one client, `--dry-run` to preview, and `setup --remove` to take the entry out again. Restart the client afterwards.

#### npx

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

`LCMCP_ROOTS` still works instead of folder arguments. In stdio mode local state is kept in `~/.local-commander-mcp-agent` unless `LCMCP_OAUTH_STATE_PATH` is set.

On Windows use `;` between several roots and paths such as `C:\\Users\\you\\source\\repos`. The package includes the small Windows file-read helper, so nothing is compiled at install time.

#### Docker

The container is the sandbox: the server only sees the folders you mount under `/workspace`. The image is published as `ghcr.io/netbka/local-commander-mcp-agent` (tags `latest` and each version). To build it yourself: `docker build -t local-commander-mcp-agent .`

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

On Windows use a path such as `C:\\Users\\you\\source\\repos:/workspace/repos`. The image contains Node.js 22, Git and Python 3. Add tools by extending the image.

HTTP instead of stdio:

```bash
docker run --rm -p 127.0.0.1:17321:17321 \
  -e LCMCP_TOKEN=generate-a-long-random-token \
  -v /path/to/your/projects:/workspace/projects \
  ghcr.io/netbka/local-commander-mcp-agent --http
```

The image defaults to `--stdio`; any other argument after the image name (here `--http`) replaces it and starts the HTTP server. The endpoint is `http://127.0.0.1:17321/mcp` with `Authorization: Bearer <token>`. Publish the port on `127.0.0.1` only.

#### Node.js

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
      "args": ["/path/to/local-commander-mcp-agent/dist/index.js", "--stdio", "/path/to/your/projects"]
    }
  }
}
```

In stdio mode stdout carries only MCP messages and logs go to stderr. HTTP authentication settings do not apply, because only the client that started the process can talk to it.

On Windows the build also compiles a small file-read helper (`release/personal/OwnerBridge.exe`) with the .NET Framework compiler that ships with Windows. Other platforms use the Node reader.

#### HTTP and ChatGPT

```bash
cp local-commander.config.example.json local-commander.config.json   # set "roots"
LCMCP_AUTH_MODE=oauth LCMCP_PUBLIC_BASE_URL=https://your-tunnel.example.com npm start
```

When the client starts authorization, a one-time approval code is printed in the local terminal. Bearer mode (`LCMCP_AUTH_MODE=bearer`, `LCMCP_TOKEN=...`) is available for local clients.

### Security model

- Direct file operations are constrained to the configured roots; existing paths are resolved with `realpath`, so symlinks cannot escape a root.
- Common secret files (`.env`, private keys, credential files) are blocked by default.
- `command_run` takes an executable and an argument array, never a shell string. Executables are allowlisted and resolved from absolute `PATH` directories only.
- Command time and output are capped; HTTP is limited to localhost and redirects are not followed.
- Child processes are **not** OS-sandboxed outside Docker: an allowed interpreter can read anything the account can read. For hard containment use the Docker image, a separate low-privilege account or a VM.

### Configuration

| Variable | Meaning |
| --- | --- |
| `LCMCP_TRANSPORT` | `stdio` to serve over stdio (same as `--stdio`) |
| `LCMCP_ROOTS` | Allowed roots separated by the OS path delimiter (`;` on Windows, `:` elsewhere) |
| `LCMCP_CONFIG` | Config file path (default `local-commander.config.json` in the working directory) |
| `LCMCP_HOST`, `LCMCP_PORT`, `LCMCP_MCP_PATH` | HTTP bind and path |
| `LCMCP_AUTH_MODE` | HTTP only: `oauth`, `bearer` or `none` |
| `LCMCP_TOKEN` | Token for bearer mode |
| `LCMCP_PUBLIC_BASE_URL` | Public HTTPS origin used as OAuth issuer/resource |
| `LCMCP_OAUTH_STATE_PATH` | OAuth and local state file path |
| `LCMCP_AUDIT_MODE` | `off` (default), `minimal`, `diagnostic` or `full` (full requires `LCMCP_AUDIT_RECOVERY_KEY`) |

The config file can also set the command allowlist (`shell.allowedCommands`), size limits and localhost hosts; see `local-commander.config.example.json`.

### Development

```bash
npm run typecheck
npm test
npm run build
```

---

<div align="center">

MIT licensed · [Report an issue](https://github.com/netbka/local-commander-mcp-agent/issues) · Hosted multi-computer service: [localcmd.app](https://localcmd.app)

</div>
