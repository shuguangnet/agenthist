import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

import type { StoredSession } from "../../src/domain/history.js";
import { listHistory, searchHistory } from "../../src/application/history.js";
import { ensurePrivateStateDirectory } from "../../src/infrastructure/state.js";
import {
  rebuildSearchIndexFromSnapshot,
  loadSnapshot,
} from "../../src/infrastructure/history-store.js";
import { updateSearchIndex } from "../../src/infrastructure/search-index.js";

const SESSION_COUNT = Number(process.env.AGENTHIST_BENCH_SESSIONS ?? "10000");

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)]!;
}

function sessionFixture(index: number): StoredSession {
  const suffix = index.toString(16).padStart(64, "0");
  return {
    sessionRef: `ahsr1_codex_ck1_${suffix}`,
    agent: "codex",
    nativeId: `rollout-${index}`,
    title: `Benchmark session ${index}`,
    context: "/workspace/benchmark",
    model: "gpt-bench",
    provider: "openai",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index % 60, index % 60)).toISOString(),
    nativeArchived: false,
    library: { name: "", tags: [], archived: false, deleted: false },
    conversation: [
      { kind: "message", role: "user", text: `Question ${index} about benchmarking history search`, timestamp: "2026-01-01T00:00:00.000Z" },
      { kind: "message", role: "assistant", text: `Answer ${index}: the quick brown fox; needle appears only in session 7.`, timestamp: "2026-01-01T00:00:01.000Z" },
    ],
    searchText: [`sidecar evidence ${index}`, "recurring working method"],
    rawFiles: [],
    native: {},
  };
}

async function writeV3Library(stateDirectory: string): Promise<void> {
  const snapshotId = "00000000-0000-4000-8000-000000000001";
  const sessions = Array.from({ length: SESSION_COUNT }, (_, index) => sessionFixture(index));
  const manifest = {
    schemaVersion: "agenthist.history-snapshot/v3",
    snapshotId,
    agent: "codex",
    scannedAt: "2026-01-01T00:00:00.000Z",
    sessions: sessions.map(({ searchText: _searchText, ...rest }) => rest),
    auxiliaryFiles: [],
    warnings: [],
  };
  const texts: Record<string, readonly string[]> = {};
  for (const session of sessions) texts[session.sessionRef] = session.searchText;
  const root = path.join(stateDirectory, "history", "codex", "snapshots", snapshotId);
  await mkdir(path.join(root, "raw"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(root, "search.json"), JSON.stringify({
    schemaVersion: "agenthist.history-search/v1",
    texts,
  }));
  await writeFile(path.join(root, "raw", "rollouts.jsonl"), "{}\n".repeat(SESSION_COUNT));
  await writeFile(path.join(stateDirectory, "history", "codex", "head.json"), JSON.stringify({
    schemaVersion: "agenthist.history-head/v1",
    snapshotId,
  }));
}

async function measure(label: string, runs: number, action: () => Promise<unknown>): Promise<readonly number[]> {
  await action();
  const samples: number[] = [];
  for (let index = 0; index < runs; index++) {
    const start = performance.now();
    await action();
    samples.push(performance.now() - start);
  }
  console.log(
    `${label}: p50 ${percentile(samples, 0.5).toFixed(1)} ms | p95 ${percentile(samples, 0.95).toFixed(1)} ms` +
    ` (n=${runs})`,
  );
  return samples;
}

async function measureOnly(stateDirectory: string): Promise<void> {
  const list = await measure("A2 history list", 25, () => listHistory({ stateDirectory }));
  const search = await measure("A3 history search", 25, () => searchHistory({ stateDirectory }, "needle"));
  globalThis.gc?.();
  console.log(`RSS after A2+A3 (no conversation bodies loaded): ${(process.memoryUsage().rss / (1024 * 1024)).toFixed(0)} MB`);
  const noChange = await measure("A4 no-change reload+index (loads conversations)", 10, async () => {
    const snapshot = await loadSnapshot(stateDirectory, "codex");
    if (snapshot === undefined) throw new Error("missing snapshot");
    const summary = await updateSearchIndex(stateDirectory, "codex", snapshot.sessions);
    if (summary.added !== 0 || summary.updated !== 0 || summary.removed !== 0) {
      throw new Error(`expected zero index churn, got ${JSON.stringify(summary)}`);
    }
  });
  console.log("");
  console.log("Acceptance targets: A2 list p50 <=200ms, A3 search p95 <=300ms, A4 no-change <=1000ms with zero index churn.");
  if (percentile(list, 0.5) > 200) console.log("A2 p50 EXCEEDS 200 ms");
  if (percentile(search, 0.95) > 300) console.log("A3 p95 EXCEEDS 300 ms");
  if (percentile(noChange, 0.95) > 1000) console.log("A4 p95 EXCEEDS 1000 ms");
  console.log(`RSS in measurement process: ${(process.memoryUsage().rss / (1024 * 1024)).toFixed(0)} MB`);
}

async function main(): Promise<void> {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agenthist-bench-"));
  try {
    await ensurePrivateStateDirectory(stateDirectory);
    const buildStart = performance.now();
    await writeV3Library(stateDirectory);
    await rebuildSearchIndexFromSnapshot(stateDirectory, "codex");
    console.log(`fixture: ${SESSION_COUNT} sessions built in ${(performance.now() - buildStart).toFixed(0)} ms`);
    if (process.env.AGENTHIST_BENCH_KEEP !== undefined) {
      console.log(stateDirectory);
      return;
    }
    // Measure in a clean child process so fixture-build allocations do not
    // pollute the reported RSS high-water mark.
    const child = spawnSync(process.execPath, ["--expose-gc", process.argv[1]!, stateDirectory], {
      encoding: "utf8",
      env: { ...process.env, AGENTHIST_BENCH_CHILD: "1" },
    });
    process.stdout.write(child.stdout);
    if (child.status !== 0) process.stderr.write(child.stderr);
    process.exitCode = child.status ?? 1;
  } finally {
    if (process.env.AGENTHIST_BENCH_CHILD === undefined &&
        process.env.AGENTHIST_BENCH_KEEP === undefined) {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  }
}

if (process.env.AGENTHIST_BENCH_CHILD !== undefined) {
  await measureOnly(process.argv[2]!);
} else {
  await main();
}
