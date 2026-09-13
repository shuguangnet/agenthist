import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { claudeSessionRef } from "../../../src/agents/claude/identity.js";
import { runCli } from "../../../src/cli/program.js";
import { readScanResult } from "../../support/scan-result.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const FIRST_RECORD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_RECORD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";

function transcriptBytes(): string {
  return [
    JSON.stringify({
      type: "session_meta",
      sessionId: SESSION,
      timestamp: "2026-09-01T08:00:00.000Z",
      cwd: "/source/work",
      version: "qoder-fixture",
      data: { meta_type: "session_info", session_id: SESSION },
    }),
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: "Qoder session fixture question" },
      uuid: FIRST_RECORD,
      timestamp: "2026-09-01T08:00:01.000Z",
      cwd: "/source/work",
      sessionId: SESSION,
      version: "qoder-fixture",
    }),
    JSON.stringify({
      parentUuid: FIRST_RECORD,
      isSidechain: false,
      type: "assistant",
      message: {
        role: "assistant",
        type: "message",
        model: "qoder-test-model",
        content: [{ type: "text", text: "Qoder session fixture answer" }],
      },
      uuid: SECOND_RECORD,
      timestamp: "2026-09-01T08:00:02.000Z",
      cwd: "/source/work",
      sessionId: SESSION,
      version: "qoder-fixture",
    }),
    "",
  ].join("\n");
}

test("Qoder history is detected, scanned, searchable, and exportable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-qoder-"));
  try {
    const configRoot = path.join(root, ".qoder");
    const projectCarrier = "-source-work";
    const sessionDir = path.join(configRoot, "projects", projectCarrier);
    await mkdir(path.join(sessionDir, "transcript"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(sessionDir, "transcript", `${SESSION}.jsonl`), transcriptBytes(), { mode: 0o600 });
    await mkdir(path.join(sessionDir, SESSION), { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(sessionDir, SESSION, "state.json"),
      JSON.stringify({ sessionId: SESSION }),
      { mode: 0o600 },
    );

    const runtime = { environment: { HOME: root }, cwd: root, home: root };
    const doctor = await runCli(["--json", "doctor"], runtime);
    assert.equal(doctor.exitCode, 0, doctor.stderr);
    const doctorData = JSON.parse(doctor.stdout) as {
      data: { agents: readonly { agent: string; status: string; locations: readonly { path: string }[] }[] };
    };
    const qoderDoctor = doctorData.data.agents.find((agent) => agent.agent === "qoder");
    assert.equal(qoderDoctor?.status, "ready");
    assert.equal(qoderDoctor?.locations[0]?.path, configRoot);

    const stateDirectory = path.join(root, "state");
    const scanned = await runCli([
      "--json", "--state-dir", stateDirectory, "--qoder-config-dir", configRoot, "scan", "--agent", "qoder",
    ], runtime);
    assert.equal(scanned.exitCode, 0, scanned.stderr);
    const scan = readScanResult(scanned.stdout, "qoder");
    assert.equal(scan.sessions, 1);
    assert.equal(scan.agent.rebuiltSessions, 1);

    const expectedRef = claudeSessionRef(SESSION, FIRST_RECORD, "qoder");
    assert.match(expectedRef, /^ahsr1_qoder_ck1_[0-9a-f]{64}$/);

    const listed = await runCli(["--json", "--state-dir", stateDirectory, "history", "list"], runtime);
    assert.equal(listed.exitCode, 0, listed.stderr);
    const listData = JSON.parse(listed.stdout) as {
      data: { total_sessions: number; sessions: readonly { session_ref: string; title: string }[] };
    };
    assert.equal(listData.data.total_sessions, 1);
    assert.equal(listData.data.sessions[0]?.session_ref, expectedRef);

    const searched = await runCli([
      "--json", "--state-dir", stateDirectory, "history", "search", "fixture answer",
    ], runtime);
    assert.equal(searched.exitCode, 0, searched.stderr);
    const searchData = JSON.parse(searched.stdout) as { data: { total_hits: number; hits: readonly unknown[] } };
    assert.equal(searchData.data.total_hits, 1);
    assert.equal(searchData.data.hits.length, 1);

    const archive = path.join(root, "qoder.agenthist");
    const exported = await runCli([
      "--json", "--state-dir", stateDirectory, "export", "--all", "-o", archive,
    ], runtime);
    assert.equal(exported.exitCode, 0, exported.stderr);
    const exportData = JSON.parse(exported.stdout) as {
      data: { entries: number; agents: readonly { agent: string; sessions: number }[] };
    };
    assert.equal(exportData.data.entries, 1);
    assert.deepEqual(exportData.data.agents, [{ agent: "qoder", sessions: 1 }]);

    // The state directory snapshot manifest keeps the qoder agent identity.
    const state = JSON.parse(
      await readFile2(path.join(stateDirectory, "history", "qoder", "head.json")),
    ) as { snapshotId: string };
    assert.match(state.snapshotId, /^[0-9a-f-]{36}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function readFile2(filePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(filePath, "utf8");
}
