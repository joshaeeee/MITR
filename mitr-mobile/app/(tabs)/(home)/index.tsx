import React, { useRef, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  Bell,
  Send,
  Mic,
  CheckCircle,
  ClipboardList,
  ChevronRight,
  Smile,
  Activity,
  Clock,
  Sunrise,
  Heart,
  Cloud,
  Pill,
  AlertTriangle,
  Wifi,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import Colors from '@/constants/colors';
import PastelCard from '@/components/PastelCard';
import QuickAction from '@/components/QuickAction';
import StatusBadge from '@/components/StatusBadge';
import SectionHeader from '@/components/SectionHeader';
import { useAlerts, useCurrentUser, useDeviceStatus, useElderProfile, useHomeTimeline } from '@/lib/api';

const iconMap: Record<string, React.ReactNode> = {
  Sunrise: <Sunrise size={16} color={Colors.mintDark} />,
  Pill: <Pill size={16} color={Colors.lavenderDark} />,
  Heart: <Heart size={16} color={Colors.peachDark} />,
  Send: <Send size={16} color={Colors.skyDark} />,
  Cloud: <Cloud size={16} color={Colors.skyDark} />,
};

const colorMap: Record<string, string> = {
  mint: Colors.mintLight,
  lavender: Colors.lavenderLight,
  peach: Colors.peachLight,
  sky: Colors.skyLight,
};

export default function HomeScreen() {
  const router = useRouter();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(20)).current;
  const { data: user } = useCurrentUser();
  const { data: elderProfile } = useElderProfile();
  const { data: deviceData } = useDeviceStatus();
  const { data: alerts = [] } = useAlerts();
  const { data: todayTimeline = [] } = useHomeTimeline();

  const elderStatus = deviceData?.status;

  const openAlerts = alerts.filter((a) => a.status === 'open');

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 600,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 600,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  const confidenceBarWidth = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(confidenceBarWidth, {
      toValue: (elderStatus?.confidenceLevel ?? 0) / 100,
      duration: 1000,
      delay: 400,
      useNativeDriver: false,
    }).start();
  }, [elderStatus?.confidenceLevel]);

  const moodEmoji =
    elderStatus?.moodIndicator === 'happy'
      ? 'Feeling cheerful'
      : elderStatus?.moodIndicator === 'neutral'
      ? 'Feeling okay'
      : elderStatus?.moodIndicator === 'low'
      ? 'Feeling quiet'
      : 'Needs attention';

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <Animated.View
          style={[styles.container, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}
        >
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.scrollContent}
          >
            <View style={styles.header}>
              <View>
                <Text style={styles.greeting}>Good morning, {user?.name?.split(' ')[0] ?? 'Family'}</Text>
                <Text style={styles.subtitle}>Caring for {elderProfile?.name ?? 'your elder'}</Text>
              </View>
              <TouchableOpacity
                style={styles.bellButton}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  router.push('/alerts');
                }}
                activeOpacity={0.7}
              >
                <Bell size={22} color={Colors.text} />
                {openAlerts.length > 0 && (
                  <View style={styles.bellDot}>
                    <Text style={styles.bellDotText}>{openAlerts.length}</Text>
                  </View>
                )}
              </TouchableOpacity>
            </View>

            <PastelCard color="mint" style={styles.heroCard}>
              <View style={styles.heroTop}>
                <View style={styles.heroLeft}>
                  <Text style={styles.heroName}>{elderProfile?.name ?? 'Elder'}</Text>
                  <StatusBadge type="elder" value={elderStatus?.status ?? 'offline'} size="medium" />
                </View>
                <View style={styles.heroMood}>
                  <Smile size={28} color={Colors.mintDark} />
                </View>
              </View>
              <Text style={styles.heroInteraction}>
                {elderStatus?.lastInteractionType ?? 'No interaction yet'}
              </Text>
              <Text style={styles.heroTime}>{elderStatus?.lastInteraction ?? 'N/A'}</Text>

              <View style={styles.heroStats}>
                <View style={styles.heroStat}>
                  <Activity size={14} color={Colors.mintDark} />
                  <Text style={styles.heroStatValue}>{elderStatus?.todayInteractions ?? 0}</Text>
                  <Text style={styles.heroStatLabel}>interactions</Text>
                </View>
                <View style={styles.heroStatDivider} />
                <View style={styles.heroStat}>
                  <Clock size={14} color={Colors.mintDark} />
                  <Text style={styles.heroStatValue}>{elderStatus?.activeMinutesToday ?? 0}m</Text>
                  <Text style={styles.heroStatLabel}>active today</Text>
                </View>
                <View style={styles.heroStatDivider} />
                <View style={styles.heroStat}>
                  <Smile size={14} color={Colors.mintDark} />
                  <Text style={styles.heroStatLabel}>{moodEmoji}</Text>
                </View>
              </View>

              <View style={styles.confidenceRow}>
                <Text style={styles.confidenceLabel}>Wellbeing confidence</Text>
                <Text style={styles.confidenceValue}>{elderStatus?.confidenceLevel ?? 0}%</Text>
              </View>
              <View style={styles.confidenceBar}>
                <Animated.View
                  style={[
                    styles.confidenceFill,
                    {
                      width: confidenceBarWidth.interpolate({
                        inputRange: [0, 1],
                        outputRange: ['0%', '100%'],
                      }),
                    },
                  ]}
                />
              </View>
            </PastelCard>

            {openAlerts.length > 0 && (
              <>
                <SectionHeader
                  title="Needs attention"
                  actionLabel="All alerts"
                  onAction={() => router.push('/alerts')}
                />
                <View style={styles.alertCards}>
                  {openAlerts.map((alert) => (
                    <PastelCard
                      key={alert.id}
                      color={alert.severity === 'high' || alert.severity === 'critical' ? 'peach' : 'lavender'}
                      onPress={() => router.push({ pathname: '/alert-detail', params: { id: alert.id } })}
                      style={styles.alertCard}
                    >
                      <View style={styles.alertCardRow}>
                        <AlertTriangle
                          size={18}
                          color={
                            alert.severity === 'high' || alert.severity === 'critical'
                              ? Colors.danger
                              : Colors.warning
                          }
                        />
                        <View style={styles.alertCardText}>
                          <Text style={styles.alertCardTitle}>{alert.title}</Text>
                          <Text style={styles.alertCardDesc} numberOfLines={1}>
                            {alert.description}
                          </Text>
                        </View>
                        <ChevronRight size={18} color={Colors.textTertiary} />
                      </View>
                    </PastelCard>
                  ))}
                </View>
              </>
            )}

            <SectionHeader title="Quick actions" />
            <View style={styles.quickActions}>
              <QuickAction
                icon={<Send size={22} color={Colors.skyDark} />}
                label="Nudge"
                color="sky"
                onPress={() => router.push('/(tabs)/connect')}
              />
              <QuickAction
                icon={<Mic size={22} color={Colors.lavenderDark} />}
                label="Voice note"
                color="lavender"
                onPress={() => router.push('/(tabs)/connect')}
              />
              <QuickAction
                icon={<CheckCircle size={22} color={Colors.mintDark} />}
                label="Acknowledge"
                color="mint"
                onPress={() => {
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                }}
              />
              <QuickAction
                icon={<ClipboardList size={22} color={Colors.peachDark} />}
                label="Care plan"
                color="peach"
                onPress={() => router.push('/(tabs)/care-plan')}
              />
            </View>

            <SectionHeader title="Today's timeline" />
            <View style={styles.timeline}>
              {todayTimeline.map((event, index) => (
                <View key={event.id} style={styles.timelineItem}>
                  <View style={styles.timelineLeft}>
                    <View
                      style={[
                        styles.timelineIcon,
                        { backgroundColor: colorMap[event.color] || Colors.mintLight },
                      ]}
                    >
                      {iconMap[event.icon] || <Clock size={16} color={Colors.textSecondary} />}
                    </View>
                    {index < todayTimeline.length - 1 && <View style={styles.timelineLine} />}
                  </View>
                  <View style={styles.timelineContent}>
                    <Text style={styles.timelineTitle}>{event.title}</Text>
                    {event.subtitle && (
                      <Text style={styles.timelineSubtitle}>{event.subtitle}</Text>
                    )}
                    <Text style={styles.timelineTime}>{event.time}</Text>
                  </View>
                </View>
              ))}
            </View>

            <PastelCard
              color="sky"
              onPress={() => router.push('/device-details')}
              style={styles.deviceCard}
            >
              <View style={styles.deviceRow}>
                <Wifi size={18} color={Colors.skyDark} />
                <Text style={styles.deviceLabel}>MITR Device</Text>
                <StatusBadge type="elder" value="online" size="small" />
                <ChevronRight size={16} color={Colors.textTertiary} />
              </View>
            </PastelCard>

            <View style={styles.bottomSpacer} />
          </ScrollView>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  safeArea: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 30,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 20,
  },
  greeting: {
    fontSize: 26,
    fontWeight: '700' as const,
    color: Colors.text,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 14,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  bellButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellDot: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellDotText: {
    color: Colors.white,
    fontSize: 10,
    fontWeight: '700' as const,
  },
  heroCard: {
    marginHorizontal: 20,
    marginBottom: 24,
  },
  heroTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  heroLeft: {
    gap: 8,
  },
  heroMood: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroName: {
    fontSize: 22,
    fontWeight: '700' as const,
    color: Colors.text,
    letterSpacing: -0.3,
  },
  heroInteraction: {
    fontSize: 15,
    color: Colors.text,
    fontWeight: '500' as const,
    marginBottom: 2,
  },
  heroTime: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginBottom: 16,
  },
  heroStats: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.5)',
    borderRadius: 14,
    padding: 12,
    marginBottom: 16,
  },
  heroStat: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    flexWrap: 'wrap',
  },
  heroStatValue: {
    fontSize: 15,
    fontWeight: '700' as const,
    color: Colors.text,
  },
  heroStatLabel: {
    fontSize: 11,
    color: Colors.textSecondary,
    fontWeight: '500' as const,
  },
  heroStatDivider: {
    width: 1,
    height: 24,
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  confidenceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  confidenceLabel: {
    fontSize: 13,
    color: Colors.textSecondary,
    fontWeight: '500' as const,
  },
  confidenceValue: {
    fontSize: 14,
    fontWeight: '700' as const,
    color: Colors.mintDark,
  },
  confidenceBar: {
    height: 6,
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderRadius: 3,
    overflow: 'hidden',
  },
  confidenceFill: {
    height: '100%',
    backgroundColor: Colors.mintDark,
    borderRadius: 3,
  },
  alertCards: {
    paddingHorizontal: 20,
    gap: 10,
    marginBottom: 24,
  },
  alertCard: {},
  alertCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  alertCardText: {
    flex: 1,
  },
  alertCardTitle: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  alertCardDesc: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  quickActions: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    gap: 12,
    marginBottom: 28,
  },
  timeline: {
    paddingHorizontal: 20,
    marginBottom: 24,
  },
  timelineItem: {
    flexDirection: 'row',
    minHeight: 60,
  },
  timelineLeft: {
    alignItems: 'center',
    width: 40,
  },
  timelineIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
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
    paddingLeft: 10,
    paddingBottom: 16,
  },
  timelineTitle: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  timelineSubtitle: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  timelineTime: {
    fontSize: 11,
    color: Colors.textTertiary,
    marginTop: 4,
  },
  deviceCard: {
    marginHorizontal: 20,
    marginBottom: 10,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  deviceLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  bottomSpacer: {
    height: 20,
  },
});
