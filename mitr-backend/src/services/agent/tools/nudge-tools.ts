import type { AgentToolDefinition } from './legacy-tools.js';
import { pickTools } from './tool-groups.js';

export const NUDGE_TOOL_NAMES = ['nudge_pending_get', 'nudge_mark_listened'] as const;

export const selectNudgeTools = (definitions: AgentToolDefinition[]): AgentToolDefinition[] =>
  pickTools(definitions, NUDGE_TOOL_NAMES);
