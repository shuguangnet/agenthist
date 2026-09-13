import type { Agent } from "../../domain/agent.js";

/**
 * Claude-family Agents share the Claude Code transcript format. Qoder stores a
 * documented, format-compatible transcript under its own config root; the
 * family profile captures everything that differs between the two.
 */
export type ClaudeFamilyAgent = "claude" | "qoder";

export const CLAUDE_FAMILY_AGENTS: readonly ClaudeFamilyAgent[] = ["claude", "qoder"];

export interface ClaudeFamilyProfile {
  readonly agent: ClaudeFamilyAgent;
  readonly displayName: string;
  readonly defaultRootName: ".claude" | ".qoder";
  readonly configDirEnvironment: "CLAUDE_CONFIG_DIR" | "QODER_CONFIG_DIR";
  readonly command: string;
  /** Native subdirectory (below `projects/<project>/`) holding main transcripts. */
  readonly mainTranscriptDirectory?: "transcript";
}

const PROFILES: Readonly<Record<ClaudeFamilyAgent, ClaudeFamilyProfile>> = {
  claude: {
    agent: "claude",
    displayName: "Claude Code",
    defaultRootName: ".claude",
    configDirEnvironment: "CLAUDE_CONFIG_DIR",
    command: "claude",
  },
  qoder: {
    agent: "qoder",
    displayName: "Qoder",
    defaultRootName: ".qoder",
    configDirEnvironment: "QODER_CONFIG_DIR",
    command: "qoder",
    mainTranscriptDirectory: "transcript",
  },
};

export function isClaudeFamilyAgent(value: Agent): value is ClaudeFamilyAgent {
  return value === "claude" || value === "qoder";
}

export function claudeFamilyProfile(agent: ClaudeFamilyAgent): ClaudeFamilyProfile {
  return PROFILES[agent]!;
}
