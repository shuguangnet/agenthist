import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { Agent } from "../domain/agent.js";
import {
  isHistorySnapshotId,
  MANIFEST_SCHEMA_VERSION,
  readLibraryMetadata,
  type AgentManifest,
  type AgentSnapshot,
  type LibraryMetadata,
  type StoredManifestSession,
  type StoredSession,
} from "../domain/history.js";
import { syncDirectory, syncDirectoryTree, writeJsonAtomic } from "./files.js";
import { loadLibraryOverlay } from "./library-store.js";
import { searchIndexExists, updateSearchIndex } from "./search-index.js";
import { ensurePrivateStateDirectory } from "./state.js";
import { retainedHistorySnapshotIds } from "./transaction-store.js";

export const SEARCH_SIDECAR_SCHEMA_VERSION = "agenthist.history-search/v1";

interface SearchSidecar {
  readonly schemaVersion: string;
  readonly texts: Readonly<Record<string, readonly string[]>>;
}

export interface SnapshotWorkspace {
  readonly id: string;
  readonly root: string;
  readonly rawRoot: string;
}

export function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  const leftToRight = path.relative(normalizedLeft, normalizedRight);
  const rightToLeft = path.relative(normalizedRight, normalizedLeft);
  return (
    leftToRight === "" ||
    (!leftToRight.startsWith(`..${path.sep}`) && leftToRight !== ".." && !path.isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith(`..${path.sep}`) && rightToLeft !== ".." && !path.isAbsolute(rightToLeft))
  );
}

export async function ensureStateDirectory(stateDirectory: string, sourceRoots: readonly string[]): Promise<void> {
  for (const sourceRoot of sourceRoots) {
    if (pathsOverlap(stateDirectory, sourceRoot)) {
      throw new Error(`state directory overlaps Agent source: ${sourceRoot}`);
    }
  }
  await ensurePrivateStateDirectory(stateDirectory);
}

function agentRoot(stateDirectory: string, agent: Agent): string {
  return path.join(stateDirectory, "history", agent);
}

function snapshotsRoot(stateDirectory: string, agent: Agent): string {
  return path.join(agentRoot(stateDirectory, agent), "snapshots");
}

export async function createSnapshotWorkspace(stateDirectory: string, agent: Agent): Promise<SnapshotWorkspace> {
  const id = randomUUID();
  const root = path.join(snapshotsRoot(stateDirectory, agent), `.prepare-${id}`);
  const rawRoot = path.join(root, "raw");
  await mkdir(rawRoot, { recursive: true, mode: 0o700 });
  return { id, root, rawRoot };
}

export async function discardSnapshot(workspace: SnapshotWorkspace): Promise<void> {
  await rm(workspace.root, { recursive: true, force: true });
}

export async function reuseSnapshotFile(
  stateDirectory: string,
  previous: AgentSnapshot,
  relativePath: string,
  workspace: SnapshotWorkspace,
): Promise<void> {
  const source = snapshotRawPath(stateDirectory, previous, relativePath);
  const destination = path.join(workspace.rawRoot, ...relativePath.split("/"));
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`reusable snapshot file is unavailable: ${relativePath}`);
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await link(source, destination);
}

function manifestForSnapshot(snapshot: AgentSnapshot): AgentManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    snapshotId: snapshot.snapshotId,
    agent: snapshot.agent,
    scannedAt: snapshot.scannedAt,
    sessions: snapshot.sessions.map((session) => manifestSession(session)),
    auxiliaryFiles: snapshot.auxiliaryFiles,
    warnings: snapshot.warnings,
    ...(snapshot.scan === undefined ? {} : { scan: snapshot.scan }),
  };
}

function manifestSession(session: StoredSession): StoredManifestSession {
  const { searchText: _searchText, ...rest } = session;
  return rest;
}

function searchSidecarForSnapshot(snapshot: AgentSnapshot): SearchSidecar {
  const texts: Record<string, readonly string[]> = {};
  for (const session of snapshot.sessions) {
    if (session.searchText.length !== 0) texts[session.sessionRef] = session.searchText;
  }
  return { schemaVersion: SEARCH_SIDECAR_SCHEMA_VERSION, texts };
}

function manifestPath(snapshotRoot: string): string {
  return path.join(snapshotRoot, "manifest.json");
}

function searchSidecarPath(snapshotRoot: string): string {
  return path.join(snapshotRoot, "search.json");
}

