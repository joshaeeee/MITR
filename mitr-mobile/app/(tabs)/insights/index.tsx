import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Lightbulb,
  AlertCircle,
  ChevronRight,
} from 'lucide-react-native';
import { useColors, useTheme } from '@/contexts/ThemeContext';
import PastelCard from '@/components/PastelCard';
import SectionHeader from '@/components/SectionHeader';
import StatusBadge from '@/components/StatusBadge';
import { InsightOverview } from '@/constants/types';
import { useInsights } from '@/lib/api';
import { ColorScheme } from '@/constants/colors';

function TrendIcon({ trend, colors }: { trend: string; colors: ColorScheme }) {
  if (trend === 'improving') return <TrendingUp size={14} color={colors.success} />;
  if (trend === 'declining') return <TrendingDown size={14} color={colors.danger} />;
  return <Minus size={14} color={colors.textTertiary} />;
}

function trendLabel(trend: string): string {
  if (trend === 'improving') return 'Improving';
  if (trend === 'declining') return 'Declining';
  return 'Stable';
}

function trendColor(trend: string, colors: ColorScheme): string {
  if (trend === 'improving') return colors.success;
  if (trend === 'declining') return colors.danger;
  return colors.textSecondary;
}

function MoodChart({ data, colors, isDark }: { data: InsightOverview; colors: ColorScheme; isDark: boolean }) {
  const maxScore = 10;
  return (
    <View style={chartStyles.barChart}>
      {data.dailyMoods.map((d) => (
        <View key={d.day} style={chartStyles.barCol}>
          <View style={[chartStyles.barTrack, { backgroundColor: isDark ? colors.borderLight : colors.surfaceAlt }]}>
            <View
              style={[
                chartStyles.barFill,
                {
                  height: `${(d.score / maxScore) * 100}%`,
                  backgroundColor: isDark ? colors.lavenderDark : colors.lavender,
                },
              ]}
            />
          </View>
          <Text style={[chartStyles.barLabel, { color: colors.textTertiary }]}>{d.day}</Text>
        </View>
      ))}
    </View>
  );
}

function EngagementChart({ data, colors, isDark }: { data: InsightOverview; colors: ColorScheme; isDark: boolean }) {
  const maxMin = Math.max(...data.dailyEngagement.map((d) => d.minutes));
  return (
    <View style={chartStyles.barChart}>
      {data.dailyEngagement.map((d) => (
        <View key={d.day} style={chartStyles.barCol}>
          <View style={[chartStyles.barTrack, { backgroundColor: isDark ? colors.borderLight : colors.surfaceAlt }]}>
            <View
              style={[
                chartStyles.barFill,
                {
                  height: `${(d.minutes / maxMin) * 100}%`,
                  backgroundColor: isDark ? colors.mintDark : colors.mint,
                },
              ]}
            />
          </View>
          <Text style={[chartStyles.barLabel, { color: colors.textTertiary }]}>{d.day}</Text>
        </View>
      ))}
    </View>
  );
}

