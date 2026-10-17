// Synthetic SDK fixture only: no Local Commander configuration, tools or listener.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

// Acknowledge input chunks without retaining or echoing their contents.
process.stdin.on("data", () => process.stderr.write("input-chunk\n"));
serveStdio(() => {
  const server = new McpServer({ name: "stdio-conformance", version: "0.0.0" });
  server.registerTool("echo", { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
    content: [{ type: "text", text }]
  }));
  server.registerTool("wait", { inputSchema: z.object({}) }, async (_args, ctx) => {
    const signal = ctx.mcpReq.signal;
    process.stderr.write("wait-started\n");
    await new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", resolve, { once: true });
    });
    process.stderr.write("wait-aborted\n");
    return { content: [{ type: "text", text: "aborted" }] };
  });
  return server;
}, { onerror: () => process.stderr.write("transport-error\n") });
process.stderr.write("fixture-ready\n");
