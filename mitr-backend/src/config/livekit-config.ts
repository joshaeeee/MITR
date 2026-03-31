import { env } from './env.js';

export interface RequiredLivekitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
  agentName: string;
  tokenTtlSec: number;
}

export const livekitConfig = Object.freeze({
  get url() {
    return env.LIVEKIT_URL;
  },
  get apiKey() {
    return env.LIVEKIT_API_KEY;
  },
  get apiSecret() {
    return env.LIVEKIT_API_SECRET;
  },
  get agentName() {
    return env.LIVEKIT_AGENT_NAME;
  },
  get tokenTtlSec() {
    return env.LIVEKIT_TOKEN_TTL_SEC;
  }
});

export const getRequiredLivekitConfig = (): RequiredLivekitConfig | null => {
  if (!livekitConfig.url || !livekitConfig.apiKey || !livekitConfig.apiSecret) {
    return null;
  }

  return {
    url: livekitConfig.url,
    apiKey: livekitConfig.apiKey,
    apiSecret: livekitConfig.apiSecret,
    agentName: livekitConfig.agentName,
    tokenTtlSec: livekitConfig.tokenTtlSec
  };
};
