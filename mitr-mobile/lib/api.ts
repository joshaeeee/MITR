import AsyncStorage from '@react-native-async-storage/async-storage';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Alert,
  AlertSeverity,
  AlertStatus,
  DeviceInfo,
  ElderProfile,
  ElderStatusSnapshot,
  EscalationStage,
  FamilyMember,
  InsightOverview,
  Nudge,
  NudgePriority,
  Reminder,
  Routine,
  TriggerType,
  User
} from '@/constants/types';

const DEFAULT_API_BASE_URL = '';
const API_BASE_URL = (process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '');
const DEV_EMAIL = process.env.EXPO_PUBLIC_DEV_EMAIL;
const DEV_PASSWORD = process.env.EXPO_PUBLIC_DEV_PASSWORD;
const DEV_NAME = process.env.EXPO_PUBLIC_DEV_NAME ?? 'Family Caregiver';
const ACCESS_TOKEN_KEY = 'mitr_access_token';
const REFRESH_TOKEN_KEY = 'mitr_refresh_token';

let accessToken: string | null = process.env.EXPO_PUBLIC_ACCESS_TOKEN ?? null;
let refreshToken: string | null = null;
let loaded = false;
let ensurePromise: Promise<void> | null = null;

const loadSessionFromStorage = async (): Promise<void> => {
  if (loaded) return;
  loaded = true;
  const [storedAccess, storedRefresh] = await Promise.all([
    AsyncStorage.getItem(ACCESS_TOKEN_KEY),
    AsyncStorage.getItem(REFRESH_TOKEN_KEY)
  ]);
  accessToken = accessToken ?? storedAccess;
  refreshToken = storedRefresh;
};

const persistSession = async (session: { accessToken: string; refreshToken: string }): Promise<void> => {
  accessToken = session.accessToken;
  refreshToken = session.refreshToken;
  await Promise.all([
    AsyncStorage.setItem(ACCESS_TOKEN_KEY, session.accessToken),
    AsyncStorage.setItem(REFRESH_TOKEN_KEY, session.refreshToken)
  ]);
};

const clearSession = async (): Promise<void> => {
  accessToken = null;
  refreshToken = null;
  await Promise.all([
    AsyncStorage.removeItem(ACCESS_TOKEN_KEY),
    AsyncStorage.removeItem(REFRESH_TOKEN_KEY)
  ]);
};

type ApiOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
  auth?: boolean;
};

