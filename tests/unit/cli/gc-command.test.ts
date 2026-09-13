import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { runCli } from "../../../src/cli/program.js";

async function writeSnapshot(stateDirectory: string, agent: string, name: string, body: string): Promise<string> {
  const root = path.join(stateDirectory, "history", agent, "snapshots", name);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "payload.txt"), body);
  return root;
}

test("gc removes orphan prepare workspaces and unreferenced snapshots, keeps the head snapshot", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agenthist-gc-"));
  try {
    const headId = randomUUID();
    const orphanPrepareId = randomUUID();
    const orphanSnapshotId = randomUUID();
    const headRoot = await writeSnapshot(stateDirectory, "codex", headId, "keep me");
    const orphanPrepareRoot = await writeSnapshot(stateDirectory, "codex", `.prepare-${orphanPrepareId}`, "crashed");
    const orphanSnapshotRoot = await writeSnapshot(stateDirectory, "claude", orphanSnapshotId, "stale");
    await mkdir(path.join(stateDirectory, "history", "codex"), { recursive: true });
    await writeFile(path.join(stateDirectory, "history", "codex", "head.json"), JSON.stringify({
      schemaVersion: "agenthist.history-head/v1",
      snapshotId: headId,
    }));

    const plan = await runCli(["--state-dir", stateDirectory, "--json", "gc", "--dry-run"]);
    assert.equal(plan.exitCode, 0);
    const planData = JSON.parse(plan.stdout) as { data: { entries: { kind: string; path: string }[]; freed_bytes: number } };
    assert.equal(planData.data.entries.length, 2);
    assert.ok(planData.data.entries.some((entry) => entry.kind === "orphan_prepare" && entry.path === orphanPrepareRoot));
    assert.ok(planData.data.entries.some((entry) => entry.kind === "orphan_snapshot" && entry.path === orphanSnapshotRoot));
    assert.ok((await readFile(path.join(headRoot, "payload.txt"))).toString() === "keep me");

    const applied = await runCli(["--state-dir", stateDirectory, "--json", "gc"]);
    assert.equal(applied.exitCode, 0);
    const appliedData = JSON.parse(applied.stdout) as { data: { freed_bytes: number } };
    assert.ok(appliedData.data.freed_bytes > 0);
    await assert.rejects(() => readFile(path.join(orphanPrepareRoot, "payload.txt")));
    await assert.rejects(() => readFile(path.join(orphanSnapshotRoot, "payload.txt")));
    assert.equal((await readFile(path.join(headRoot, "payload.txt"))).toString(), "keep me");

    const clean = await runCli(["--state-dir", stateDirectory, "--json", "gc"]);
    const cleanData = JSON.parse(clean.stdout) as { data: { entries: unknown[]; freed_bytes: number } };
    assert.equal(cleanData.data.entries.length, 0);
    assert.equal(cleanData.data.freed_bytes, 0);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("gc rejects unknown flags and help stays available", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agenthist-gc-"));
  try {
    const bad = await runCli(["--state-dir", stateDirectory, "gc", "--all"]);
    assert.notEqual(bad.exitCode, 0);
    const help = await runCli(["help", "gc"]);
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /^Usage:\n  agenthist gc/m);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
