import { createHash } from "node:crypto";
import os from "node:os";
import { z } from "zod";

const atom = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/);
const short = z.string().min(1).max(64).refine(value => !/[\p{Cc}]/u.test(value));
const LifecycleSchema = z.strictObject({
  spawn: z.boolean(), resume: z.boolean(), status: z.boolean(),
  cancel: z.boolean(), message: z.boolean(), interactiveOnly: z.boolean()
});
const WorkspaceSchema = z.strictObject({
  id: atom,
  locality: z.enum(["local", "synced", "remote"]),
  traits: z.array(short).max(16).default([])
});
const RuntimeAdapterSchema = z.strictObject({
  name: atom,
  lifecycle: LifecycleSchema,
  modelClasses: z.array(short).max(16).default([])
});
export const NodeCapabilityFactsSchema = z.strictObject({
  os: z.enum(["win32", "linux", "darwin", "other"]),
  arch: z.enum(["x64", "arm64", "ia32", "other"]),
  actionClasses: z.array(short).max(64),
  workspaces: z.array(WorkspaceSchema).max(128),
  runtimeAdapters: z.array(RuntimeAdapterSchema).max(32),
  load: z.strictObject({
    cpu: z.enum(["low", "medium", "high", "unknown"]),
    memory: z.enum(["low", "medium", "high", "unknown"]),
    gpu: z.enum(["low", "medium", "high", "unavailable", "unknown"])
  })
});
export type NodeCapabilityFacts = z.infer<typeof NodeCapabilityFactsSchema>;

export const NodeCapabilityManifestSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().min(1),
  observedAt: z.number().int().positive(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  facts: NodeCapabilityFactsSchema
});
export type NodeCapabilityManifest = z.infer<typeof NodeCapabilityManifestSchema>;

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
function canonicalFacts(value: unknown): NodeCapabilityFacts {
  const facts = NodeCapabilityFactsSchema.parse(value);
  return {
    ...facts,
    actionClasses: uniqueSorted(facts.actionClasses),
    workspaces: [...facts.workspaces]
      .map(workspace => ({ ...workspace, traits: uniqueSorted(workspace.traits) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    runtimeAdapters: [...facts.runtimeAdapters]
      .map(adapter => ({ ...adapter, modelClasses: uniqueSorted(adapter.modelClasses) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  };
}
function factsHash(facts: NodeCapabilityFacts): string {
  return createHash("sha256").update(JSON.stringify(facts), "utf8").digest("hex");
}

export function buildNodeCapabilityManifest(
  value: unknown,
  options: { previous?: NodeCapabilityManifest; observedAt?: number } = {}
): NodeCapabilityManifest {
  const facts = canonicalFacts(value);
  const hash = factsHash(facts);
  const previous = options.previous ? NodeCapabilityManifestSchema.parse(options.previous) : undefined;
  const revision = previous && previous.hash === hash ? previous.revision : (previous?.revision ?? 0) + 1;
  return NodeCapabilityManifestSchema.parse({
    version: 1,
    revision,
    observedAt: options.observedAt ?? Date.now(),
    hash,
    facts
  });
}

export function localNodePlatform(): Pick<NodeCapabilityFacts, "os" | "arch"> {
  const platform = os.platform();
  const arch = os.arch();
  return {
    os: platform === "win32" || platform === "linux" || platform === "darwin" ? platform : "other",
    arch: arch === "x64" || arch === "arm64" || arch === "ia32" ? arch : "other"
  };
}