const request = async <T>(path: string, options: ApiOptions = {}): Promise<T> => {
  await loadSessionFromStorage();

  const method = options.method ?? 'GET';
  const authRequired = options.auth ?? true;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };

  if (authRequired) {
    await ensureAuthenticated();
    if (!accessToken) {
      throw new Error('Missing access token. Set EXPO_PUBLIC_ACCESS_TOKEN or EXPO_PUBLIC_DEV_EMAIL/EXPO_PUBLIC_DEV_PASSWORD.');
    }
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const requestUrl = `${API_BASE_URL}${path}`;
  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Network request failed: ${requestUrl} (${message})`);
  }

  if (response.status === 401 && authRequired && refreshToken) {
    const refreshed = await tryRefreshSession();
    if (refreshed) {
      return request<T>(path, options);
    }
  }

  const text = await response.text();
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const looksJson = contentType.includes('application/json') || /^\s*[\[{]/.test(text);
  let json: unknown = {};
  if (text.length > 0 && looksJson) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      const preview = text.slice(0, 180).replace(/\s+/g, ' ');
      throw new Error(`Invalid JSON from ${requestUrl} (${response.status}). Response starts with: ${preview}`);
    }
  } else if (text.length > 0) {
    const preview = text.slice(0, 180).replace(/\s+/g, ' ');
    throw new Error(`Non-JSON response from ${requestUrl} (${response.status}). Check EXPO_PUBLIC_API_URL. Response starts with: ${preview}`);
  }

  if (!response.ok) {
    const message =
      typeof json === 'object' && json && 'error' in (json as Record<string, unknown>)
        ? String((json as Record<string, unknown>).error)
        : `${response.status} ${response.statusText} (${requestUrl})`;
    throw new Error(message);
  }

  return json as T;
};

const tryRefreshSession = async (): Promise<boolean> => {
  if (!refreshToken) return false;
  try {
    const result = await request<{ session: { accessToken: string; refreshToken: string } }>('/auth/session/refresh', {
      method: 'POST',
      body: { refreshToken },
      auth: false
    });
    await persistSession(result.session);
    return true;
  } catch {
    await clearSession();
    return false;
  }
};

const loginWithEmail = async (email: string, password: string): Promise<void> => {
  const result = await request<{ session: { accessToken: string; refreshToken: string } }>('/auth/email/login', {
    method: 'POST',
    body: { email, password },
    auth: false
  });
  await persistSession(result.session);
};

const signupWithEmail = async (email: string, password: string): Promise<void> => {
  const result = await request<{ session: { accessToken: string; refreshToken: string } }>('/auth/email/signup', {
    method: 'POST',
    body: { email, password, name: DEV_NAME },
    auth: false
  });
  await persistSession(result.session);
};

export interface OtpChallengeResult {
  challengeId: string;
  expiresAt: number;
  devOtpCode?: string;
}

export interface OnboardingStatusResult {
  completed: boolean;
  profile: Record<string, string> | null;
}

export interface OnboardingPayload {
  elderName: string;
  elderAge: string;
  elderCity: string;
  elderLanguage: string;
  familyMembers: Array<{ id: string; name: string; relation: string; phone: string }>;
  medicalConditions: string;
  allergies: string;
  notes: string;
  medicines: Array<{ id: string; name: string; dosage: string; time: string }>;
  deviceCode: string;
}

export const hasActiveSession = async (): Promise<boolean> => {
  await loadSessionFromStorage();
  return Boolean(accessToken);
};

export const startOtpChallenge = async (phone: string): Promise<OtpChallengeResult> => {
  const normalized = phone.replace(/\D/g, '');
  return request<OtpChallengeResult>('/auth/otp/start', {
    method: 'POST',
    body: { phone: normalized },
    auth: false
  });
};

export const verifyOtpChallenge = async (input: {
  challengeId: string;
  code: string;
  name?: string;
}): Promise<void> => {
  const result = await request<{ session: { accessToken: string; refreshToken: string } }>('/auth/otp/verify', {
    method: 'POST',
    body: input,
    auth: false
  });
  await persistSession(result.session);
};

export const loginWithEmailSession = async (email: string, password: string): Promise<void> => {
  await loginWithEmail(email, password);
};

export const signupWithEmailSession = async (input: {
  email: string;
  password: string;
  name?: string;
}): Promise<void> => {
  const result = await request<{ session: { accessToken: string; refreshToken: string } }>('/auth/email/signup', {
    method: 'POST',
    body: { email: input.email, password: input.password, name: input.name?.trim() || DEV_NAME },
    auth: false
  });
  await persistSession(result.session);
};

export const getOnboardingStatus = async (): Promise<OnboardingStatusResult> => {
  return request<OnboardingStatusResult>('/onboarding/status');
};

export const submitOnboardingAnswers = async (answers: Record<string, string>): Promise<void> => {
  await request('/onboarding/submit', {
    method: 'POST',
    body: { answers }
  });
};

export const upsertElderProfile = async (input: {
  name: string;
  ageRange?: string;
  language?: string;
  city?: string;
  timezone?: string;
}): Promise<void> => {
  await request('/elder/profile', {
    method: 'PATCH',
    body: input
  });
};

export const linkElderDevice = async (input: {
  serialNumber: string;
  firmwareVersion?: string;
}): Promise<void> => {
  await request('/elder/device/link', {
    method: 'POST',
    body: input
  });
};

export const createCareReminder = async (input: {
  title: string;
  description?: string;
  scheduledTime: string;
  enabled?: boolean;
}): Promise<void> => {
  await request('/care/reminders', {
    method: 'POST',
    body: input
  });
};

export const inviteFamilyMember = async (input: {
  displayName?: string;
  email?: string;
  phone?: string;
  role?: 'owner' | 'member';
}): Promise<void> => {
  await request('/family/invite', {
    method: 'POST',
    body: input
  });
};

export const getFamilyMembersRaw = async (): Promise<Array<Record<string, unknown>>> => {
  const res = await request<{ items: Array<Record<string, unknown>> }>('/family/members');
  return res.items;
};

export const getElderProfileRaw = async (): Promise<Record<string, unknown> | null> => {
  const res = await request<{ profile: Record<string, unknown> | null }>('/elder/profile');
  return res.profile;
};

export const getCareRemindersRaw = async (): Promise<Array<Record<string, unknown>>> => {
  const res = await request<{ items: Array<Record<string, unknown>> }>('/care/reminders');
  return res.items;
};

export const ensureAuthenticated = async (): Promise<void> => {
  await loadSessionFromStorage();
  if (accessToken) return;
  if (!DEV_EMAIL || !DEV_PASSWORD) return;

  if (!ensurePromise) {
    ensurePromise = (async () => {
      try {
        await loginWithEmail(DEV_EMAIL, DEV_PASSWORD);
      } catch {
        await signupWithEmail(DEV_EMAIL, DEV_PASSWORD);
      }
    })().finally(() => {
      ensurePromise = null;
    });
  }

  await ensurePromise;
};

export const useEnsureAuthenticated = () => {
  return useQuery({
    queryKey: ['auth', 'ensure'],
    queryFn: async () => {
      await ensureAuthenticated();
      return { ready: Boolean(accessToken) };
    },
    staleTime: 5 * 60 * 1000
  });
};

export const useOnboardingStatus = () =>
  useQuery({
    queryKey: ['onboarding', 'status'],
    queryFn: async () => getOnboardingStatus()
  });

const severityOrder: Record<AlertSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
};

const inferTrigger = (title: string, details: string): TriggerType => {
  const hay = `${title} ${details}`.toLowerCase();
  if (hay.includes('medic')) return 'missed_reminder';
  if (hay.includes('distress')) return 'distress_language';
  if (hay.includes('offline') || hay.includes('device')) return 'device_offline';
  return 'inactivity';
};

const mapEscalationStage = (status: AlertStatus, severity: AlertSeverity): EscalationStage => {
  if (severity === 'critical') return 'emergency_contact';
  if (severity === 'high' || status === 'acknowledged') return 'family_alert';
  return 'elder_nudge';
};

const toAlert = (item: Record<string, unknown>): Alert => {
  const id = String(item.id ?? 'unknown-alert');
  const status = (item.status as AlertStatus) ?? 'open';
  const severity = (item.severity as AlertSeverity) ?? 'low';
  const createdAt = String(item.createdAt ?? new Date().toISOString());
  const acknowledgedAt = typeof item.acknowledgedAt === 'number' ? new Date(item.acknowledgedAt).toISOString() : undefined;
  const resolvedAt = typeof item.resolvedAt === 'number' ? new Date(item.resolvedAt).toISOString() : undefined;

  return {
    id,
    title: String(item.title ?? 'Alert'),
    description: String(item.details ?? item.description ?? ''),
    severity,
    status,
    trigger: inferTrigger(String(item.title ?? ''), String(item.details ?? '')),
    escalationStage: mapEscalationStage(status, severity),
    createdAt,
    acknowledgedAt,
    acknowledgedBy: typeof item.acknowledgedAt === 'number' ? 'Family member' : undefined,
    resolvedAt,
    resolvedBy: typeof item.resolvedAt === 'number' ? 'Family member' : undefined,
    timeline: [
      {
        id: `${id}-created`,
        action: 'Alert created',
        actor: 'System',
        timestamp: createdAt,
        stage: 'elder_nudge'
      },
      ...(acknowledgedAt
        ? [
            {
              id: `${id}-ack`,
              action: 'Alert acknowledged',
              actor: 'Family member',
              timestamp: acknowledgedAt,
              stage: 'family_alert' as EscalationStage
            }
          ]
        : []),
      ...(resolvedAt
        ? [
            {
              id: `${id}-resolved`,
              action: 'Alert resolved',
              actor: 'Family member',
              timestamp: resolvedAt,
              stage: 'family_alert' as EscalationStage
            }
          ]
        : [])
    ]
  };
};

const mapDayLabel = (ts: number): string =>
  new Date(ts).toLocaleDateString('en-IN', {
    weekday: 'short'
  });

const mapWeekLabel = (index: number): string => `W${index + 1}`;

const toInsights = (payload: Record<string, unknown>, period: '7d' | '30d'): InsightOverview => {
  const moodPoints = Array.isArray(payload.moodTrend) ? (payload.moodTrend as Array<{ ts: number; score: number }>) : [];
  const engagementPoints = Array.isArray(payload.engagementTrend)
    ? (payload.engagementTrend as Array<{ ts: number; score: number }>)
    : [];
  const points = period === '7d' ? moodPoints.slice(-7) : moodPoints.slice(-30);
  const ep = period === '7d' ? engagementPoints.slice(-7) : engagementPoints.slice(-30);

  const dailyMoods =
    period === '7d'
      ? points.map((p) => ({ day: mapDayLabel(p.ts), score: Number((p.score * 10).toFixed(1)) }))
      : Array.from({ length: 4 }, (_, i) => {
          const chunk = points.slice(i * Math.ceil(points.length / 4), (i + 1) * Math.ceil(points.length / 4));
          const avg = chunk.length ? chunk.reduce((a, b) => a + b.score, 0) / chunk.length : 0;
          return { day: mapWeekLabel(i), score: Number((avg * 10).toFixed(1)) };
        });

  const dailyEngagement =
    period === '7d'
      ? ep.map((p) => ({ day: mapDayLabel(p.ts), minutes: Math.round(p.score * 60) }))
      : Array.from({ length: 4 }, (_, i) => {
          const chunk = ep.slice(i * Math.ceil(ep.length / 4), (i + 1) * Math.ceil(ep.length / 4));
          const avg = chunk.length ? chunk.reduce((a, b) => a + b.score, 0) / chunk.length : 0;
          return { day: mapWeekLabel(i), minutes: Math.round(avg * 60) };
        });

  const avgMood = dailyMoods.length ? dailyMoods.reduce((a, b) => a + b.score, 0) / dailyMoods.length : 0;
  const avgEng = dailyEngagement.length
    ? dailyEngagement.reduce((a, b) => a + b.minutes, 0) / dailyEngagement.length
    : 0;

  const topics = Array.isArray(payload.keyTopics)
    ? (payload.keyTopics as Array<{ topic: string; score: number }>).map((t) => ({
        topic: t.topic,
        count: Math.max(1, Math.round(t.score * 50))
      }))
    : [];

  const concerns = Array.isArray(payload.concernSignals)
    ? (payload.concernSignals as Array<Record<string, unknown>>).map((c, idx) => ({
        id: String(c.id ?? `c-${idx}`),
        label: String(c.type ?? 'Concern'),
        severity: (c.severity as AlertSeverity) ?? 'low',
        confidence: c.confidence === 'high' ? 85 : c.confidence === 'medium' ? 65 : 45,
        description: String(c.message ?? ''),
        firstDetected: String(c.createdAt ?? new Date().toISOString()),
        occurrences: 1
      }))
    : [];

  const recs = Array.isArray(payload.recommendations)
    ? (payload.recommendations as Array<Record<string, unknown>>).map((r, idx) => ({
        id: String(r.id ?? `r-${idx}`),
        text: String(r.title ?? 'Recommendation'),
        actionLabel: String(r.action ?? 'Review')
      }))
    : [];

  return {
    period,
    avgMoodScore: Number(avgMood.toFixed(1)),
    moodTrend: 'stable',
    engagementScore: Math.round((avgEng / 60) * 100),
    engagementTrend: 'stable',
    topTopics: topics,
    concernSignals: concerns,
    recommendations: recs,
    dailyMoods,
    dailyEngagement
  };
};

const inferRelation = (role: 'owner' | 'member'): string => (role === 'owner' ? 'Primary caregiver' : 'Family member');

export const useCurrentUser = () =>
  useQuery({
    queryKey: ['auth', 'me'],
    queryFn: async (): Promise<User> => {
      const res = await request<{ user: Record<string, unknown> }>('/auth/me');
      return {
        id: String(res.user.id),
        name: String(res.user.name ?? 'Caregiver'),
        email: String(res.user.email ?? DEV_EMAIL ?? 'caregiver@example.com'),
        phone: String(res.user.phone ?? '+91 90000 00000'),
        role: 'owner',
        joinedAt: new Date().toISOString()
      };
    }
  });

export const useFamilyMembers = () =>
  useQuery({
    queryKey: ['family', 'members'],
    queryFn: async (): Promise<FamilyMember[]> => {
      const res = await request<{ items: Array<Record<string, unknown>> }>('/family/members');
      return res.items.map((m) => ({
        id: String(m.id),
        name: String(m.displayName ?? m.email ?? m.phone ?? 'Member'),
        relation: inferRelation((m.role as 'owner' | 'member') ?? 'member'),
        role: ((m.role as 'owner' | 'member') ?? 'member'),
        phone: String(m.phone ?? '-'),
        email: String(m.email ?? '-'),
        inviteStatus: m.acceptedAt ? 'accepted' : 'pending',
        joinedAt: new Date(Number(m.invitedAt ?? Date.now())).toISOString()
      }));
    }
  });

export const useInviteFamilyMember = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { displayName?: string; email?: string; phone?: string; role?: 'owner' | 'member' }) =>
      request('/family/invite', { method: 'POST', body: input }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['family', 'members'] });
    }
  });
};

export const useUpdateFamilyRole = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; role: 'owner' | 'member' }) =>
      request(`/family/members/${input.id}/role`, { method: 'PATCH', body: { role: input.role } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['family', 'members'] });
    }
  });
};

export const useRemoveFamilyMember = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => request(`/family/members/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['family', 'members'] });
    }
  });
};

