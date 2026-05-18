import type { AgentToolDefinition } from './legacy-tools.js';
import { pickTools } from './tool-groups.js';

export const MEMORY_TOOL_NAMES = [
  'memory_add',
  'reca_skill_get',
  'mem0_memory_add',
  'mem0_memory_search',
  'mem0_memory_list',
  'mem0_memory_get',
  'mem0_memory_update',
  'mem0_memory_delete',
  'memory_get'
] as const;

export const selectMemoryTools = (definitions: AgentToolDefinition[]): AgentToolDefinition[] =>
  pickTools(definitions, MEMORY_TOOL_NAMES);
