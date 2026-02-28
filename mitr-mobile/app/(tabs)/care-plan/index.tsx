import React, { useRef, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Switch,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Pill,
  Dumbbell,
  Calendar,
  Sunrise,
  Music,
  BookOpen,
  Moon,
  CheckCircle2,
  Circle,
  Star,
} from 'lucide-react-native';
import { useColors, useTheme } from '@/contexts/ThemeContext';
import PastelCard from '@/components/PastelCard';
import SectionHeader from '@/components/SectionHeader';
import { useCareReminders, useCareRoutines, usePatchCareReminder, usePatchRoutine } from '@/lib/api';

export default function CarePlanScreen() {
  const colors = useColors();
  const { isDark } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const { data: reminders = [] } = useCareReminders();
  const { data: routines = [] } = useCareRoutines();
  const patchReminder = usePatchCareReminder();
  const patchRoutine = usePatchRoutine();

  const categoryIcons: Record<string, React.ReactNode> = {
    medication: <Pill size={18} color={colors.lavenderDark} />,
    exercise: <Dumbbell size={18} color={colors.mintDark} />,
    appointment: <Calendar size={18} color={colors.skyDark} />,
    custom: <Star size={18} color={colors.peachDark} />,
    briefing: <Sunrise size={18} color={colors.skyDark} />,
    satsang: <Music size={18} color={colors.peachDark} />,
    social: <BookOpen size={18} color={colors.mintDark} />,
    rest: <Moon size={18} color={colors.lavenderDark} />,
  };

  const categoryColors: Record<string, string> = {
    medication: colors.lavenderLight,
    exercise: colors.mintLight,
    appointment: colors.skyLight,
    custom: colors.peachLight,
    briefing: colors.skyLight,
    satsang: colors.peachLight,
    social: colors.mintLight,
    rest: colors.lavenderLight,
  };

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 500,
      useNativeDriver: true,
    }).start();
  }, []);

  const totalReminders = reminders.length;
  const enabledReminders = reminders.filter((r) => r.enabled).length;
  const avgAdherence = totalReminders
    ? Math.round(reminders.reduce((sum, r) => sum + r.adherenceRate, 0) / totalReminders)
    : 0;
  const completedRoutines = routines.filter((r) => r.completedToday).length;
  const totalRoutines = routines.length;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
            <View style={styles.header}>
              <Text style={[styles.title, { color: colors.text }]}>Care Plan</Text>
              <Text style={[styles.subtitle, { color: colors.textSecondary }]}>Manage routines and reminders for Kamla Devi</Text>
            </View>

            <View style={styles.summaryRow}>
              <PastelCard color="mint" style={styles.summaryCard}>
                <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>Adherence</Text>
                <Text style={[styles.summaryValue, { color: colors.text }]}>{avgAdherence}%</Text>
                <Text style={[styles.summaryMeta, { color: colors.textTertiary }]}>Last 7 days</Text>
              </PastelCard>
              <PastelCard color="lavender" style={styles.summaryCard}>
                <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>Today</Text>
                <Text style={[styles.summaryValue, { color: colors.text }]}>
                  {completedRoutines}/{totalRoutines}
                </Text>
                <Text style={[styles.summaryMeta, { color: colors.textTertiary }]}>Routines done</Text>
              </PastelCard>
            </View>

            <SectionHeader title="Reminders" />
            <View style={styles.reminderList}>
              {reminders.map((reminder) => (
                <PastelCard key={reminder.id} color="white" style={styles.reminderCard}>
                  <View style={styles.reminderRow}>
                    <View
                      style={[
                        styles.reminderIcon,
                        { backgroundColor: categoryColors[reminder.category] },
                      ]}
                    >
                      {categoryIcons[reminder.category]}
                    </View>
                    <View style={styles.reminderContent}>
                      <View style={styles.reminderHeader}>
                        <Text style={[styles.reminderTitle, { color: colors.text }]}>{reminder.title}</Text>
                        <Switch
                          value={reminder.enabled}
                          trackColor={{ false: colors.surfaceAlt, true: isDark ? colors.mintDark : colors.mint }}
                          thumbColor={colors.white}
                          ios_backgroundColor={colors.surfaceAlt}
                          onValueChange={(enabled) => {
                            void patchReminder.mutateAsync({ id: reminder.id, enabled });
                          }}
                        />
                      </View>
                      {reminder.description && (
                        <Text style={[styles.reminderDesc, { color: colors.textSecondary }]}>{reminder.description}</Text>
                      )}
                      <View style={styles.reminderMeta}>
                        <Text style={[styles.reminderTime, { color: colors.text }]}>{reminder.time}</Text>
                        <Text style={[styles.reminderDays, { color: colors.textTertiary }]}>
                          {reminder.days.length === 7 ? 'Every day' : reminder.days.join(', ')}
                        </Text>
                      </View>
                      <View style={styles.adherenceRow}>
                        <Text style={[styles.adherenceLabel, { color: colors.textTertiary }]}>Adherence {reminder.adherenceRate}%</Text>
                        <AdherenceBar rate={reminder.adherenceRate} />
                      </View>
                    </View>
                  </View>
                </PastelCard>
              ))}
            </View>

            <SectionHeader title="Daily routines" />
            <View style={styles.routineList}>
              {routines.map((routine) => (
                <PastelCard key={routine.id} color="white" style={styles.routineCard}>
                  <View style={styles.routineRow}>
                    <View
                      style={[
                        styles.routineIcon,
                        { backgroundColor: categoryColors[routine.category] },
                      ]}
                    >
                      {categoryIcons[routine.category]}
                    </View>
                    <View style={styles.routineContent}>
                      <View style={styles.routineHeader}>
                        <Text style={[styles.routineTitle, { color: colors.text }]}>{routine.title}</Text>
                        {routine.completedToday ? (
                          <CheckCircle2 size={20} color={colors.success} />
                        ) : (
                          <Circle size={20} color={colors.borderLight} />
                        )}
                      </View>
                      {routine.description && (
                        <Text style={[styles.routineDesc, { color: colors.textSecondary }]}>{routine.description}</Text>
                      )}
                      <View style={styles.routineMeta}>
                        <Text style={[styles.routineTime, { color: colors.text }]}>{routine.time}</Text>
                        <View
                          style={[
                            styles.routineSlot,
                            {
                              backgroundColor:
                                routine.timeSlot === 'morning'
                                  ? colors.skyLight
                                  : routine.timeSlot === 'afternoon'
                                  ? colors.peachLight
                                  : routine.timeSlot === 'evening'
                                  ? colors.lavenderLight
                                  : colors.surfaceAlt,
                            },
                          ]}
                        >
                          <Text style={[styles.routineSlotText, { color: colors.textSecondary }]}>
                            {routine.timeSlot.charAt(0).toUpperCase() + routine.timeSlot.slice(1)}
                          </Text>
                        </View>
                        <Switch
                          value={routine.enabled}
                          trackColor={{ false: colors.surfaceAlt, true: isDark ? colors.mintDark : colors.mint }}
                          thumbColor={colors.white}
                          ios_backgroundColor={colors.surfaceAlt}
                          onValueChange={(enabled) => {
                            void patchRoutine.mutateAsync({ id: routine.id, enabled });
                          }}
                        />
                      </View>
                    </View>
                  </View>
                </PastelCard>
              ))}
            </View>

            <View style={styles.bottomSpacer} />
          </ScrollView>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}