export const useElderProfile = () =>
  useQuery({
    queryKey: ['elder', 'profile'],
    queryFn: async (): Promise<ElderProfile> => {
      const res = await request<{ profile: Record<string, unknown> | null }>('/elder/profile');
      const p = res.profile ?? {};
      return {
        id: String(p.id ?? 'elder-1'),
        name: String(p.name ?? 'Elder'),
        age: typeof p.age === 'number' ? p.age : 72,
        language: String(p.language ?? 'Hindi'),
        city: String(p.city ?? 'Jaipur'),
        timezone: String(p.timezone ?? 'Asia/Kolkata'),
        deviceId: undefined
      };
    }
  });

export const useDeviceStatus = () =>
  useQuery({
    queryKey: ['elder', 'device-status'],
    queryFn: async (): Promise<{ status: ElderStatusSnapshot; device: DeviceInfo }> => {
      const res = await request<{
        elder: Record<string, unknown> | null;
        device: Record<string, unknown> | null;
        snapshot: Record<string, unknown>;
      }>('/elder/device/status');

      const snapshot = res.snapshot ?? {};
      const device = res.device ?? {};

      return {
        status: {
          status: (snapshot.onlineState as ElderStatusSnapshot['status']) ?? 'offline',
          lastInteraction: snapshot.lastInteractionAt
            ? `${Math.max(1, Math.round((Date.now() - Number(snapshot.lastInteractionAt)) / 60000))} min ago`
            : 'N/A',
          lastInteractionType: 'Companion interaction',
          confidenceLevel: Math.round(Number(snapshot.latestEngagementScore ?? 0.6) * 100),
          moodIndicator: Number(snapshot.latestMoodScore ?? 0.6) > 0.7 ? 'happy' : 'neutral',
          todayInteractions: 0,
          activeMinutesToday: Math.round(Number(snapshot.latestEngagementScore ?? 0.6) * 60)
        },
        device: {
          serialNumber: String(device.serialNumber ?? 'Not linked'),
          firmwareVersion: String(device.firmwareVersion ?? 'Unknown'),
          lastHeartbeat: 'Just now',
          connectivityStatus: snapshot.onlineState === 'online' ? 'connected' : 'disconnected',
          wifiStrength: snapshot.onlineState === 'online' ? 85 : 0,
          diagnosticStatus: snapshot.onlineState === 'online' ? 'healthy' : 'warning',
          linkedAt: new Date(Number(device.linkedAt ?? Date.now())).toISOString()
        }
      };
    }
  });

