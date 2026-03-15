import type { AgentToolDefinition } from './legacy-tools.js';

export const pickTools = (
  definitions: AgentToolDefinition[],
  toolNames: readonly string[]
): AgentToolDefinition[] => {
  const wanted = new Set(toolNames);
  return definitions.filter((tool) => wanted.has(tool.name));
};
