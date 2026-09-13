import type { AgentAdapter } from "../contracts.js";
import { createClaudeFamilyAdapter } from "../claude/adapter.js";

// Qoder shares the Claude Code transcript format; the family adapter binds the
// Qoder profile (config root, environment variable, launcher, identity).
export const qoderAdapter = createClaudeFamilyAdapter("qoder");