export const useUnlinkDevice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => request('/device/unlink', { method: 'POST', body: {} }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['elder', 'device-status'] });
    }
  });
};

export const useAlerts = () =>
  useQuery({
    queryKey: ['alerts'],
    queryFn: async (): Promise<Alert[]> => {
      const res = await request<{ items: Array<Record<string, unknown>> }>('/alerts');
      return res.items.map(toAlert).sort((a, b) => {
        const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
        if (sevDiff !== 0) return sevDiff;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
    }
  });

export const useAlert = (id?: string) =>
  useQuery({
    queryKey: ['alerts', id],
    enabled: Boolean(id),
    queryFn: async (): Promise<Alert> => {
      const res = await request<Record<string, unknown>>(`/alerts/${id}`);
      return toAlert(res);
    }
  });

export const useAcknowledgeAlert = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => request(`/alerts/${id}/ack`, { method: 'POST', body: {} }),
    onSuccess: async (_data, id) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['alerts'] }),
        qc.invalidateQueries({ queryKey: ['alerts', id] })
      ]);
    }
  });
};

export const useResolveAlert = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => request(`/alerts/${id}/resolve`, { method: 'POST', body: {} }),
    onSuccess: async (_data, id) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['alerts'] }),
        qc.invalidateQueries({ queryKey: ['alerts', id] })
      ]);
    }
  });
};

