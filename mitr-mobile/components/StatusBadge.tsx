import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useColors } from '@/contexts/ThemeContext';
import { ElderStatus, AlertSeverity, NudgeDeliveryState } from '@/constants/types';

interface StatusBadgeProps {
  type: 'elder' | 'severity' | 'delivery';
  value: ElderStatus | AlertSeverity | NudgeDeliveryState;
  size?: 'small' | 'medium';
}

export default function StatusBadge({ type, value, size = 'small' }: StatusBadgeProps) {
  const c = useColors();

  const elderColors: Record<ElderStatus, { bg: string; text: string; dot: string }> = {
    online: { bg: c.mintLight, text: c.mintDark, dot: c.success },
    idle: { bg: c.warningLight, text: c.warning, dot: c.warning },
    offline: { bg: c.surfaceAlt, text: c.textSecondary, dot: c.textTertiary },
    degraded: { bg: c.peachLight, text: c.peachDark, dot: c.peachDark },
  };

  const severityColors: Record<AlertSeverity, { bg: string; text: string }> = {
    low: { bg: c.skyLight, text: c.skyDark },
    medium: { bg: c.warningLight, text: c.warning },
    high: { bg: c.peachLight, text: c.danger },
    critical: { bg: c.dangerLight, text: c.danger },
  };

  const deliveryColors: Record<NudgeDeliveryState, { bg: string; text: string }> = {
    queued: { bg: c.surfaceAlt, text: c.textTertiary },
    delivering: { bg: c.skyLight, text: c.skyDark },
    delivered: { bg: c.mintLight, text: c.mintDark },
    acknowledged: { bg: c.lavenderLight, text: c.lavenderDark },
    failed: { bg: c.dangerLight, text: c.danger },
  };

  const elderLabels: Record<ElderStatus, string> = {
    online: 'Active',
    idle: 'Idle',
    offline: 'Offline',
    degraded: 'Degraded',
  };

  let colors: { bg: string; text: string; dot?: string };
  let label = value.charAt(0).toUpperCase() + value.slice(1);

  if (type === 'elder') {
    const v = value as ElderStatus;
    colors = elderColors[v];
    label = elderLabels[v];
  } else if (type === 'severity') {
    colors = severityColors[value as AlertSeverity];
  } else {
    colors = deliveryColors[value as NudgeDeliveryState];
  }

  const isSmall = size === 'small';

  return (
    <View style={[styles.badge, { backgroundColor: colors.bg }, isSmall ? styles.badgeSmall : styles.badgeMedium]}>
      {type === 'elder' && colors.dot && (
        <View style={[styles.dot, { backgroundColor: colors.dot }]} />
      )}
      <Text style={[styles.label, { color: colors.text }, isSmall ? styles.labelSmall : styles.labelMedium]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
  },
  badgeSmall: {
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeMedium: {
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  label: {
    fontWeight: '600' as const,
  },
  labelSmall: {
    fontSize: 11,
  },
  labelMedium: {
    fontSize: 13,
  },
});
