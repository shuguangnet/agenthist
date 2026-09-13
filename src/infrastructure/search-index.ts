import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { Agent } from "../domain/agent.js";
import type { ConversationItem, StoredSession } from "../domain/history.js";

const SEARCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_ref TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS search_text (
  session_ref TEXT NOT NULL,
  line TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS search_text_session ON search_text(session_ref);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(text, session_ref UNINDEXED);
CREATE TABLE IF NOT EXISTS summaries (
  session_ref TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  context TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  native_archived INTEGER NOT NULL,
  library_name TEXT NOT NULL,
  library_tags TEXT NOT NULL,
  archived INTEGER NOT NULL,
  deleted INTEGER NOT NULL
);
`;

export interface IndexedSessionSummary {
  readonly sessionRef: string;
  readonly title: string;
  readonly context: string;
  readonly model: string;
  readonly provider: string;
  readonly updatedAt: string;
  readonly nativeArchived: boolean;
  readonly libraryName: string;
  readonly libraryTags: readonly string[];
  readonly archived: boolean;
  readonly deleted: boolean;
}

function summaryValues(session: StoredSession): readonly (string | number)[] {
  return [
    session.sessionRef,
    session.title,
    session.context,
    session.model,
    session.provider,
    session.updatedAt,
    session.nativeArchived ? 1 : 0,
    session.library.name,
    JSON.stringify(session.library.tags),
    session.library.archived ? 1 : 0,
    session.library.deleted ? 1 : 0,
  ];
}

const SUMMARY_COLUMNS = "session_ref, title, context, model, provider, updated_at, native_archived, library_name, library_tags, archived, deleted";
const SUMMARY_PLACEHOLDERS = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";

/** Read compact session summaries for list views without loading conversations. */
export async function listSessionSummaries(
  stateDirectory: string,
  agent: Agent,
): Promise<readonly IndexedSessionSummary[] | null> {
  if (!(await searchIndexExists(stateDirectory, agent))) return null;
  const database = new DatabaseSync(searchIndexPath(stateDirectory, agent), { readOnly: true });
  try {
    const rows = database.prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM summaries ORDER BY updated_at DESC, session_ref ASC`,
    ).all() as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sessionRef: row.session_ref as string,
      title: row.title as string,
      context: row.context as string,
      model: row.model as string,
      provider: row.provider as string,
      updatedAt: row.updated_at as string,
      nativeArchived: row.native_archived === 1,
      libraryName: row.library_name as string,
      libraryTags: JSON.parse(row.library_tags as string) as readonly string[],
      archived: row.archived === 1,
      deleted: row.deleted === 1,
    }));
  } catch {
    return null;
  } finally {
    database.close();
  }
}

export interface SearchIndexHandle {
  readonly database: DatabaseSync;
  readonly path: string;
}

export interface IndexUpdateSummary {
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
}

export function searchIndexPath(stateDirectory: string, agent: Agent): string {
  return path.join(stateDirectory, "history", agent, "search", "index.sqlite");
}

function conversationSearchLines(item: ConversationItem): readonly string[] {
  if (item.kind === "gap") return item.label === "" ? [] : [item.label];
  return [
    ...(item.text === "" ? [] : [item.text]),
    ...(item.portableNotes ?? []).filter((note) => note !== ""),
    ...(item.portableBlocks ?? []).map((block) => JSON.stringify(block)).filter((line) => line !== "{}"),
  ];
}

export function sessionSearchLines(session: StoredSession): readonly string[] {
  return [
    session.sessionRef,
    session.nativeId,
    session.title,
    session.context,
    session.model,
    session.provider,
    session.library.name,
    ...session.library.tags,
    ...session.conversation.flatMap(conversationSearchLines),
    ...session.searchText,
  ].map((value) => value.trim()).filter((value) => value !== "");
}

export function sessionFingerprint(session: StoredSession): string {
  return session.scan?.fingerprint ?? `${session.updatedAt}|${session.title}`;
}

