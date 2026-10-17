export const AGENT_NAMES: readonly string[];
export function agentName(id: string): string;
export interface MonitorContext { project: string | null; directory: string | null; taskId: string | null; pr: number | null; inferred: boolean }
export function contextSummary(meta?: Record<string, unknown>): MonitorContext;
export function commandSummary(tool: string, meta?: Record<string, unknown>): string;

export function commandPreview(tool: string, meta?: Record<string, unknown>): string;
