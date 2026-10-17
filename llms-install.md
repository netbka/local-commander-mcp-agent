# Installing Local Commander for Cline

1. Requires Node.js 20 or newer.
2. Ask the user which folder(s) the server may access. Never guess a folder.
3. Add this to Cline's MCP settings, replacing the folder:

```json
{
  "mcpServers": {
    "local-commander": {
      "command": "npx",
      "args": ["-y", "local-commander-mcp-agent", "--stdio", "/path/the/user/chose"]
    }
  }
}
```

On Windows use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "local-commander-mcp-agent", "--stdio", "C:\\path\\the\\user\\chose"]`.

4. Restart the server in Cline and call `project_snapshot` to confirm it works.

Read-only tools (`project_snapshot`, `fs_read`, `fs_list`, `fs_search`, `git_status`, `git_diff`, `git_log`) are safe to auto-approve. Keep `command_run`, `process_start`, `fs_write` and `fs_replace` on manual approval.