export const useNudges = () =>
  useQuery({
    queryKey: ['nudges', 'history'],
    queryFn: async (): Promise<Nudge[]> => {
      const res = await request<{ items: Array<Record<string, unknown>> }>('/nudges/history');
      return res.items.map((n, idx) => ({
        id: String(n.id ?? `n-${idx}`),
        senderId: String(n.createdByUserId ?? 'family'),
        senderName: 'Family',
        type: (n.type as 'text' | 'voice') ?? 'text',
        priority: (n.priority as NudgePriority) ?? 'gentle',
        message: String(n.text ?? n.voiceUrl ?? 'Nudge'),
        deliveryState: (n.deliveryState as Nudge['deliveryState']) ?? 'delivered',
        scheduledFor: n.scheduledFor ? new Date(Number(n.scheduledFor)).toISOString() : undefined,
        sentAt: new Date(Number(n.createdAt ?? Date.now())).toISOString()
      }));
    }
  });

export const useSendNudge = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { text?: string; voiceUrl?: string; priority: NudgePriority }) =>
      request('/nudges/send', { method: 'POST', body: input }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['nudges', 'history'] });
      await qc.invalidateQueries({ queryKey: ['home', 'timeline'] });
    }
  });
};

export const useCareReminders = () =>
  useQuery({
    queryKey: ['care', 'reminders'],
    queryFn: async (): Promise<Reminder[]> => {
      const res = await request<{ items: Array<Record<string, unknown>> }>('/care/reminders');
      return res.items.map((r, idx) => ({
        id: String(r.id ?? `rem-${idx}`),
        title: String(r.title ?? 'Reminder'),
        description: typeof r.description === 'string' ? r.description : undefined,
        time: String(r.scheduledTime ?? '08:00'),
        days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        enabled: Boolean(r.enabled ?? true),
        category: 'custom',
        adherenceRate: 80
      }));
    }
  });

