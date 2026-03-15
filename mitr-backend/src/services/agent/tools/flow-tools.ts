import type { AgentToolDefinition } from './legacy-tools.js';
import { pickTools } from './tool-groups.js';

export const FLOW_TOOL_NAMES = ['flow_start', 'flow_next', 'flow_stop'] as const;

export const selectFlowTools = (definitions: AgentToolDefinition[]): AgentToolDefinition[] =>
  pickTools(definitions, FLOW_TOOL_NAMES);
