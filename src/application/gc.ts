import { collectHistoryGarbage } from "../infrastructure/gc.js";
import { withStateWriteLock } from "../infrastructure/state.js";

export type { GcEntry, GcEntryKind, GcResult } from "../infrastructure/gc.js";

export interface CollectHistoryGarbageOptions {
  readonly stateDirectory: string;
  readonly dryRun?: boolean;
}

export async function collectGarbage(options: CollectHistoryGarbageOptions): Promise<
  Awaited<ReturnType<typeof collectHistoryGarbage>>
> {
  const dryRun = options.dryRun ?? false;
  return withStateWriteLock(options.stateDirectory, () =>
    collectHistoryGarbage(options.stateDirectory, dryRun));
}
