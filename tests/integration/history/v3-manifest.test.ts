import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { AgentSnapshot, StoredSession } from "../../../src/domain/history.js";
import {
  loadSnapshot,
  migrateHistorySnapshotToV3,
  restoreHistoryHead,
} from "../../../src/infrastructure/history-store.js";
import { collectHistoryGarbage, enforceStateQuota } from "../../../src/infrastructure/gc.js";
import { searchIndexExists, updateSearchIndex } from "../../../src/infrastructure/search-index.js";
import { ensurePrivateStateDirectory } from "../../../src/infrastructure/state.js";
import { listHistory, searchHistory } from "../../../src/application/history.js";

function sessionFixture(index: number, searchText: readonly string[]): StoredSession {
  const suffix = index.toString(16).padStart(64, "0");
  return {
    sessionRef: `ahsr1_codex_ck1_${suffix}`,
    agent: "codex",
    nativeId: `native-${index}`,
    title: `Session ${index}`,
    context: "/workspace",
    model: "gpt-test",
    provider: "openai",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: `2026-01-01T00:0${index % 10}:00.000Z`,
    nativeArchived: false,
    library: { name: "", tags: [], archived: false, deleted: false },
    conversation: [],
    searchText,
    rawFiles: [],
    native: {},
  };
}

async function writeV2Library(stateDirectory: string): Promise<{ snapshot: AgentSnapshot; headPath: string }> {
  const snapshotId = randomUUID();
  const snapshot: AgentSnapshot = {
    schemaVersion: "agenthist.history-snapshot/v2",
    snapshotId,
    agent: "codex",
    scannedAt: "2026-01-01T00:00:00.000Z",
    sessions: [
      sessionFixture(1, ["needle alpha searchable body"]),
      sessionFixture(2, ["unrelated body"]),
    ],
    auxiliaryFiles: [],
    warnings: [],
  };
  const root = path.join(stateDirectory, "history", "codex", "snapshots", snapshotId);
  await mkdir(path.join(root, "raw"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, "index.json"), JSON.stringify(snapshot));
  await writeFile(path.join(root, "raw", "session-1.jsonl"), "{}\n");
  const headPath = path.join(stateDirectory, "history", "codex", "head.json");
  await writeFile(headPath, JSON.stringify({
    schemaVersion: "agenthist.history-head/v1",
    snapshotId,
  }));
  return { snapshot, headPath };
}