export default function InsightsScreen() {
  const colors = useColors();
  const { isDark } = useTheme();
  const [period, setPeriod] = useState<'7d' | '30d'>('7d');
  const { data } = useInsights(period);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 500,
      useNativeDriver: true,
    }).start();
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
            <View style={styles.header}>
              <Text style={[styles.title, { color: colors.text }]}>Insights</Text>
              <View style={[styles.toggleRow, { backgroundColor: colors.surfaceAlt }]}>
                <TouchableOpacity
                  style={[styles.toggleBtn, period === '7d' && { backgroundColor: colors.surface }]}
                  onPress={() => setPeriod('7d')}
                >
                  <Text style={[styles.toggleText, { color: colors.textTertiary }, period === '7d' && { color: colors.text }]}>7 days</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.toggleBtn, period === '30d' && { backgroundColor: colors.surface }]}
                  onPress={() => setPeriod('30d')}
                >
                  <Text style={[styles.toggleText, { color: colors.textTertiary }, period === '30d' && { color: colors.text }]}>30 days</Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.metricsRow}>
              <PastelCard color="lavender" style={styles.metricCard}>
                <Text style={[styles.metricLabel, { color: colors.textSecondary }]}>Avg Mood</Text>
                <Text style={[styles.metricValue, { color: colors.text }]}>{data?.avgMoodScore ?? 0}/10</Text>
                <View style={styles.trendRow}>
                  <TrendIcon trend={data?.moodTrend ?? 'stable'} colors={colors} />
                  <Text style={[styles.trendText, { color: trendColor(data?.moodTrend ?? 'stable', colors) }]}>
                    {trendLabel(data?.moodTrend ?? 'stable')}
                  </Text>
                </View>
              </PastelCard>
              <PastelCard color="mint" style={styles.metricCard}>
                <Text style={[styles.metricLabel, { color: colors.textSecondary }]}>Engagement</Text>
                <Text style={[styles.metricValue, { color: colors.text }]}>{data?.engagementScore ?? 0}%</Text>
                <View style={styles.trendRow}>
                  <TrendIcon trend={data?.engagementTrend ?? 'stable'} colors={colors} />
                  <Text style={[styles.trendText, { color: trendColor(data?.engagementTrend ?? 'stable', colors) }]}>
                    {trendLabel(data?.engagementTrend ?? 'stable')}
                  </Text>
                </View>
              </PastelCard>
            </View>

            <SectionHeader title="Mood trend" />
            <PastelCard color="white" style={styles.chartCard}>
              {data ? <MoodChart data={data} colors={colors} isDark={isDark} /> : <Text style={[styles.emptyStateText, { color: colors.textTertiary }]}>Loading mood trend…</Text>}
            </PastelCard>

            <SectionHeader title="Daily engagement" />
            <PastelCard color="white" style={styles.chartCard}>
              {data ? <EngagementChart data={data} colors={colors} isDark={isDark} /> : <Text style={[styles.emptyStateText, { color: colors.textTertiary }]}>Loading engagement…</Text>}
            </PastelCard>

            <SectionHeader title="What she's talking about" />
            <View style={styles.topicCloud}>
              {(data?.topTopics ?? []).map((t) => {
                const topicColors = [colors.mintLight, colors.lavenderLight, colors.peachLight, colors.skyLight];
                const textColors = [colors.mintDark, colors.lavenderDark, colors.peachDark, colors.skyDark];
                const idx = (data?.topTopics ?? []).indexOf(t) % 4;
                return (
                  <View
                    key={t.topic}
                    style={[styles.topicChip, { backgroundColor: topicColors[idx] }]}
                  >
                    <Text style={[styles.topicText, { color: textColors[idx] }]}>
                      {t.topic}
                    </Text>
                    <Text style={[styles.topicCount, { color: textColors[idx] }]}>
                      {t.count}
                    </Text>
                  </View>
                );
              })}
            </View>

            {(data?.concernSignals?.length ?? 0) > 0 && (
              <>
                <SectionHeader title="Concern signals" />
                <View style={styles.concernList}>
                  {(data?.concernSignals ?? []).map((s) => (
                    <PastelCard key={s.id} color="white" style={styles.concernCard}>
                      <View style={styles.concernRow}>
                        <AlertCircle
                          size={18}
                          color={
                            s.severity === 'medium' || s.severity === 'high'
                              ? colors.warning
                              : colors.info
                          }
                        />
                        <View style={styles.concernText}>
                          <View style={styles.concernHeader}>
                            <Text style={[styles.concernLabel, { color: colors.text }]}>{s.label}</Text>
                            <StatusBadge type="severity" value={s.severity} size="small" />
                          </View>
                          <Text style={[styles.concernDesc, { color: colors.textSecondary }]}>{s.description}</Text>
                          <Text style={[styles.concernMeta, { color: colors.textTertiary }]}>
                            {s.occurrences} occurrences · {s.confidence}% confidence
                          </Text>
                        </View>
                      </View>
                    </PastelCard>
                  ))}
                </View>
              </>
            )}

            {(data?.recommendations?.length ?? 0) > 0 && (
              <>
                <SectionHeader title="Recommendations" />
                <View style={styles.recList}>
                  {(data?.recommendations ?? []).map((r) => (
                    <PastelCard key={r.id} color="sky" style={styles.recCard}>
                      <View style={styles.recRow}>
                        <Lightbulb size={18} color={colors.skyDark} />
                        <View style={styles.recText}>
                          <Text style={[styles.recDesc, { color: colors.text }]}>{r.text}</Text>
                          <TouchableOpacity style={styles.recAction} activeOpacity={0.7}>
                            <Text style={[styles.recActionText, { color: colors.skyDark }]}>{r.actionLabel}</Text>
                            <ChevronRight size={14} color={colors.skyDark} />
                          </TouchableOpacity>
                        </View>
                      </View>
                    </PastelCard>
                  ))}
                </View>
              </>
            )}

            <View style={styles.bottomSpacer} />
          </ScrollView>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}

const chartStyles = StyleSheet.create({
  barChart: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    height: 100,
    gap: 6,
  },
  barCol: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
  },
  barTrack: {
    width: '100%',
    height: 80,
    borderRadius: 8,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  barFill: {
    width: '100%',
    borderRadius: 8,
  },
  barLabel: {
    fontSize: 10,
    fontWeight: '500' as const,
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
    marginBottom: 14,
  },
  toggleRow: {
    flexDirection: 'row',
    borderRadius: 12,
    padding: 3,
    alignSelf: 'flex-start',
  },
  toggleBtn: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 10,
  },
  toggleText: {
    fontSize: 13,
    fontWeight: '600' as const,
  },
  metricsRow: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    gap: 12,
    marginBottom: 24,
  },
  metricCard: {
    flex: 1,
  },
  metricLabel: {
    fontSize: 12,
    fontWeight: '500' as const,
    marginBottom: 4,
  },
  metricValue: {
    fontSize: 24,
    fontWeight: '700' as const,
    letterSpacing: -0.5,
  },
  trendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 6,
  },
  trendText: {
    fontSize: 12,
    fontWeight: '600' as const,
  },
  chartCard: {
    marginHorizontal: 20,
    marginBottom: 24,
  },
  emptyStateText: {
    fontSize: 13,
  },
  topicCloud: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 20,
    gap: 8,
    marginBottom: 24,
  },
  topicChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 6,
  },
  topicText: {
    fontSize: 13,
    fontWeight: '600' as const,
  },
  topicCount: {
    fontSize: 11,
    fontWeight: '500' as const,
    opacity: 0.7,
  },
  concernList: {
    paddingHorizontal: 20,
    gap: 10,
    marginBottom: 24,
  },
  concernCard: {},
  concernRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
  },
  concernText: {
    flex: 1,
  },
  concernHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  concernLabel: {
    fontSize: 14,
    fontWeight: '600' as const,
    flex: 1,
    marginRight: 8,
  },
  concernDesc: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 4,
  },
  concernMeta: {
    fontSize: 11,
  },
  recList: {
    paddingHorizontal: 20,
    gap: 10,
    marginBottom: 24,
  },
  recCard: {},
  recRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
  },
  recText: {
    flex: 1,
  },
  recDesc: {
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 8,
  },
  recAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  recActionText: {
    fontSize: 13,
    fontWeight: '600' as const,
  },
  bottomSpacer: {
    height: 20,
  },
});
