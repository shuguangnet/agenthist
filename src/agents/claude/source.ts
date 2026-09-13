import { lstat } from "node:fs/promises";
import path from "node:path";

import { runtimePathContext } from "../../infrastructure/runtime-paths.js";
import { claudeFamilyProfile, type ClaudeFamilyAgent } from "./family.js";

export interface ClaudeSourceOptions {
  readonly configRoot?: string;
  readonly cwd?: string;
  readonly home?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface ClaudeSource {
  readonly configRoot: string;
  readonly configRootSource: "explicit" | "environment" | "home";
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

export function resolveClaudeSource(
  options: ClaudeSourceOptions = {},
  agent: ClaudeFamilyAgent = "claude",
): ClaudeSource {
  const profile = claudeFamilyProfile(agent);
  const context = runtimePathContext(options);
  const environment = context.environment;
  const cwd = context.cwd;
  const explicit = nonBlank(options.configRoot);
  const configured = nonBlank(environment[profile.configDirEnvironment]);
  const home = context.home;
  const selected = explicit ?? configured ?? path.join(home, profile.defaultRootName);
  if (selected.includes("\0")) throw new Error(`${profile.displayName} config root contains NUL`);
  return {
    configRoot: path.resolve(cwd, selected),
    configRootSource: explicit !== undefined ? "explicit" : configured !== undefined ? "environment" : "home",
  };
}

export async function requireClaudeSource(
  source: ClaudeSource,
  agent: ClaudeFamilyAgent = "claude",
): Promise<void> {
  const profile = claudeFamilyProfile(agent);
  let info;
  try {
    info = await lstat(source.configRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${profile.displayName} config root does not exist: ${source.configRoot}`);
    }
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${profile.displayName} config root is not a real directory: ${source.configRoot}`);
  }
}
