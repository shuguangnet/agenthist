import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { AGENTS, type Agent } from "../domain/agent.js";
import { isHistorySnapshotId } from "../domain/history.js";
import { loadHistoryHead } from "./history-store.js";
import { retainedHistorySnapshotIds } from "./transaction-store.js";

export type GcEntryKind = "orphan_prepare" | "orphan_snapshot";

export interface GcEntry {
  readonly kind: GcEntryKind;
  readonly agent: Agent;
  readonly path: string;
  readonly bytes: number;
}

export interface GcPlan {
  readonly entries: readonly GcEntry[];
  readonly warnings: readonly string[];
}

export interface GcResult extends GcPlan {
  readonly dryRun: boolean;
  readonly freedBytes: number;
}

function snapshotsRoot(stateDirectory: string, agent: Agent): string {
  return path.join(stateDirectory, "history", agent, "snapshots");
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(entryPath);
    } else {
      const info = await stat(entryPath);
      total += info.size;
    }
  }
  return total;
}

async function planAgentSnapshots(stateDirectory: string, agent: Agent, warnings: readonly string[]): Promise<GcPlan> {
  const root = snapshotsRoot(stateDirectory, agent);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], warnings };
    return {
      entries: [],
      warnings: [...warnings, `${agent} snapshot scan was skipped: ${(error as Error).message}`],
    };
  }
  let retained: Set<string>;
  try {
    retained = new Set(await retainedHistorySnapshotIds(stateDirectory, agent));  } catch (error) {
    return { entries: [], warnings: [...warnings, `${agent} retained snapshot lookup failed: ${(error as Error).message}`] };
  }
  try {
    const head = await loadHistoryHead(stateDirectory, agent);
    if (head !== null) retained.add(head);
  } catch (error) {
    return { entries: [], warnings: [...warnings, `${agent} history head is unreadable: ${(error as Error).message}`] };
  }
  const planned = [...warnings];
  const orphan: GcEntry[] = [];
  for (const entry of entries) {
    const orphanKind: GcEntryKind | undefined = entry.name.startsWith(".prepare-")
      ? "orphan_prepare"
      : isHistorySnapshotId(entry.name) && !retained.has(entry.name)
        ? "orphan_snapshot"
        : undefined;
    if (orphanKind === undefined) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      planned.push(`unsafe ${agent} snapshot entry was skipped: ${entry.name}`);
      continue;
    }
    const entryPath = path.join(root, entry.name);
    try {
      orphan.push({ kind: orphanKind, agent, path: entryPath, bytes: await directoryBytes(entryPath) });
    } catch (error) {
      planned.push(`${agent} snapshot size measurement failed for ${entry.name}: ${(error as Error).message}`);
    }
  }
  return { entries: orphan, warnings: planned };
}

export async function planHistoryGarbage(stateDirectory: string): Promise<GcPlan> {
  let warnings: readonly string[] = [];
  const entries: GcEntry[] = [];
  for (const agent of AGENTS) {
    const plan = await planAgentSnapshots(stateDirectory, agent, warnings);
    entries.push(...plan.entries);
    warnings = plan.warnings;
  }
  return { entries, warnings };
}

export async function collectHistoryGarbage(stateDirectory: string, dryRun: boolean): Promise<GcResult> {
  const { entries, warnings } = await planHistoryGarbage(stateDirectory);
  let freedBytes = 0;
  if (!dryRun) {
    for (const entry of entries) {
      await rm(entry.path, { recursive: true, force: true });
      freedBytes += entry.bytes;
    }
  }
  return { dryRun, entries, warnings, freedBytes };
}

export const DEFAULT_STATE_QUOTA_BYTES = 512 * 1024 * 1024;
const QUOTA_ENVIRONMENT_VARIABLE = "AGENTHIST_STATE_QUOTA_BYTES";

export function stateQuotaBytes(environment: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = environment[QUOTA_ENVIRONMENT_VARIABLE];
  if (raw === undefined || raw === "") return DEFAULT_STATE_QUOTA_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${QUOTA_ENVIRONMENT_VARIABLE} must be a positive integer byte count`);
  }
  return value;
}

export interface StateQuotaOutcome {
  readonly totalBytes: number;
  readonly quotaBytes: number;
  readonly collected: GcResult | null;
}

/** Enforce the state-directory budget: garbage-collect orphans when over quota. */
export async function enforceStateQuota(stateDirectory: string): Promise<StateQuotaOutcome> {
  const quotaBytes = stateQuotaBytes();
  const totalBytes = await directoryBytes(stateDirectory);
  if (totalBytes <= quotaBytes) return { totalBytes, quotaBytes, collected: null };
  const collected = await collectHistoryGarbage(stateDirectory, false);
  const afterBytes = await directoryBytes(stateDirectory);
  return { totalBytes: afterBytes, quotaBytes, collected };
}
