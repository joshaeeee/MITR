import { isAsyncToolRuntimeV2Enabled } from '../../../config/agent-worker-config.js';
import { env } from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';
import { AsyncToolRuntime } from '../../../agent-worker/async-tool-runtime.js';
import {
  type AgentToolDefinition,
  type ToolDeps,
  createLegacyToolDefinitions
} from './legacy-tools.js';
import { createNewsRetrieveTool } from './news-tools.js';
import { createWebSearchTool } from './web-tools.js';
import { createPanchangTool } from './panchang-tools.js';
import { createReligiousRetrieveTool } from './religious-tools.js';
import { createStoryRetrieveTool } from './story-tools.js';
import { createYoutubeMediaTool } from './youtube-tools.js';
import { selectMemoryTools } from './memory-tools.js';
import { selectNudgeTools } from './nudge-tools.js';
import { selectFlowTools } from './flow-tools.js';
import { pickTools } from './tool-groups.js';

const asyncRuntime = new AsyncToolRuntime();

const createToolDefinitionsV2 = (deps: ToolDeps): AgentToolDefinition[] => {
  const legacySync = createLegacyToolDefinitions(deps, {
    includeAsyncTools: false,
    logRegistration: false
  });

  const syncDefinitions: AgentToolDefinition[] = [
    ...selectMemoryTools(legacySync),
    ...pickTools(legacySync, ['current_datetime_get']),
    ...pickTools(legacySync, ['reminder_create', 'reminder_list']),
    ...selectNudgeTools(legacySync),
    ...pickTools(legacySync, ['devotional_playlist_get']),
    ...pickTools(legacySync, ['daily_briefing_get']),
    ...pickTools(legacySync, ['diary_add', 'diary_list']),
    ...selectFlowTools(legacySync),
    ...pickTools(legacySync, ['pranayama_guide_get', 'brain_game_get', 'festival_context_get']),
    ...pickTools(legacySync, ['medication_adherence_setup'])
  ];

  const asyncDefinitions: AgentToolDefinition[] = [
    createReligiousRetrieveTool(deps, asyncRuntime),
    createStoryRetrieveTool(deps, asyncRuntime),
    createNewsRetrieveTool(deps, asyncRuntime),
    createWebSearchTool(deps, asyncRuntime),
    createPanchangTool(deps, asyncRuntime),
    createYoutubeMediaTool(deps, asyncRuntime)
  ];

  const definitions = [...asyncDefinitions, ...syncDefinitions];
  logger.info('Agent tools registered', {
    tools: definitions.map((tool) => tool.name),
    runtime: 'v2'
  });

  return definitions;
};

export const createToolDefinitions = (deps: ToolDeps): AgentToolDefinition[] => {
  if (isAsyncToolRuntimeV2Enabled(env)) {
    return createToolDefinitionsV2(deps);
  }

  const definitions = createLegacyToolDefinitions(deps, { includeAsyncTools: true, logRegistration: false });
  logger.info('Agent tools registered', {
    tools: definitions.map((tool) => tool.name),
    runtime: 'legacy'
  });
  return definitions;
};

export type { AgentToolContext, AgentToolDefinition, ToolDeps } from './legacy-tools.js';
