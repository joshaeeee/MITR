import React, { useRef, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Alert,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Stack } from 'expo-router';
import {
  AlertTriangle,
  CheckCircle,
  User,
  Cpu,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/contexts/ThemeContext';
import PastelCard from '@/components/PastelCard';
import StatusBadge from '@/components/StatusBadge';
import { EscalationStage } from '@/constants/types';
import { useAcknowledgeAlert, useAlert, useResolveAlert } from '@/lib/api';

const stageLabels: Record<EscalationStage, string> = {
  elder_nudge: 'Elder Nudge',
  family_alert: 'Family Alert',
  emergency_contact: 'Emergency Contact',
};

export default function AlertDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const { data: alert } = useAlert(id);
  const acknowledge = useAcknowledgeAlert();
  const resolve = useResolveAlert();
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const stageColors: Record<EscalationStage, string> = {
    elder_nudge: colors.skyLight,
    family_alert: colors.warningLight,
    emergency_contact: colors.dangerLight,
  };

  const stageTextColors: Record<EscalationStage, string> = {
    elder_nudge: colors.skyDark,
    family_alert: colors.warning,
    emergency_contact: colors.danger,
  };

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 400,
      useNativeDriver: true,
    }).start();
  }, []);

  if (!alert) {
    return (
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: 'Alert' }} />
        <View style={styles.emptyState}>
          <AlertTriangle size={48} color={colors.textTertiary} />
          <Text style={[styles.emptyTitle, { color: colors.textSecondary }]}>Alert not found</Text>
        </View>
      </View>
    );
  }

  const stages: EscalationStage[] = ['elder_nudge', 'family_alert', 'emergency_contact'];
  const currentStageIndex = stages.indexOf(alert.escalationStage);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: alert.title }} />
      <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          <PastelCard
            color={
              alert.severity === 'high' || alert.severity === 'critical'
                ? 'peach'
                : alert.severity === 'medium'
                ? 'lavender'
                : 'sky'
            }
            style={styles.headerCard}
          >
            <View style={styles.headerRow}>
              <View style={styles.headerInfo}>
                <Text style={[styles.headerTitle, { color: colors.text }]}>{alert.title}</Text>
                <Text style={[styles.headerDesc, { color: colors.textSecondary }]}>{alert.description}</Text>
              </View>
              <StatusBadge type="severity" value={alert.severity} size="medium" />
            </View>
            <View style={styles.headerMeta}>
              <Text style={[styles.headerMetaText, { color: colors.textTertiary }]}>
                {new Date(alert.createdAt).toLocaleDateString('en-IN', {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </Text>
              <Text style={[styles.headerMetaText, { color: colors.textTertiary }]}>
                Trigger: {alert.trigger.replace('_', ' ')}
              </Text>
            </View>
          </PastelCard>

          <View style={styles.stageSection}>
            <Text style={[styles.stageTitle, { color: colors.text }]}>Escalation progress</Text>
            <View style={styles.stageRow}>
              {stages.map((stage, idx) => {
                const isActive = idx <= currentStageIndex;
                const isCurrent = idx === currentStageIndex;
                return (
                  <React.Fragment key={stage}>
                    <View
                      style={[
                        styles.stageDot,
                        {
                          backgroundColor: isActive ? stageColors[stage] : colors.surfaceAlt,
                          borderColor: isCurrent ? stageTextColors[stage] : 'transparent',
                          borderWidth: isCurrent ? 2 : 0,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.stageNum,
                          { color: isActive ? stageTextColors[stage] : colors.textTertiary },
                        ]}
                      >
                        {idx + 1}
                      </Text>
                    </View>
                    {idx < stages.length - 1 && (
                      <View
                        style={[
                          styles.stageLine,
                          { backgroundColor: idx < currentStageIndex ? colors.mintDark : colors.borderLight },
                        ]}
                      />
                    )}
                  </React.Fragment>
                );
              })}
            </View>
            <View style={styles.stageLabels}>
              {stages.map((stage) => (
                <Text key={stage} style={[styles.stageLabelText, { color: colors.textTertiary }]}>{stageLabels[stage]}</Text>
              ))}
            </View>
          </View>

          <View style={styles.timelineSection}>
            <Text style={[styles.timelineSectionTitle, { color: colors.text }]}>Timeline</Text>
            {alert.timeline.map((entry, idx) => (
              <View key={entry.id} style={styles.timelineItem}>
                <View style={styles.timelineLeft}>
                  <View
                    style={[
                      styles.timelineDot,
                      { backgroundColor: stageColors[entry.stage] },
                    ]}
                  >
                    {entry.actor === 'System' ? (
                      <Cpu size={12} color={stageTextColors[entry.stage]} />
                    ) : entry.actor.includes('MITR') ? (
                      <Cpu size={12} color={stageTextColors[entry.stage]} />
                    ) : (
                      <User size={12} color={stageTextColors[entry.stage]} />
                    )}
                  </View>
                  {idx < alert.timeline.length - 1 && <View style={[styles.timelineLine, { backgroundColor: colors.borderLight }]} />}
                </View>
                <View style={styles.timelineContent}>
                  <Text style={[styles.timelineAction, { color: colors.text }]}>{entry.action}</Text>
                  <Text style={[styles.timelineActor, { color: colors.textSecondary }]}>{entry.actor}</Text>
                  <Text style={[styles.timelineTime, { color: colors.textTertiary }]}>
                    {new Date(entry.timestamp).toLocaleTimeString('en-IN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </Text>
                </View>
              </View>
            ))}
          </View>

          {alert.status !== 'resolved' && (
            <View style={styles.actions}>
              {alert.status === 'open' && (
                <TouchableOpacity
                  style={[styles.acknowledgeBtn, { backgroundColor: colors.text }]}
                  onPress={async () => {
                    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                    try {
                      await acknowledge.mutateAsync(alert.id);
                      Alert.alert('Acknowledged', 'Alert has been acknowledged.');
                    } catch (error) {
                      Alert.alert('Acknowledge failed', (error as Error).message);
                    }
                  }}
                  activeOpacity={0.7}
                >
                  <CheckCircle size={20} color={colors.surface} />
                  <Text style={[styles.acknowledgeBtnText, { color: colors.surface }]}>Acknowledge</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.resolveBtn, { backgroundColor: colors.mintLight }]}
                onPress={async () => {
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  try {
                    await resolve.mutateAsync(alert.id);
                    Alert.alert('Resolved', 'Alert has been resolved.');
                  } catch (error) {
                    Alert.alert('Resolve failed', (error as Error).message);
                  }
                }}
                activeOpacity={0.7}
              >
                <CheckCircle size={20} color={colors.mintDark} />
                <Text style={[styles.resolveBtnText, { color: colors.mintDark }]}>Resolve</Text>
              </TouchableOpacity>
            </View>
          )}

          {alert.acknowledgedBy && (
            <PastelCard color="sky" style={styles.infoCard}>
              <Text style={[styles.infoText, { color: colors.textSecondary }]}>
                Acknowledged by {alert.acknowledgedBy}
                {alert.acknowledgedAt && (
                  <Text>
                    {' '}
                    on{' '}
                    {new Date(alert.acknowledgedAt).toLocaleDateString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </Text>
                )}
              </Text>
            </PastelCard>
          )}

          {alert.resolvedBy && (
            <PastelCard color="mint" style={styles.infoCard}>
              <Text style={[styles.infoText, { color: colors.textSecondary }]}>
                Resolved by {alert.resolvedBy}
                {alert.resolvedAt && (
                  <Text>
                    {' '}
                    on{' '}
                    {new Date(alert.resolvedAt).toLocaleDateString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </Text>
                )}
              </Text>
            </PastelCard>
          )}

          <View style={styles.bottomSpacer} />
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 30,
    paddingTop: 10,
  },
  headerCard: {
    marginHorizontal: 20,
    marginBottom: 24,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 12,
  },
  headerInfo: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700' as const,
    marginBottom: 6,
  },
  headerDesc: {
    fontSize: 14,
    lineHeight: 20,
  },
  headerMeta: {
    flexDirection: 'row',
    gap: 16,
  },
  headerMetaText: {
    fontSize: 12,
    textTransform: 'capitalize' as const,
  },
  stageSection: {
    paddingHorizontal: 20,
    marginBottom: 28,
  },
  stageTitle: {
    fontSize: 16,
    fontWeight: '700' as const,
    marginBottom: 16,
  },
  stageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stageDot: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stageNum: {
    fontSize: 14,
    fontWeight: '700' as const,
  },
  stageLine: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    marginHorizontal: 4,
  },
  stageLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  stageLabelText: {
    fontSize: 10,
    fontWeight: '500' as const,
    textAlign: 'center',
    width: 80,
  },
  timelineSection: {
    paddingHorizontal: 20,
    marginBottom: 24,
  },
  timelineSectionTitle: {
    fontSize: 16,
    fontWeight: '700' as const,
    marginBottom: 16,
  },
  timelineItem: {
    flexDirection: 'row',
    minHeight: 56,
  },
  timelineLeft: {
    alignItems: 'center',
    width: 36,
  },
  timelineDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timelineLine: {
    width: 2,
    flex: 1,
    marginVertical: 4,
  },
  timelineContent: {
    flex: 1,
    paddingLeft: 12,
    paddingBottom: 16,
  },
  timelineAction: {
    fontSize: 14,
    fontWeight: '600' as const,
  },
  timelineActor: {
    fontSize: 12,
    marginTop: 2,
  },
  timelineTime: {
    fontSize: 11,
    marginTop: 2,
  },
  actions: {
    paddingHorizontal: 20,
    gap: 10,
    marginBottom: 20,
  },
  acknowledgeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 16,
    paddingVertical: 16,
  },
  acknowledgeBtnText: {
    fontSize: 15,
    fontWeight: '600' as const,
  },
  resolveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 16,
    paddingVertical: 16,
  },
  resolveBtnText: {
    fontSize: 15,
    fontWeight: '600' as const,
  },
  infoCard: {
    marginHorizontal: 20,
    marginBottom: 10,
  },
  infoText: {
    fontSize: 13,
    lineHeight: 18,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600' as const,
  },
  bottomSpacer: {
    height: 20,
  },
});