export const usePatchCareReminder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; enabled?: boolean; title?: string; description?: string; scheduledTime?: string }) =>
      request(`/care/reminders/${input.id}`, {
        method: 'PATCH',
        body: {
          enabled: input.enabled,
          title: input.title,
          description: input.description,
          scheduledTime: input.scheduledTime
        }
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['care', 'reminders'] });
    }
  });
};

export const useCareRoutines = () =>
  useQuery({
    queryKey: ['care', 'routines'],
    queryFn: async (): Promise<Routine[]> => {
      const res = await request<{ items: Array<Record<string, unknown>> }>('/care/routines');
      return res.items.map((r, idx) => ({
        id: String(r.id ?? `rt-${idx}`),
        title: String(r.title ?? 'Routine'),
        description: undefined,
        timeSlot: String(r.schedule ?? '').startsWith('0') ? 'morning' : 'evening',
        time: String(r.schedule ?? '08:00'),
        enabled: Boolean(r.enabled ?? true),
        category: String(r.key ?? '').includes('satsang') ? 'satsang' : 'briefing',
        completedToday: false
      }));
    }
  });

export const usePatchRoutine = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; enabled?: boolean; title?: string; schedule?: string }) =>
      request(`/care/routines/${input.id}`, {
        method: 'PATCH',
        body: {
          enabled: input.enabled,
          title: input.title,
          schedule: input.schedule
        }
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['care', 'routines'] });
    }
  });
};

