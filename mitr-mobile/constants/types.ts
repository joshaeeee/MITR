export type UserRole = 'owner' | 'member';

export type ElderStatus = 'online' | 'idle' | 'offline' | 'degraded';

export type NudgePriority = 'gentle' | 'important' | 'urgent';

export type NudgeDeliveryState = 'queued' | 'delivering' | 'delivered' | 'acknowledged' | 'failed';

export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export type AlertStatus = 'open' | 'acknowledged' | 'resolved';

export type EscalationStage = 'elder_nudge' | 'family_alert' | 'emergency_contact';

export type TriggerType = 'missed_reminder' | 'distress_language' | 'inactivity' | 'device_offline';

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string;
  avatarUrl?: string;
  role: UserRole;
  joinedAt: string;
}

export interface FamilyMember {
  id: string;
  name: string;
  relation: string;
  role: UserRole;
  phone: string;
  email: string;
  avatarUrl?: string;
  inviteStatus: 'accepted' | 'pending';
  joinedAt: string;
}

export interface ElderProfile {
  id: string;
  name: string;
  age: number;
  language: string;
  city: string;
  timezone: string;
  photoUrl?: string;
  deviceId?: string;
}

export interface ElderStatusSnapshot {
  status: ElderStatus;
  lastInteraction: string;
  lastInteractionType: string;
  confidenceLevel: number;
  moodIndicator: 'happy' | 'neutral' | 'low' | 'concerned';
  todayInteractions: number;
  activeMinutesToday: number;
}

export interface Nudge {
  id: string;
  senderId: string;
  senderName: string;
  type: 'text' | 'voice';
  priority: NudgePriority;
  message: string;
  deliveryState: NudgeDeliveryState;
  scheduledFor?: string;
  sentAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
}

export interface Alert {
  id: string;
  title: string;
  description: string;
  severity: AlertSeverity;
  status: AlertStatus;
  trigger: TriggerType;
  escalationStage: EscalationStage;
  createdAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  timeline: AlertTimelineEntry[];
}

export interface AlertTimelineEntry {
  id: string;
  action: string;
  actor: string;
  timestamp: string;
  stage: EscalationStage;
}

export interface EscalationPolicy {
  quietHoursStart: string;
  quietHoursEnd: string;
  stage1DelayMinutes: number;
  stage2DelayMinutes: number;
  stage3DelayMinutes: number;
  cooldownMinutes: number;
  triggers: {
    missedReminder: boolean;
    distressLanguage: boolean;
    inactivity: boolean;
    deviceOffline: boolean;
  };
  emergencyContact: {
    name: string;
    phone: string;
    relation: string;
  };
}

export interface Reminder {
  id: string;
  title: string;
  description?: string;
  time: string;
  days: string[];
  enabled: boolean;
  category: 'medication' | 'exercise' | 'meal' | 'appointment' | 'custom';
  lastCompleted?: string;
  adherenceRate: number;
}

export interface Routine {
  id: string;
  title: string;
  description?: string;
  timeSlot: 'morning' | 'afternoon' | 'evening' | 'night';
  time: string;
  enabled: boolean;
  category: 'briefing' | 'satsang' | 'medication' | 'exercise' | 'social' | 'rest';
  completedToday: boolean;
}

export interface ConcernSignal {
  id: string;
  label: string;
  severity: AlertSeverity;
  confidence: number;
  description: string;
  firstDetected: string;
  occurrences: number;
}

export interface InsightOverview {
  period: '7d' | '30d';
  avgMoodScore: number;
  moodTrend: 'improving' | 'stable' | 'declining';
  engagementScore: number;
  engagementTrend: 'improving' | 'stable' | 'declining';
  topTopics: { topic: string; count: number }[];
  concernSignals: ConcernSignal[];
  recommendations: { id: string; text: string; actionLabel: string }[];
  dailyMoods: { day: string; score: number }[];
  dailyEngagement: { day: string; minutes: number }[];
}

export interface DeviceInfo {
  serialNumber: string;
  firmwareVersion: string;
  lastHeartbeat: string;
  connectivityStatus: 'connected' | 'intermittent' | 'disconnected';
  wifiStrength: number;
  batteryLevel?: number;
  diagnosticStatus: 'healthy' | 'warning' | 'error';
  linkedAt: string;
}

export interface TimelineEvent {
  id: string;
  type: 'interaction' | 'reminder' | 'nudge' | 'alert' | 'routine';
  title: string;
  subtitle?: string;
  time: string;
  icon: string;
  color: string;
}
