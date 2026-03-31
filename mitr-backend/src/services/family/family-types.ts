export type FamilyRole = 'owner' | 'member';

export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved';
export type InsightConfidence = 'low' | 'medium' | 'high';
export type NudgePriority = 'gentle' | 'important' | 'urgent';
export type NudgeDeliveryState = 'queued' | 'delivering' | 'delivered' | 'acknowledged' | 'failed';
export type EscalationStage = 'nudge' | 'family_push' | 'emergency_contact';
export type CarePlanSection = 'medicines' | 'repeated_reminders' | 'one_off_plans' | 'important_dates';
export type CarePlanType = 'medicine' | 'reminder' | 'plan' | 'date';
export type CarePlanSource = 'planner' | 'legacy_reminder' | 'legacy_routine';
export type InsightProcessingState = 'no_conversations' | 'processing_pending' | 'low_confidence' | 'ready';

export interface FamilyMember {
  id: string;
  familyId: string;
  userId: string;
  role: FamilyRole;
  displayName?: string;
  email?: string;
  phone?: string;
  invitedAt: number;
  acceptedAt?: number;
}

export interface ElderProfile {
  id: string;
  familyId: string;
  name: string;
  ageRange?: string;
  language?: string;
  city?: string;
  timezone?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DeviceUsageSummary {
  totalDurationSec: number;
  todayDurationSec: number;
  sessionCount: number;
  todaySessionCount: number;
  lastSessionDurationSec?: number;
  lastSessionStartedAt?: number;
  lastSessionEndedAt?: number;
  updatedAt: number;
}

export interface ElderStatusSnapshot {
  elderId: string;
  onlineState: 'online' | 'idle' | 'offline' | 'degraded';
  lastInteractionAt?: number;
  latestMoodScore?: number;
  latestEngagementScore?: number;
  deviceUsageSummary?: DeviceUsageSummary;
  updatedAt: number;
}

export interface ConcernSignal {
  id: string;
  elderId: string;
  type: 'distress_language' | 'inactivity' | 'missed_medication' | 'device_health';
  severity: AlertSeverity;
  confidence: InsightConfidence;
  message: string;
  createdAt: number;
}

export interface InsightOverviewResponse {
  elderId: string;
  generatedAt: number;
  moodTrend: Array<{ ts: number; score: number }>;
  engagementTrend: Array<{ ts: number; score: number }>;
  concernSignals: ConcernSignal[];
  keyTopics: Array<{ topic: string; score: number }>;
  recommendations: Array<{ id: string; title: string; action: string; confidence: InsightConfidence }>;
}

export interface EscalationPolicy {
  elderId: string;
  quietHoursStart: string;
  quietHoursEnd: string;
  stage1NudgeDelayMin: number;
  stage2FamilyAlertDelayMin: number;
  stage3EmergencyDelayMin: number;
  enabledTriggers: Array<'missed_reminder' | 'distress_language' | 'inactivity' | 'device_offline'>;
  updatedAt: number;
}

export interface CareReminder {
  id: string;
  elderId: string;
  title: string;
  description?: string;
  scheduledTime: string;
  enabled: boolean;
  updatedAt: number;
}

export interface CarePlanItem {
  id: string;
  elderId: string;
  section: CarePlanSection;
  type: CarePlanType;
  title: string;
  description?: string;
  enabled: boolean;
  scheduledAt?: string;
  repeatRule?: string;
  metadata: Record<string, unknown>;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  source: CarePlanSource;
}
