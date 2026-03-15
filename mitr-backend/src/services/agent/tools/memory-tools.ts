import type { AgentToolDefinition } from './legacy-tools.js';
import { pickTools } from './tool-groups.js';

export const MEMORY_TOOL_NAMES = ['memory_add', 'memory_get'] as const;

export const selectMemoryTools = (definitions: AgentToolDefinition[]): AgentToolDefinition[] =>
  pickTools(definitions, MEMORY_TOOL_NAMES);
