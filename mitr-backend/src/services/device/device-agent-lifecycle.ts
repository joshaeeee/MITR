export type PersistentAgentState = 'not_dispatched' | 'dispatching' | 'ready' | 'failed' | 'ended';

export type PersistentAgentDispatchDecision =
  | { shouldDispatch: true; reason: 'not_dispatched' | 'failed' | 'dispatch_timeout' | 'ready_stale' }
  | { shouldDispatch: false; reason: 'dispatching' | 'ready' | 'ended' };

export const normalizeWakeId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

export const decidePersistentAgentDispatch = (input: {
  agentState: PersistentAgentState;
  agentLastSeenAtMs: number | null;
  nowMs: number;
  readyTimeoutMs: number;
  staleMs: number;
}): PersistentAgentDispatchDecision => {
  if (input.agentState === 'ended') {
    return { shouldDispatch: false, reason: 'ended' };
  }
  if (input.agentState === 'not_dispatched') {
    return { shouldDispatch: true, reason: 'not_dispatched' };
  }
  if (input.agentState === 'failed') {
    return { shouldDispatch: true, reason: 'failed' };
  }

  const ageMs = input.agentLastSeenAtMs === null ? Number.POSITIVE_INFINITY : input.nowMs - input.agentLastSeenAtMs;
  if (input.agentState === 'dispatching') {
    return ageMs > input.readyTimeoutMs
      ? { shouldDispatch: true, reason: 'dispatch_timeout' }
      : { shouldDispatch: false, reason: 'dispatching' };
  }

  return ageMs > input.staleMs
    ? { shouldDispatch: true, reason: 'ready_stale' }
    : { shouldDispatch: false, reason: 'ready' };
};
