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
import Colors from '@/constants/colors';
import PastelCard from '@/components/PastelCard';
import StatusBadge from '@/components/StatusBadge';
import { EscalationStage } from '@/constants/types';
import { useAcknowledgeAlert, useAlert, useResolveAlert } from '@/lib/api';

const stageLabels: Record<EscalationStage, string> = {
  elder_nudge: 'Elder Nudge',
  family_alert: 'Family Alert',
  emergency_contact: 'Emergency Contact',
};

const stageColors: Record<EscalationStage, string> = {
  elder_nudge: Colors.skyLight,
  family_alert: Colors.warningLight,
  emergency_contact: Colors.dangerLight,
};

const stageTextColors: Record<EscalationStage, string> = {
  elder_nudge: Colors.skyDark,
  family_alert: Colors.warning,
  emergency_contact: Colors.danger,
};

export default function AlertDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: alert } = useAlert(id);
  const acknowledge = useAcknowledgeAlert();
  const resolve = useResolveAlert();
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 400,
      useNativeDriver: true,
    }).start();
  }, []);

  if (!alert) {
    return (
      <View style={styles.root}>
        <Stack.Screen options={{ title: 'Alert' }} />
        <View style={styles.emptyState}>
          <AlertTriangle size={48} color={Colors.textTertiary} />
          <Text style={styles.emptyTitle}>Alert not found</Text>
        </View>
      </View>
    );
  }

  const stages: EscalationStage[] = ['elder_nudge', 'family_alert', 'emergency_contact'];
  const currentStageIndex = stages.indexOf(alert.escalationStage);

  return (
    <View style={styles.root}>
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
                <Text style={styles.headerTitle}>{alert.title}</Text>
                <Text style={styles.headerDesc}>{alert.description}</Text>
              </View>
              <StatusBadge type="severity" value={alert.severity} size="medium" />
            </View>
            <View style={styles.headerMeta}>
              <Text style={styles.headerMetaText}>
                {new Date(alert.createdAt).toLocaleDateString('en-IN', {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </Text>
              <Text style={styles.headerMetaText}>
                Trigger: {alert.trigger.replace('_', ' ')}
              </Text>
            </View>
          </PastelCard>

          <View style={styles.stageSection}>
            <Text style={styles.stageTitle}>Escalation progress</Text>
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
                          backgroundColor: isActive ? stageColors[stage] : Colors.surfaceAlt,
                          borderColor: isCurrent ? stageTextColors[stage] : 'transparent',
                          borderWidth: isCurrent ? 2 : 0,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.stageNum,
                          { color: isActive ? stageTextColors[stage] : Colors.textTertiary },
                        ]}
                      >
                        {idx + 1}
                      </Text>
                    </View>
                    {idx < stages.length - 1 && (
                      <View
                        style={[
                          styles.stageLine,
                          { backgroundColor: idx < currentStageIndex ? Colors.mintDark : Colors.borderLight },
                        ]}
                      />
                    )}
                  </React.Fragment>
                );
              })}
            </View>
            <View style={styles.stageLabels}>
              {stages.map((stage) => (
                <Text key={stage} style={styles.stageLabelText}>{stageLabels[stage]}</Text>
              ))}
            </View>
          </View>

          <View style={styles.timelineSection}>
            <Text style={styles.timelineSectionTitle}>Timeline</Text>
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
                  {idx < alert.timeline.length - 1 && <View style={styles.timelineLine} />}
                </View>
                <View style={styles.timelineContent}>
                  <Text style={styles.timelineAction}>{entry.action}</Text>
                  <Text style={styles.timelineActor}>{entry.actor}</Text>
                  <Text style={styles.timelineTime}>
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
                  style={styles.acknowledgeBtn}
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
                  <CheckCircle size={20} color={Colors.white} />
                  <Text style={styles.acknowledgeBtnText}>Acknowledge</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={styles.resolveBtn}
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
                <CheckCircle size={20} color={Colors.mintDark} />
                <Text style={styles.resolveBtnText}>Resolve</Text>
              </TouchableOpacity>
            </View>
          )}

          {alert.acknowledgedBy && (
            <PastelCard color="sky" style={styles.infoCard}>
              <Text style={styles.infoText}>
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
              <Text style={styles.infoText}>
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
    backgroundColor: Colors.background,
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
    color: Colors.text,
    marginBottom: 6,
  },
  headerDesc: {
    fontSize: 14,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  headerMeta: {
    flexDirection: 'row',
    gap: 16,
  },
  headerMetaText: {
    fontSize: 12,
    color: Colors.textTertiary,
    textTransform: 'capitalize' as const,
  },
  stageSection: {
    paddingHorizontal: 20,
    marginBottom: 28,
  },
  stageTitle: {
    fontSize: 16,
    fontWeight: '700' as const,
    color: Colors.text,
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
    color: Colors.textTertiary,
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
    color: Colors.text,
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
    backgroundColor: Colors.borderLight,
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
    color: Colors.text,
  },
  timelineActor: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  timelineTime: {
    fontSize: 11,
    color: Colors.textTertiary,
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
    backgroundColor: Colors.text,
    borderRadius: 16,
    paddingVertical: 16,
  },
  acknowledgeBtnText: {
    color: Colors.white,
    fontSize: 15,
    fontWeight: '600' as const,
  },
  resolveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.mintLight,
    borderRadius: 16,
    paddingVertical: 16,
  },
  resolveBtnText: {
    color: Colors.mintDark,
    fontSize: 15,
    fontWeight: '600' as const,
  },
  infoCard: {
    marginHorizontal: 20,
    marginBottom: 10,
  },
  infoText: {
    fontSize: 13,
    color: Colors.textSecondary,
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
    color: Colors.textSecondary,
  },
  bottomSpacer: {
    height: 20,
  },
});
