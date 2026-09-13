import path from "node:path";

import type { ArchiveObjectBinding, ProjectedArchiveEntry } from "../../domain/archive.js";
import type { ArchiveObjectSource } from "../../infrastructure/archive.js";
import type {
  AgentAdapter,
  AgentPortableProjection,
  AgentSourceOptions,
  HistorySourceInspection,
  PreparedAgentArchive,
} from "../contracts.js";
import { failedSourceInspection } from "../source-support.js";
import { requirePortableSession } from "../portable-support.js";
import { discoverClaudeCarriers } from "./carrier.js";
import { claudeFamilyProfile, type ClaudeFamilyAgent } from "./family.js";
import {
  closeClaudeSelection,
  prepareClaudeArchive,
  validateClaudeArchiveEntries,
  validateClaudeArchiveObjects,
} from "./migration/archive.js";
import { prepareClaudeRestore, type RestoreClaudeResult } from "./migration/restore.js";
import {
  previewClaudeRecovery,
  previewClaudeRollback,
  recoverClaudeTransaction,
  rollbackClaudeTransaction,
} from "./migration/transaction.js";
import {
  projectPortableContextToClaude,
  writeClaudePortableProjection,
  type ClaudePortableProjection,
} from "./conversion/portable-projector.js";
import { prepareClaudePortableSource } from "./conversion/portable.js";
import { scanClaude } from "./scan.js";
import { requireClaudeSource, resolveClaudeSource, type ClaudeSourceOptions } from "./source.js";
import { launchClaudeSession } from "./launcher.js";

function sourceOptions(options: AgentSourceOptions): ClaudeSourceOptions {
  return {
    ...(options.historyRoot === undefined ? {} : { configRoot: options.historyRoot }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  };
}

function detectFamily(agent: ClaudeFamilyAgent) {
  return async (options: AgentSourceOptions): Promise<HistorySourceInspection> => {
    const profile = claudeFamilyProfile(agent);
    let source;
    try {
      source = resolveClaudeSource(sourceOptions(options), agent);
    } catch (error) {
      return failedSourceInspection(agent, [], "error", error);
    }
    const locations = [{ role: "config_root" as const, path: source.configRoot }];
    try {
      const carriers = await discoverClaudeCarriers(source.configRoot, agent);
      if (!carriers.some((carrier) => carrier.role === "main")) {
        return { agent, status: "not_detected", locations, findings: [] };
      }
      await requireClaudeSource(source, agent);
      return { agent, status: "ready", locations, findings: [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { agent, status: "not_detected", locations, findings: [] };
      }
      return failedSourceInspection(agent, locations, "blocked", error);
    }
  };
}

function claudeProjection(value: AgentPortableProjection, agent: ClaudeFamilyAgent): ClaudePortableProjection {
  if (value.targetAgent !== agent) {
    throw new Error(`${claudeFamilyProfile(agent).displayName} portable target received another Agent projection`);
  }
  return value as ClaudePortableProjection;
}

function nativeImportResult(result: RestoreClaudeResult) {
  return {
    target: { root: result.targetConfigRoot },
    items: result.items,
    newSessions: result.newSessions,
    alreadyPresent: result.alreadyPresent,
    resources: result.resources,
    ...(result.transactionRef === undefined ? {} : { transactionRef: result.transactionRef }),
  };
}

export function createClaudeFamilyAdapter<const A extends ClaudeFamilyAgent>(agent: A): AgentAdapter<A> {
  const profile = claudeFamilyProfile(agent);
  const detect = detectFamily(agent);
  return {
  id: agent as A,
  resume: { launch: (request) => launchClaudeSession(request, agent) },
  source: {
    detect,
    inspect: detect,
    async roots(options) {
      const source = resolveClaudeSource(sourceOptions(options), agent);
      await requireClaudeSource(source, agent);
      return [source.configRoot];
    },
    async scan(options) {
      return (await scanClaude({
        stateDirectory: options.stateDirectory,
        ...sourceOptions(options),
        familyAgent: agent,
      })).snapshot;
    },
  },
  archive: {
    closeExportSelection: closeClaudeSelection,
    async prepare(options): Promise<PreparedAgentArchive> {
      const sources: ArchiveObjectSource[] = [];
      const bindings = new Map<string, readonly ArchiveObjectBinding[]>();
      const sessions = [...options.sessions].sort((left, right) => left.sessionRef.localeCompare(right.sessionRef));
      for (const session of sessions) {
        const prepared = prepareClaudeArchive(
          options.stateDirectory,
          options.snapshot,
          session,
          options.allocateObjectId,
        );
        sources.push(...prepared.sources);
        bindings.set(session.sessionRef, prepared.bindings);
      }
      return { sessions, sources, bindings };
    },
    validateEntries: validateClaudeArchiveEntries,
    validateObjects: validateClaudeArchiveObjects,
    closeSelection(_entries, selected) {
      return selected;
    },
  },
  nativeImport: {
    async prepare(options) {
      const prepared = await prepareClaudeRestore({
        familyAgent: agent,
        stateDirectory: options.stateDirectory,
        entries: options.entries,
        objects: options.objects,
        pathMappings: options.pathMappings,
        workspace: options.workspace,
        ...sourceOptions(options.source),
      });
      return {
        result: nativeImportResult(prepared.result),
        async apply() {
          return nativeImportResult(await prepared.apply());
        },
      };
    },
  },
  transaction: {
    owns(journal) {
      return journal.agents.length === 1 && journal.agents[0] === agent &&
        journal.operation === "history_import";
    },
    previewRollback: previewClaudeRollback,
    rollback: rollbackClaudeTransaction,
    previewRecovery: previewClaudeRecovery,
    recover: recoverClaudeTransaction,
  },
  portableSource: {
    async create(options) {
      return {
        sessions: options.snapshot.sessions,
        prepare(sessionRef) {
          return prepareClaudePortableSource(
            options.stateDirectory,
            options.snapshot,
            requirePortableSession(options.snapshot.sessions, sessionRef),
          );
        },
      };
    },
  },
  portableTarget: {
    writeMode: "independent",
    project: (session, conversionKey) => projectPortableContextToClaude(session, conversionKey, agent),
    async write(options) {
      const sources: ArchiveObjectSource[] = [];
      const entries: ProjectedArchiveEntry[] = [];
      for (const item of options.projections) {
        const projection = claudeProjection(item.projection, agent);
        const objectId = options.allocateObjectId();
        const written = await writeClaudePortableProjection(
          agent,
          projection,
          objectId,
          path.join(options.workspace, `${objectId}.jsonl`),
          item.sourceUpdatedAt,
        );
        sources.push(...written.sources);
        entries.push(...written.entries);
      }
      return { sources, entries };
    },
  },
  } satisfies AgentAdapter<ClaudeFamilyAgent>;
}

export const claudeAdapter = createClaudeFamilyAdapter("claude");
