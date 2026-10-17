import type { ControllerEvent } from "./task-controller.js";
import type { TaskControllerSupervisor } from "./task-controller-supervisor.js";

/** Trusted, bounded durable inbox; wake is only a hint. The host owns the single
 * consumer lease and admission policy. peek() must retain an event until ack().
 * A redelivered event keeps its ID; neither enqueue nor wake grants authority. */
export interface ControllerEventSource {
  subscribe(wake: () => void): () => void;
  peek(): Promise<ControllerEvent | undefined>;
  ack(eventId: string): Promise<void>;
}

/** Opt-in lifecycle around the existing durable supervisor, not a scheduler.
 * The caller initializes/reopens its store and supplies already-authorized adapters.
 * No polling, inferred verdicts, provider selection or retry of a failed step.
 * Abort drains the in-flight step/ACK; it never kills or replays a worker. */
export async function runControllerService(
  supervisor: Pick<TaskControllerSupervisor, "step">,
  events: ControllerEventSource,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return;
  let revision = 0;
  let waiting: (() => void) | undefined;
  const wake = () => { revision++; waiting?.(); };
  signal.addEventListener("abort", wake, { once: true });
  let unsubscribe: (() => void) | undefined;
  try {
    // Subscribe before recovery/peek so an event at either boundary cannot be lost.
    unsubscribe = events.subscribe(wake);
    if (signal.aborted) return;
    let recovering = true;
    while (!signal.aborted) {
      const observed = revision;
      const event = await events.peek();
      if (signal.aborted) break;
      if (event) {
        // step persists the event before effects. ACK only after the entire cycle
        // succeeds; interrupted delivery is safely deduplicated on next startup.
        await supervisor.step(event);
        recovering = false; // This cycle also reconciles durable worker receipts.
        await events.ack(event.id);
        continue;
      }
      if (revision !== observed) continue;
      if (recovering) {
        // Pending owner/dependency events take precedence over startup dispatch.
        await supervisor.step();
        recovering = false;
        continue;
      }
      await new Promise<void>(resolve => {
        waiting = resolve;
        if (signal.aborted || revision !== observed) resolve();
      });
      waiting = undefined;
    }
  } finally {
    signal.removeEventListener("abort", wake);
    unsubscribe?.();
  }
}