function AdherenceBar({ rate }: { rate: number }) {
  const colors = useColors();
  const widthAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(widthAnim, {
      toValue: rate / 100,
      duration: 800,
      delay: 300,
      useNativeDriver: false,
    }).start();
  }, [rate]);

  const barColor = rate >= 80 ? colors.mintDark : rate >= 60 ? colors.warning : colors.danger;

  return (
    <View style={[adherenceStyles.track, { backgroundColor: colors.surfaceAlt }]}>
      <Animated.View
        style={[
          adherenceStyles.fill,
          {
            backgroundColor: barColor,
            width: widthAnim.interpolate({
              inputRange: [0, 1],
              outputRange: ['0%', '100%'],
            }),
          },
        ]}
      />
    </View>
  );
}

const adherenceStyles = StyleSheet.create({
  track: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    marginTop: 6,
  },
  fill: {
    height: '100%',
    borderRadius: 2,
  },
});

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 110,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: '700' as const,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 14,
    marginTop: 4,
  },
  summaryRow: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    gap: 12,
    marginBottom: 24,
  },
  summaryCard: {
    flex: 1,
    alignItems: 'center',
  },
  summaryLabel: {
    fontSize: 12,
    fontWeight: '500' as const,
    marginBottom: 4,
  },
  summaryValue: {
    fontSize: 28,
    fontWeight: '700' as const,
    letterSpacing: -0.5,
  },
  summaryMeta: {
    fontSize: 11,
    marginTop: 2,
  },
  reminderList: {
    paddingHorizontal: 20,
    gap: 10,
    marginBottom: 28,
  },
  reminderCard: {},
  reminderRow: {
    flexDirection: 'row',
    gap: 12,
  },
  reminderIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reminderContent: {
    flex: 1,
  },
  reminderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  reminderTitle: {
    fontSize: 15,
    fontWeight: '600' as const,
    flex: 1,
    marginRight: 8,
  },
  reminderDesc: {
    fontSize: 13,
    marginBottom: 6,
  },
  reminderMeta: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
  },
  reminderTime: {
    fontSize: 13,
    fontWeight: '600' as const,
  },
  reminderDays: {
    fontSize: 12,
  },
  adherenceRow: {
    marginTop: 8,
  },
  adherenceLabel: {
    fontSize: 11,
    marginBottom: 2,
  },
  routineList: {
    paddingHorizontal: 20,
    gap: 10,
  },
  routineCard: {},
  routineRow: {
    flexDirection: 'row',
    gap: 12,
  },
  routineIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  routineContent: {
    flex: 1,
  },
  routineHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  routineTitle: {
    fontSize: 15,
    fontWeight: '600' as const,
    flex: 1,
    marginRight: 8,
  },
  routineDesc: {
    fontSize: 13,
    marginBottom: 6,
  },
  routineMeta: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  routineTime: {
    fontSize: 13,
    fontWeight: '600' as const,
  },
  routineSlot: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  routineSlotText: {
    fontSize: 10,
    fontWeight: '600' as const,
  },
  bottomSpacer: {
    height: 20,
  },
});
