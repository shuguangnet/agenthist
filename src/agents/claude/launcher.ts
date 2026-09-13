import type { AgentLaunchSpec, AgentResumeRequest } from "../contracts.js";
import { claudeFamilyProfile, type ClaudeFamilyAgent } from "./family.js";

export function launchClaudeSession(
  request: AgentResumeRequest,
  agent: ClaudeFamilyAgent = "claude",
): AgentLaunchSpec {
  return { command: claudeFamilyProfile(agent).command, args: ["--resume", request.nativeId], cwd: request.cwd };
}