test("v2 library migrates to a v3 manifest with a working FTS search index", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agenthist-v3-"));
  try {
    await ensurePrivateStateDirectory(stateDirectory);
    const { snapshot } = await writeV2Library(stateDirectory);
    const oldId = snapshot.snapshotId;
    const oldRoot = path.join(stateDirectory, "history", "codex", "snapshots", oldId);

    // Legacy reads keep working before migration, including searchText matching.
    const before = await loadSnapshot(stateDirectory, "codex");
    assert.equal(before?.sessions.length, 2);
    assert.deepEqual(before?.sessions[0]!.searchText, ["needle alpha searchable body"]);

    // The legacy read above already triggered the one-time lazy migration.
    assert.equal(await migrateHistorySnapshotToV3(stateDirectory, "codex"), false, "already migrated is a no-op");

    const head = JSON.parse(await readFile(path.join(stateDirectory, "history", "codex", "head.json"), "utf8")) as
      { snapshotId: string };
    assert.notEqual(head.snapshotId, oldId);
    const newRoot = path.join(stateDirectory, "history", "codex", "snapshots", head.snapshotId);
    const manifest = JSON.parse(await readFile(path.join(newRoot, "manifest.json"), "utf8")) as {
      schemaVersion: string;
      sessions: { sessionRef: string; searchText?: unknown }[];
    };
    assert.equal(manifest.schemaVersion, "agenthist.history-snapshot/v3");
    assert.ok(manifest.sessions.every((session) => session.searchText === undefined));
    assert.ok(await stat(path.join(newRoot, "search.json")));
    assert.ok(await stat(path.join(newRoot, "raw", "session-1.jsonl")));
    assert.ok(await searchIndexExists(stateDirectory, "codex"));

    // The retired v2 snapshot is pruned once the head moved on.
    await collectHistoryGarbage(stateDirectory, false);
    await assert.rejects(() => stat(path.join(oldRoot, "index.json")));

    // Body text lives in the FTS index and remains searchable after migration.
    const hits = await searchHistory({ stateDirectory }, "needle alpha");
    assert.equal(hits.total, 1);
    assert.equal(hits.hits[0]!.session.sessionRef, snapshot.sessions[0]!.sessionRef);
    assert.equal(hits.hits[0]!.field, "content");

    // Loaded sessions carry an empty searchText array; the manifest stays light.
    const loaded = await loadSnapshot(stateDirectory, "codex");
    assert.ok(loaded?.sessions.every((session) => session.searchText.length === 0));
    assert.equal((await listHistory({ stateDirectory })).total, 2);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("a v2 head can still be restored after a failed migration attempt", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agenthist-v3rb-"));
  try {
    await ensurePrivateStateDirectory(stateDirectory);
    const { snapshot } = await writeV2Library(stateDirectory);
    await assert.rejects(() => restoreHistoryHead(stateDirectory, "codex", "not-a-snapshot-id"));
    const head = JSON.parse(await readFile(path.join(stateDirectory, "history", "codex", "head.json"), "utf8")) as
      { snapshotId: string };
    assert.equal(head.snapshotId, snapshot.snapshotId, "head is unchanged after a rejected restore");
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("search self-heals when the derived FTS index is deleted (B2)", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agenthist-heal-"));
  try {
    await ensurePrivateStateDirectory(stateDirectory);
    await writeV2Library(stateDirectory);
    assert.equal(await migrateHistorySnapshotToV3(stateDirectory, "codex"), true);
    await rm(path.join(stateDirectory, "history", "codex", "search"), { recursive: true, force: true });
    assert.equal(await searchIndexExists(stateDirectory, "codex"), false);

    const hits = await searchHistory({ stateDirectory }, "needle alpha");
    assert.equal(hits.total, 1);
    assert.equal(await searchIndexExists(stateDirectory, "codex"), true, "index was rebuilt");
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("unchanged sessions produce zero index churn (B3)", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agenthist-churn-"));
  try {
    await ensurePrivateStateDirectory(stateDirectory);
    const sessions = [sessionFixture(1, ["needle alpha"]), sessionFixture(2, [])];
    const first = await updateSearchIndex(stateDirectory, "codex", sessions);
    assert.equal(first.added, 2);
    const indexPath = path.join(stateDirectory, "history", "codex", "search", "index.sqlite");
    const before = (await stat(indexPath)).size;
    const second = await updateSearchIndex(stateDirectory, "codex", sessions);
    assert.deepEqual(second, { added: 0, updated: 0, removed: 0 });
    assert.equal((await stat(indexPath)).size, before);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("state quota enforcement collects orphans when over budget (B4)", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agenthist-quota-"));
  const previous = process.env.AGENTHIST_STATE_QUOTA_BYTES;
  process.env.AGENTHIST_STATE_QUOTA_BYTES = "1024";
  try {
    await ensurePrivateStateDirectory(stateDirectory);
    await writeV2Library(stateDirectory);
    const orphan = path.join(stateDirectory, "history", "codex", "snapshots", `.prepare-${randomUUID()}`);
    await mkdir(path.join(orphan, "raw"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(orphan, "raw", "junk.bin"), "x".repeat(4096));

    const outcome = await enforceStateQuota(stateDirectory);
    assert.ok(outcome.collected !== null, "quota enforcement ran garbage collection");
    assert.equal(outcome.collected.entries.some((entry) => entry.path === orphan), true);
    await assert.rejects(() => stat(orphan));
  } finally {
    if (previous === undefined) delete process.env.AGENTHIST_STATE_QUOTA_BYTES;
    else process.env.AGENTHIST_STATE_QUOTA_BYTES = previous;
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