export async function searchIndexExists(stateDirectory: string, agent: Agent): Promise<boolean> {
  try {
    const database = new DatabaseSync(searchIndexPath(stateDirectory, agent), { readOnly: true });
    database.exec("PRAGMA cache_size = -1024");
    try {
      const row = database.prepare(
        "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name IN ('sessions', 'search_text')",
      ).get() as { count: number };
      return row.count === 2;
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

async function openForWrite(stateDirectory: string, agent: Agent): Promise<DatabaseSync> {
  await mkdir(path.dirname(searchIndexPath(stateDirectory, agent)), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(searchIndexPath(stateDirectory, agent));
  database.exec("PRAGMA journal_mode = DELETE");
  return database;
}

export async function replaceSearchIndex(
  stateDirectory: string,
  agent: Agent,
  sessions: readonly StoredSession[],
): Promise<IndexUpdateSummary> {
  const database = await openForWrite(stateDirectory, agent);
  try {
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("BEGIN");
    database.exec("DROP TABLE IF EXISTS search");
    database.exec("DROP TABLE IF EXISTS search_text");
    database.exec("DROP TABLE IF EXISTS sessions");
    database.exec(SEARCH_SCHEMA);
    const insertSession = database.prepare("INSERT INTO sessions (session_ref, fingerprint) VALUES (?, ?)");
    const insertLine = database.prepare("INSERT INTO search_text (session_ref, line) VALUES (?, ?)");
    const insertFts = database.prepare("INSERT INTO search (session_ref, text) VALUES (?, ?)");
    for (const session of sessions) {
      const lines = sessionSearchLines(session);
      insertSession.run(session.sessionRef, sessionFingerprint(session));
      for (const line of lines) insertLine.run(session.sessionRef, line);
      if (lines.length !== 0) insertFts.run(session.sessionRef, lines.join("\n"));
      database.prepare(`INSERT INTO summaries (${SUMMARY_COLUMNS}) VALUES (${SUMMARY_PLACEHOLDERS})`)
        .run(...summaryValues(session));
    }
    database.exec("COMMIT");
    return { added: sessions.length, updated: 0, removed: 0 };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* close releases the transaction */ }
    throw error;
  } finally {
    database.close();
  }
}

export async function updateSearchIndex(
  stateDirectory: string,
  agent: Agent,
  sessions: readonly StoredSession[],
): Promise<IndexUpdateSummary> {
  const database = await openForWrite(stateDirectory, agent);
  try {
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec(SEARCH_SCHEMA);
    database.exec("BEGIN");
    const known = new Map<string, string>();
    for (const row of database.prepare("SELECT session_ref, fingerprint FROM sessions").all() as unknown as
      Array<{ session_ref: string; fingerprint: string }>) {
      known.set(row.session_ref, row.fingerprint);
    }
    const byRef = new Map(sessions.map((session) => [session.sessionRef, session]));
    let added = 0;
    let updated = 0;
    let removed = 0;
    const removeSession = database.prepare("DELETE FROM sessions WHERE session_ref = ?");
    const removeLines = database.prepare("DELETE FROM search_text WHERE session_ref = ?");
    const removeFts = database.prepare("DELETE FROM search WHERE session_ref = ?");
    for (const [sessionRef, fingerprint] of known) {
      const session = byRef.get(sessionRef);
      if (session !== undefined && sessionFingerprint(session) === fingerprint) continue;
      removeSession.run(sessionRef);
      removeLines.run(sessionRef);
      removeFts.run(sessionRef);
      database.prepare("DELETE FROM summaries WHERE session_ref = ?").run(sessionRef);
      if (session === undefined) removed++; else updated++;
    }
    const insertSession = database.prepare("INSERT INTO sessions (session_ref, fingerprint) VALUES (?, ?)");
    const insertLine = database.prepare("INSERT INTO search_text (session_ref, line) VALUES (?, ?)");
    const insertFts = database.prepare("INSERT INTO search (session_ref, text) VALUES (?, ?)");
    for (const session of sessions) {
      if (known.get(session.sessionRef) === sessionFingerprint(session)) continue;
      const lines = sessionSearchLines(session);
      insertSession.run(session.sessionRef, sessionFingerprint(session));
      for (const line of lines) insertLine.run(session.sessionRef, line);
      if (lines.length !== 0) insertFts.run(session.sessionRef, lines.join("\n"));
      database.prepare(`INSERT INTO summaries (${SUMMARY_COLUMNS}) VALUES (${SUMMARY_PLACEHOLDERS})`)
        .run(...summaryValues(session));
      added++;
    }
    database.exec("COMMIT");
    return { added, updated, removed };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* close releases the transaction */ }
    throw error;
  } finally {
    database.close();
  }
}

/** Replace the indexed text of a single session after a library mutation. */
export async function updateSessionSearchIndex(
  stateDirectory: string,
  agent: Agent,
  session: StoredSession,
): Promise<void> {
  if (!(await searchIndexExists(stateDirectory, agent))) return;
  const database = await openForWrite(stateDirectory, agent);
  try {
    database.exec("BEGIN");
    database.prepare("DELETE FROM sessions WHERE session_ref = ?").run(session.sessionRef);
    database.prepare("DELETE FROM search_text WHERE session_ref = ?").run(session.sessionRef);
    database.prepare("DELETE FROM search WHERE session_ref = ?").run(session.sessionRef);
    database.prepare("DELETE FROM summaries WHERE session_ref = ?").run(session.sessionRef);
    const lines = sessionSearchLines(session);
    database.prepare("INSERT INTO sessions (session_ref, fingerprint) VALUES (?, ?)").run(
      session.sessionRef, sessionFingerprint(session));
    for (const line of lines) {
      database.prepare("INSERT INTO search_text (session_ref, line) VALUES (?, ?)").run(session.sessionRef, line);
    }
    if (lines.length !== 0) {
      database.prepare("INSERT INTO search (session_ref, text) VALUES (?, ?)").run(
        session.sessionRef, lines.join("\n"));
    }
    database.prepare(`INSERT INTO summaries (${SUMMARY_COLUMNS}) VALUES (${SUMMARY_PLACEHOLDERS})`)
      .run(...summaryValues(session));
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* close releases the transaction */ }
    throw error;
  } finally {
    database.close();
  }
}

export interface SearchIndexMatch {
  readonly sessionRef: string;
  readonly snippet: string;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function snippetFor(line: string, query: string): string {
  const index = line.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return line.slice(0, 240);
  const start = Math.max(0, index - 40);
  return (start > 0 ? "..." : "") + line.slice(start, start + 240) + (start + 240 < line.length ? "..." : "");
}

/**
 * Resolve the session references matching a query in the derived search index.
 * The FTS5 MATCH path handles token queries; a LIKE pass over the stored lines
 * preserves the substring semantics that in-memory search previously provided
 * (including CJK runs, which unicode61 tokenization cannot match). Snippets are
 * fetched separately per page so full result sets never enter memory.
 */
export async function searchMatchRefs(
  stateDirectory: string,
  agent: Agent,
  query: string,
): Promise<ReadonlySet<string>> {
  const refs = new Set<string>();
  const database = new DatabaseSync(searchIndexPath(stateDirectory, agent), { readOnly: true });
  database.exec("PRAGMA cache_size = -1024");
  try {
    const tokens = query.split(/\s+/).filter((token) => token !== "");
    if (tokens.length !== 0) {
      const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" ");
      const rows = database.prepare(
        "SELECT session_ref FROM search WHERE search MATCH ?",
      ).all(match) as unknown as Array<{ session_ref: string }>;
      for (const row of rows) refs.add(row.session_ref);
    }
    const rows = database.prepare(
      "SELECT DISTINCT session_ref FROM search_text WHERE line LIKE ? ESCAPE '\\'",
    ).all(`%${escapeLike(query)}%`) as unknown as Array<{ session_ref: string }>;
    for (const row of rows) refs.add(row.session_ref);
  } finally {
    database.close();
  }
  return refs;
}

/** Find the first indexed line containing the query, for search snippets. */
export async function searchMatchSnippet(
  stateDirectory: string,
  agent: Agent,
  sessionRef: string,
  query: string,
): Promise<string> {
  const database = new DatabaseSync(searchIndexPath(stateDirectory, agent), { readOnly: true });
  database.exec("PRAGMA cache_size = -1024");
  try {
    const rows = database.prepare(
      "SELECT line FROM search_text WHERE session_ref = ? AND line LIKE ? ESCAPE '\\' LIMIT 1",
    ).all(sessionRef, `%${escapeLike(query)}%`) as unknown as Array<{ line: string }>;
    return rows.length === 0 ? "" : snippetFor(rows[0]!.line, query);
  } finally {
    database.close();
  }
}