export const useInsights = (period: '7d' | '30d') =>
  useQuery({
    queryKey: ['insights', period],
    queryFn: async (): Promise<InsightOverview> => {
      const [overview, timeline] = await Promise.all([
        request<Record<string, unknown>>('/insights/overview'),
        request<Record<string, unknown>>(`/insights/timeline?range=${period}`)
      ]);
      const merged = {
        ...overview,
        moodTrend: (timeline as Record<string, unknown>).moodTrend ?? overview.moodTrend,
        engagementTrend: (timeline as Record<string, unknown>).engagementTrend ?? overview.engagementTrend
      };
      return toInsights(merged, period);
    }
  });

export const useEscalationPolicy = () =>
  useQuery({
    queryKey: ['escalation', 'policy'],
    queryFn: async (): Promise<Record<string, unknown>> => request('/escalation/policy')
  });

export const useHomeTimeline = () =>
  useQuery({
    queryKey: ['home', 'timeline'],
    queryFn: async () => {
      const [nudges, reminders] = await Promise.all([
        request<{ items: Array<Record<string, unknown>> }>('/nudges/history'),
        request<{ items: Array<Record<string, unknown>> }>('/care/reminders')
      ]);

      const nudgeEvents = nudges.items.slice(0, 3).map((n, idx) => ({
        id: `n-${idx}`,
        type: 'nudge',
        title: n.type === 'voice' ? 'Voice nudge sent' : 'Nudge sent',
        subtitle: String(n.text ?? n.voiceUrl ?? ''),
        time: new Date(Number(n.createdAt ?? Date.now())).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        icon: 'Send',
        color: 'sky'
      }));

      const reminderEvents = reminders.items.slice(0, 2).map((r, idx) => ({
        id: `r-${idx}`,
        type: 'reminder',
        title: String(r.title ?? 'Reminder'),
        subtitle: 'Scheduled reminder',
        time: String(r.scheduledTime ?? '08:00'),
        icon: 'Pill',
        color: 'lavender'
      }));

      return [...nudgeEvents, ...reminderEvents];
    }
  });

export type AgentConversationItem = {
  id: string;
  sessionId: string;
  userText: string;
  assistantText: string;
  language?: string | null;
  createdAt: string;
  citations?: Array<Record<string, unknown>>;
};

export type AgentTaskItem = {
  id: string;
  type: string;
  title: string;
  when: string | null;
  status: 'pending' | 'done';
  recurrence: string | null;
};

export const useAgentConversations = (cursor?: string) =>
  useQuery({
    queryKey: ['agent', 'conversations', cursor ?? null],
    queryFn: async (): Promise<{ items: AgentConversationItem[]; nextCursor: string | null }> =>
      request(`/agent/conversations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
  });

export const useAgentTasks = (filters?: { status?: 'pending' | 'done' | 'all'; from?: string; to?: string }) =>
  useQuery({
    queryKey: ['agent', 'tasks', filters ?? {}],
    queryFn: async (): Promise<{ items: AgentTaskItem[] }> => {
      const params = new URLSearchParams();
      if (filters?.status) params.set('status', filters.status);
      if (filters?.from) params.set('from', filters.from);
      if (filters?.to) params.set('to', filters.to);
      const qs = params.toString();
      return request(`/agent/tasks${qs ? `?${qs}` : ''}`);
    }
  });

export const useAgentMemories = (query: string, k = 5) =>
  useQuery({
    queryKey: ['agent', 'memories', query, k],
    enabled: query.trim().length > 0,
    queryFn: async (): Promise<{ items: Array<Record<string, unknown>> }> =>
      request(`/agent/memories?query=${encodeURIComponent(query)}&k=${k}`)
  });

export const pullEventStream = async (afterEventId?: string, limit = 20) => {
  const qs = new URLSearchParams();
  qs.set('limit', String(limit));
  if (afterEventId) qs.set('afterEventId', afterEventId);
  return request<{ events: Array<Record<string, unknown>>; nextAfterEventId: string | null }>(
    `/events/stream?${qs.toString()}`
  );
};

export const useSignOut = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      try {
        await request('/auth/logout', { method: 'POST', body: {} });
      } finally {
        await clearSession();
      }
    },
    onSuccess: async () => {
      await qc.clear();
    }
  });
};
