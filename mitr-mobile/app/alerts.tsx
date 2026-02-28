import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Animated,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Stack } from 'expo-router';
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  ChevronRight,
} from 'lucide-react-native';
import { useColors } from '@/contexts/ThemeContext';
import PastelCard from '@/components/PastelCard';
import StatusBadge from '@/components/StatusBadge';
import { AlertStatus } from '@/constants/types';
import { useAlerts } from '@/lib/api';

const filterOptions: { key: AlertStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'acknowledged', label: 'Acknowledged' },
  { key: 'resolved', label: 'Resolved' },
];

const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };

export default function AlertsScreen() {
  const router = useRouter();
  const colors = useColors();
  const [filter, setFilter] = useState<AlertStatus | 'all'>('all');
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const { data: alerts = [] } = useAlerts();

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 400,
      useNativeDriver: true,
    }).start();
  }, []);

  const filtered = alerts
    .filter((a) => filter === 'all' || a.status === filter)
    .sort((a, b) => {
      const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
      if (sevDiff !== 0) return sevDiff;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

  const statusIcon = (status: AlertStatus) => {
    if (status === 'open') return <AlertTriangle size={16} color={colors.warning} />;
    if (status === 'acknowledged') return <Clock size={16} color={colors.skyDark} />;
    return <CheckCircle size={16} color={colors.success} />;
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: 'Alerts' }} />
      <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          <View style={styles.filterRow}>
            {filterOptions.map((f) => (
              <TouchableOpacity
                key={f.key}
                style={[styles.filterChip, { backgroundColor: colors.surfaceAlt }, filter === f.key && { backgroundColor: colors.text }]}
                onPress={() => setFilter(f.key)}
                activeOpacity={0.7}
              >
                <Text style={[styles.filterText, { color: colors.textSecondary }, filter === f.key && { color: colors.surface }]}>
                  {f.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {filtered.length === 0 ? (
            <View style={styles.emptyState}>
              <CheckCircle size={48} color={colors.mintDark} />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>All clear</Text>
              <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>No alerts match this filter.</Text>
            </View>
          ) : (
            <View style={styles.alertList}>
              {filtered.map((alert) => (
                <PastelCard
                  key={alert.id}
                  color="white"
                  onPress={() => router.push({ pathname: '/alert-detail', params: { id: alert.id } })}
                >
                  <View style={styles.alertRow}>
                    {statusIcon(alert.status)}
                    <View style={styles.alertContent}>
                      <View style={styles.alertHeader}>
                        <Text style={[styles.alertTitle, { color: colors.text }]} numberOfLines={1}>{alert.title}</Text>
                        <StatusBadge type="severity" value={alert.severity} size="small" />
                      </View>
                      <Text style={[styles.alertDesc, { color: colors.textSecondary }]} numberOfLines={2}>{alert.description}</Text>
                      <View style={styles.alertMeta}>
                        <Text style={[styles.alertTime, { color: colors.textTertiary }]}>
                          {new Date(alert.createdAt).toLocaleDateString('en-IN', {
                            day: 'numeric',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </Text>
                        <Text style={[styles.alertStage, { color: colors.textTertiary }]}>
                          Stage: {alert.escalationStage.replace('_', ' ')}
                        </Text>
                      </View>
                    </View>
                    <ChevronRight size={18} color={colors.textTertiary} />
                  </View>
                </PastelCard>
              ))}
            </View>
          )}
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
  },
  filterRow: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    gap: 8,
    paddingVertical: 14,
  },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  filterText: {
    fontSize: 13,
    fontWeight: '600' as const,
  },
  alertList: {
    paddingHorizontal: 20,
    gap: 10,
  },
  alertRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
  },
  alertContent: {
    flex: 1,
  },
  alertHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
    gap: 8,
  },
  alertTitle: {
    fontSize: 14,
    fontWeight: '600' as const,
    flex: 1,
  },
  alertDesc: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 6,
  },
  alertMeta: {
    flexDirection: 'row',
    gap: 12,
  },
  alertTime: {
    fontSize: 11,
  },
  alertStage: {
    fontSize: 11,
    textTransform: 'capitalize' as const,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    gap: 10,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700' as const,
  },
  emptySubtitle: {
    fontSize: 14,
  },
});
