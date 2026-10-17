import type { ControllerAction } from "./task-controller.js";

// Personal src/ builds independently of the cloud packages. A contract test pins this small catalog.
export const LOCAL_RUNTIME_PROVIDERS = ["chatgpt", "claude", "cursor"] as const;
export type RuntimeProvider = typeof LOCAL_RUNTIME_PROVIDERS[number];
function provider(value: RuntimeProvider): RuntimeProvider {
  if (!LOCAL_RUNTIME_PROVIDERS.includes(value)) throw Error("RUNTIME_PROVIDER_INVALID");
  return value;
}

type Dispatch = Extract<ControllerAction, { resources: string[] }>;
export type RuntimeDispatchAdapter = {
  // Includes authentication, required tools, policy, health and capacity, without model requests.
  available(action: Dispatch): Promise<boolean>;
  // The adapter owns scheduler admission and durable run receipts.
  launch(action: Dispatch): Promise<"started" | "conflict" | "not_started">;
};
export type RuntimeRoutingResult =
  | { state: "started"; provider: RuntimeProvider }
  | { state: "blocked"; reason: "no_available_runtime" | "resource_conflict" | "unknown_outcome" | "runtime_pinned"; provider?: RuntimeProvider };

/** The caller must durably pin the choice before launch, and retain it for repairs/restarts.
 * A thrown launch is ambiguous. Only an authoritative not_started result permits fallback.
 * This policy never probes arbitrary tools, grants permission, or interprets worker output as commands.
 */
export async function routeControllerDispatch(input: {
  action: Dispatch;
  preferred?: RuntimeProvider;
  pinned?: RuntimeProvider;
  adapters: Partial<Record<RuntimeProvider, RuntimeDispatchAdapter>>;
  persistChoice(provider: RuntimeProvider): Promise<void>;
}): Promise<RuntimeRoutingResult> {
  const first = provider(input.preferred ?? "chatgpt");
  const order = input.pinned ? [provider(input.pinned)] : [first, ...LOCAL_RUNTIME_PROVIDERS.filter(name => name !== first)];
  for (const provider of order) {
    const adapter = input.adapters[provider];
    if (!adapter) continue;
    let ready = false;
    try { ready = await adapter.available(input.action); } catch { /* A failed readiness probe starts no work. */ }
    if (!ready) continue;
    // Failure to persist is not permission to try another runtime.
    await input.persistChoice(provider);
    let outcome: Awaited<ReturnType<RuntimeDispatchAdapter["launch"]>>;
    try { outcome = await adapter.launch(input.action); }
    catch { return { state: "blocked", reason: "unknown_outcome", provider }; }
    if (outcome === "started") return { state: "started", provider };
    if (outcome === "conflict") return { state: "blocked", reason: "resource_conflict", provider };
    if (outcome !== "not_started") return { state: "blocked", reason: "unknown_outcome", provider };
  }
  return { state: "blocked", reason: input.pinned ? "runtime_pinned" : "no_available_runtime", ...(input.pinned ? { provider: input.pinned } : {}) };
}