async function readSearchSidecar(snapshotRoot: string): Promise<Readonly<Record<string, readonly string[]>>> {
  let bytes: Buffer;
  try {
    bytes = await readFile(searchSidecarPath(snapshotRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const sidecar = JSON.parse(bytes.toString("utf8")) as SearchSidecar;
  if (sidecar.schemaVersion !== SEARCH_SIDECAR_SCHEMA_VERSION || typeof sidecar.texts !== "object") {
    throw new Error("invalid history search sidecar");
  }
  return sidecar.texts;
}

export async function publishSnapshot(
  stateDirectory: string,
  workspace: SnapshotWorkspace,
  snapshot: AgentSnapshot,
): Promise<readonly string[]> {
  if (snapshot.snapshotId !== workspace.id) {
    throw new Error("snapshot workspace identity mismatch");
  }
  await syncDirectoryTree(workspace.rawRoot);
  await writeJsonAtomic(manifestPath(workspace.root), manifestForSnapshot(snapshot));
  await writeJsonAtomic(searchSidecarPath(workspace.root), searchSidecarForSnapshot(snapshot));
  const root = snapshotsRoot(stateDirectory, snapshot.agent);
  const publishedRoot = path.join(root, workspace.id);
  await rename(workspace.root, publishedRoot);
  await syncDirectory(root);
  await writeJsonAtomic(path.join(agentRoot(stateDirectory, snapshot.agent), "head.json"), {
    schemaVersion: "agenthist.history-head/v1",
    snapshotId: workspace.id,
  });
  const warnings = await updateSearchIndexSafe(stateDirectory, snapshot.agent, snapshot.sessions);
  return [...warnings, ...await pruneHistorySnapshots(stateDirectory, snapshot.agent)];
}

async function updateSearchIndexSafe(
  stateDirectory: string,
  agent: Agent,
  sessions: readonly StoredSession[],
): Promise<readonly string[]> {
  try {
    await updateSearchIndex(stateDirectory, agent, sessions);
    return [];
  } catch (error) {
    return [`${agent} search index update failed: ${(error as Error).message}`];
  }
}

function cleanupMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : "unknown snapshot cleanup error";
  return Buffer.byteLength(value, "utf8") <= 4096 ? value : `${value.slice(0, 4093)}...`;
}

async function pruneHistorySnapshots(stateDirectory: string, agent: Agent): Promise<readonly string[]> {
  try {
    const root = snapshotsRoot(stateDirectory, agent);
    const retained = new Set(await retainedHistorySnapshotIds(stateDirectory, agent));
    const current = await loadHistoryHead(stateDirectory, agent);
    if (current !== null) retained.add(current);
    const entries = await readdir(root, { withFileTypes: true });
    const obsolete: string[] = [];
    for (const entry of entries) {
      const snapshotId = entry.name.startsWith(".prepare-") ? entry.name.slice(".prepare-".length) : entry.name;
      if (!isHistorySnapshotId(snapshotId)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`unsafe history snapshot entry: ${entry.name}`);
      }
      if (entry.name.startsWith(".prepare-") || !retained.has(snapshotId)) obsolete.push(entry.name);
    }
    for (const name of obsolete) await rm(path.join(root, name), { recursive: true, force: true });
    if (obsolete.length !== 0) await syncDirectory(root);
    return [];
  } catch (error) {
    return [`${agent} obsolete snapshot cleanup was skipped: ${cleanupMessage(error)}`];
  }
}

export async function loadSnapshot(stateDirectory: string, agent: Agent): Promise<AgentSnapshot | undefined> {
  const snapshotId = await loadHistoryHead(stateDirectory, agent);
  if (snapshotId === null) return undefined;
  const snapshotRoot = path.join(agentRoot(stateDirectory, agent), "snapshots", snapshotId);
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(manifestPath(snapshotRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return loadLegacySnapshot(stateDirectory, agent, snapshotRoot);
  }
  const manifest = parseManifest(manifestBytes, snapshotId, agent);
  const overlay = await loadLibraryOverlay(stateDirectory);
  const library = new Map<string, LibraryMetadata>();
  for (const entry of overlay.entries) {
    library.set(entry.sessionRef, {
      name: entry.name,
      tags: [...entry.tags],
      archived: entry.archived,
      deleted: entry.deleted,
    });
  }
  const sessions = manifest.sessions.map((session) => {
    const captured = readLibraryMetadata(session.library);
    if (captured === undefined || session.agent !== agent) throw new Error("invalid history snapshot");
    return storedSessionFromManifest(session, library.get(session.sessionRef) ?? captured);
  });
  return {
    schemaVersion: "agenthist.history-snapshot/v2",
    snapshotId,
    agent,
    scannedAt: manifest.scannedAt,
    sessions,
    auxiliaryFiles: manifest.auxiliaryFiles,
    warnings: manifest.warnings,
    ...(manifest.scan === undefined ? {} : { scan: manifest.scan }),
  };
}

function storedSessionFromManifest(
  session: StoredManifestSession,
  library: LibraryMetadata,
): StoredSession {
  return { ...session, library, searchText: [] };
}

function parseManifest(bytes: Buffer, snapshotId: string, agent: Agent): AgentManifest {
  const manifest = JSON.parse(bytes.toString("utf8")) as AgentManifest;
  if (
    manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    manifest.snapshotId !== snapshotId ||
    manifest.agent !== agent ||
    !Array.isArray(manifest.sessions) ||
    manifest.sessions.some((session) => !Array.isArray((session as { searchText?: unknown }).searchText ?? [])) ||
    manifest.sessions.some((session) => (session as { searchText?: unknown }).searchText !== undefined)
  ) {
    throw new Error("invalid history manifest");
  }
  return manifest;
}

async function loadLegacySnapshot(
  stateDirectory: string,
  agent: Agent,
  snapshotRoot: string,
): Promise<AgentSnapshot> {
  const bytes = await readFile(path.join(snapshotRoot, "index.json"));
  const snapshot = JSON.parse(bytes.toString("utf8")) as AgentSnapshot;
  if (
    snapshot.schemaVersion !== "agenthist.history-snapshot/v2" ||
    snapshot.snapshotId !== path.basename(snapshotRoot) ||
    snapshot.agent !== agent ||
    !Array.isArray(snapshot.sessions)
  ) {
    throw new Error("invalid history snapshot");
  }
  const overlay = await loadLibraryOverlay(stateDirectory);
  const library = new Map<string, LibraryMetadata>();
  for (const entry of overlay.entries) {
    library.set(entry.sessionRef, {
      name: entry.name,
      tags: [...entry.tags],
      archived: entry.archived,
      deleted: entry.deleted,
    });
  }
  const sessions = snapshot.sessions.map((session) => {
    const captured = readLibraryMetadata(session.library);
    if (
      captured === undefined || session.agent !== agent || !Array.isArray(session.searchText) ||
      session.searchText.some((value: unknown) => typeof value !== "string")
    ) throw new Error("invalid history snapshot");
    return { ...session, library: library.get(session.sessionRef) ?? captured };
  });
  await tryMigrateHistorySnapshot(stateDirectory, agent);
  return { ...snapshot, sessions };
}

/**
 * One-time v2 -> v3 migration: copy the head snapshot into a new v3 snapshot
 * (manifest.json + search.json + hard-linked raw files), rebuild the search
 * index, and swap the head atomically. The old v2 snapshot stays intact until
 * the head swap succeeds, so an interrupted migration rolls forward or leaves
 * the v2 head untouched; retired snapshots are pruned afterwards.
 */
export async function migrateHistorySnapshotToV3(stateDirectory: string, agent: Agent): Promise<boolean> {
  const snapshotId = await loadHistoryHead(stateDirectory, agent);
  if (snapshotId === null) return false;
  const snapshotRoot = path.join(agentRoot(stateDirectory, agent), "snapshots", snapshotId);
  let manifestAccessible = false;
  try {
    await readFile(manifestPath(snapshotRoot));
    manifestAccessible = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (manifestAccessible) return false;
  const bytes = await readFile(path.join(snapshotRoot, "index.json"));
  const snapshot = JSON.parse(bytes.toString("utf8")) as AgentSnapshot;
  if (
    snapshot.schemaVersion !== "agenthist.history-snapshot/v2" ||
    snapshot.snapshotId !== snapshotId || snapshot.agent !== agent || !Array.isArray(snapshot.sessions)
  ) {
    throw new Error("invalid history snapshot");
  }
    const workspace = await createSnapshotWorkspace(stateDirectory, agent);
    try {
      await copySnapshotRaw(path.join(snapshotRoot, "raw"), workspace.rawRoot);
    const migrated: AgentSnapshot = { ...snapshot, snapshotId: workspace.id };
    await syncDirectoryTree(workspace.rawRoot);
    await writeJsonAtomic(manifestPath(workspace.root), manifestForSnapshot(migrated));
    await writeJsonAtomic(searchSidecarPath(workspace.root), searchSidecarForSnapshot(migrated));
    const root = snapshotsRoot(stateDirectory, agent);
    await rename(workspace.root, path.join(root, workspace.id));
    await syncDirectory(root);
    await writeJsonAtomic(path.join(agentRoot(stateDirectory, agent), "head.json"), {
      schemaVersion: "agenthist.history-head/v1",
      snapshotId: workspace.id,
    });
    await updateSearchIndex(stateDirectory, agent, migrated.sessions);
    await pruneHistorySnapshots(stateDirectory, agent);
    return true;
  } catch (error) {
    await discardSnapshot(workspace);
    throw error;
  }
}

async function copySnapshotRaw(sourceRoot: string, destinationRoot: string): Promise<void> {
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(sourceRoot, entry.name);
    const destination = path.join(destinationRoot, entry.name);
    if (entry.isDirectory()) {
      await copySnapshotRaw(source, destination);
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`unsafe snapshot raw entry: ${entry.name}`);
    await link(source, destination);
  }
}

/** Best-effort migration: never fails the caller; returns whether it migrated. */
export async function tryMigrateHistorySnapshot(stateDirectory: string, agent: Agent): Promise<boolean> {
  try {
    return await migrateHistorySnapshotToV3(stateDirectory, agent);
  } catch {
    return false;
  }
}

/** Rebuild the derived search index from the head manifest and search sidecar. */
export async function rebuildSearchIndexFromSnapshot(stateDirectory: string, agent: Agent): Promise<boolean> {
  const snapshotId = await loadHistoryHead(stateDirectory, agent);
  if (snapshotId === null) return false;
  const snapshotRoot = path.join(agentRoot(stateDirectory, agent), "snapshots", snapshotId);
  const manifestBytes = await readFile(manifestPath(snapshotRoot));
  const manifest = parseManifest(manifestBytes, snapshotId, agent);
  const texts = await readSearchSidecar(snapshotRoot);
  const sessions: StoredSession[] = manifest.sessions.map((session) => ({
    ...session,
    searchText: [...(texts[session.sessionRef] ?? [])],
  }));
  await updateSearchIndex(stateDirectory, agent, sessions);
  return true;
}

export async function ensureSearchIndex(stateDirectory: string, agent: Agent): Promise<boolean> {
  const snapshotId = await loadHistoryHead(stateDirectory, agent);
  if (snapshotId === null) return false;
  const snapshotRoot = path.join(agentRoot(stateDirectory, agent), "snapshots", snapshotId);
  let manifestPresent = false;
  try {
    await lstat(manifestPath(snapshotRoot));
    manifestPresent = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!manifestPresent) return false;
  if (await searchIndexExists(stateDirectory, agent)) return false;
  await rebuildSearchIndexFromSnapshot(stateDirectory, agent);
  return true;
}

export async function loadHistoryHead(stateDirectory: string, agent: Agent): Promise<string | null> {
  let headBytes: Buffer;
  try {
    headBytes = await readFile(path.join(agentRoot(stateDirectory, agent), "head.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const head = JSON.parse(headBytes.toString("utf8")) as { schemaVersion?: unknown; snapshotId?: unknown };
  if (
    head.schemaVersion !== "agenthist.history-head/v1" ||
    typeof head.snapshotId !== "string" ||
    !isHistorySnapshotId(head.snapshotId)
  ) {
    throw new Error("invalid history head");
  }
  return head.snapshotId;
}

export async function restoreHistoryHead(
  stateDirectory: string,
  agent: Agent,
  snapshotId: string | null,
): Promise<void> {
  const root = agentRoot(stateDirectory, agent);
  const head = path.join(root, "head.json");
  if (snapshotId === null) {
    await rm(head, { force: true });
  } else {
    if (!isHistorySnapshotId(snapshotId)) throw new Error("invalid history snapshot identity");
    const snapshotRoot = path.join(root, "snapshots", snapshotId);
    let bytes: Buffer;
    try {
      bytes = await readFile(manifestPath(snapshotRoot));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      bytes = await readFile(path.join(snapshotRoot, "index.json"));
    }
    const snapshot = JSON.parse(bytes.toString("utf8")) as AgentSnapshot | AgentManifest;
    if (
      (snapshot.schemaVersion !== "agenthist.history-snapshot/v2" &&
        snapshot.schemaVersion !== MANIFEST_SCHEMA_VERSION) ||
      snapshot.snapshotId !== snapshotId || snapshot.agent !== agent
    ) {
      throw new Error("history snapshot cannot be restored");
    }
    await writeJsonAtomic(head, { schemaVersion: "agenthist.history-head/v1", snapshotId });
  }
  try {
    await syncDirectory(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function snapshotRawPath(stateDirectory: string, snapshot: AgentSnapshot, relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath.split(path.sep).includes("..")) {
    throw new Error("invalid snapshot raw path");
  }
  return path.join(agentRoot(stateDirectory, snapshot.agent), "snapshots", snapshot.snapshotId, "raw", relativePath);
}
