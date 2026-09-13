import { homedir } from "node:os";

import packageMetadata from "../../package.json" with { type: "json" };
import { resolveStateDirectory } from "../application/index.js";
import {
  failure,
  invalidArguments,
  readValue,
  type CliResult,
  type CliRuntime,
  type GlobalOptions,
} from "./command-support.js";
import { commandHelp, rootHelp } from "./help.js";

type CommandRunner = (
  globals: GlobalOptions,
  args: readonly string[],
  runtime: CliRuntime,
) => Promise<CliResult>;

// Command modules load lazily so that --help, --version, and argument errors
// do not pay the import cost of every command implementation.
const commandLoaders: Readonly<Record<string, () => Promise<{ runner: CommandRunner }>>> = {
  doctor: async () => ({ runner: (await import("./history-command.js")).runDoctor }),
  scan: async () => ({ runner: (await import("./history-command.js")).runScan }),
  history: async () => ({ runner: (await import("./history-command.js")).runHistory }),
  resume: async () => ({ runner: (await import("./resume-command.js")).runResume }),
  experience: async () => ({ runner: (await import("./experience-command.js")).runExperience }),
  skill: async () => ({ runner: (await import("./skill-command.js")).runSkill }),
  export: async () => ({ runner: (await import("./transfer-command.js")).runExport }),
  inspect: async () => ({ runner: (await import("./transfer-command.js")).runInspect }),
  import: async () => ({ runner: (await import("./transfer-command.js")).runImport }),
  transaction: async () => ({ runner: (await import("./maintenance-command.js")).runTransaction }),
  codex: async () => ({ runner: (await import("./maintenance-command.js")).runCodex }),
  gc: async () => ({ runner: (await import("./maintenance-command.js")).runGc }),
};

export type { CliResult, CliRuntime } from "./command-support.js";

export const VERSION = packageMetadata.version;

function parseGlobals(args: readonly string[], runtime: CliRuntime): [GlobalOptions, readonly string[]] {
  let index = 0;
  let json = false;
  let explicitState: string | undefined;
  let codexHome: string | undefined;
  let sqliteHome: string | undefined;
  let profile: string | undefined;
  let opencodeDataRoot: string | undefined;
  let opencodeDatabase: string | undefined;
  let claudeConfigRoot: string | undefined;
  let qoderConfigRoot: string | undefined;
  let piSessionRoot: string | undefined;
  while (index < args.length) {
    const argument = args[index]!;
    if (argument === "--json") {
      json = true;
      index++;
      continue;
    }
    let destination: "state" | "codex" | "sqlite" | "profile" | "opencode-root" | "opencode-db" |
      "claude-root" | "qoder-root" | "pi-root" | undefined;
    if (argument === "--state-dir" || argument.startsWith("--state-dir=")) destination = "state";
    if (argument === "--codex-home" || argument.startsWith("--codex-home=")) destination = "codex";
    if (argument === "--codex-sqlite-home" || argument.startsWith("--codex-sqlite-home=")) destination = "sqlite";
    if (argument === "--codex-profile" || argument.startsWith("--codex-profile=")) destination = "profile";
    if (argument === "--opencode-data-root" || argument.startsWith("--opencode-data-root=")) destination = "opencode-root";
    if (argument === "--opencode-db" || argument.startsWith("--opencode-db=")) destination = "opencode-db";
    if (argument === "--claude-config-dir" || argument.startsWith("--claude-config-dir=")) destination = "claude-root";
    if (argument === "--qoder-config-dir" || argument.startsWith("--qoder-config-dir=")) destination = "qoder-root";
    if (argument === "--pi-session-dir" || argument.startsWith("--pi-session-dir=")) destination = "pi-root";
    if (destination === undefined) break;
    const [value, next] = readValue(args, index, argument.split("=")[0]!);
    index = next;
    if (destination === "state") explicitState = value;
    if (destination === "codex") codexHome = value;
    if (destination === "sqlite") sqliteHome = value;
    if (destination === "profile") profile = value;
    if (destination === "opencode-root") opencodeDataRoot = value;
    if (destination === "opencode-db") opencodeDatabase = value;
    if (destination === "claude-root") claudeConfigRoot = value;
    if (destination === "qoder-root") qoderConfigRoot = value;
    if (destination === "pi-root") piSessionRoot = value;
  }
  const environment = runtime.environment ?? process.env;
  const cwd = runtime.cwd ?? process.cwd();
  const home = runtime.home ?? environment.HOME ?? homedir();
  const stateDirectory = resolveStateDirectory({
    ...(explicitState === undefined ? {} : { explicit: explicitState }),
    environment,
    cwd,
    home,
  });
  return [
    {
      json,
      color: runtime.color === true,
      stateDirectory,
      ...(codexHome === undefined ? {} : { codexHome }),
      ...(sqliteHome === undefined ? {} : { sqliteHome }),
      ...(profile === undefined ? {} : { profile }),
      ...(opencodeDataRoot === undefined ? {} : { opencodeDataRoot }),
      ...(opencodeDatabase === undefined ? {} : { opencodeDatabase }),
      ...(claudeConfigRoot === undefined ? {} : { claudeConfigRoot }),
      ...(qoderConfigRoot === undefined ? {} : { qoderConfigRoot }),
      ...(piSessionRoot === undefined ? {} : { piSessionRoot }),
    },
    args.slice(index),
  ];
}

export async function runCli(args: readonly string[], runtime: CliRuntime = {}): Promise<CliResult> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { exitCode: 0, stdout: rootHelp(runtime.color === true), stderr: "" };
  }
  if (args[0] === "--version" || args[0] === "-v") {
    return { exitCode: 0, stdout: `${VERSION}\n`, stderr: "" };
  }
  let json = args.includes("--json");
  let attemptedCommand = "unknown";
  try {
    const [globals, commandArgs] = parseGlobals(args, runtime);
    const command = commandArgs[0];
    json = globals.json;
    attemptedCommand = command ?? "unknown";
    if (command === "help" || command === "--help" || command === "-h") {
      if (commandArgs.length === 1) {
        return { exitCode: 0, stdout: rootHelp(globals.color && !globals.json), stderr: "" };
      }
      if (commandArgs.length !== 2) throw invalidArguments("help accepts at most one command");
      const help = commandHelp(commandArgs[1]!, globals.color && !globals.json);
      if (help === undefined) throw invalidArguments(`unknown help command: ${commandArgs[1]}`);
      return { exitCode: 0, stdout: help, stderr: "" };
    }
    if (command === "version" || command === "--version" || command === "-v") {
      if (commandArgs.length !== 1) throw invalidArguments("version accepts no arguments");
      return { exitCode: 0, stdout: `${VERSION}\n`, stderr: "" };
    }
    if (commandArgs.slice(1).some((argument) => argument === "--help" || argument === "-h")) {
      const help = command === undefined ? undefined : commandHelp(command, globals.color && !globals.json);
      if (help === undefined) throw invalidArguments(`unknown help command: ${command ?? ""}`);
      return { exitCode: 0, stdout: help, stderr: "" };
    }
    const loader = command === undefined ? undefined : commandLoaders[command];
    if (loader === undefined) throw invalidArguments(`unknown command: ${command ?? ""}`);
    const { runner } = await loader();
    return await runner(globals, commandArgs.slice(1), runtime);
  } catch (error) {
    return failure(attemptedCommand, error, json, runtime.color === true);
  }
}
