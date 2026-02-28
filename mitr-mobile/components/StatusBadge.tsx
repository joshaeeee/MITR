import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Colors from '@/constants/colors';
import { ElderStatus, AlertSeverity, NudgeDeliveryState } from '@/constants/types';

interface StatusBadgeProps {
  type: 'elder' | 'severity' | 'delivery';
  value: ElderStatus | AlertSeverity | NudgeDeliveryState;
  size?: 'small' | 'medium';
}

const elderColors: Record<ElderStatus, { bg: string; text: string; dot: string }> = {
  online: { bg: Colors.mintLight, text: Colors.mintDark, dot: Colors.success },
  idle: { bg: Colors.warningLight, text: Colors.warning, dot: Colors.warning },
  offline: { bg: '#F0EEEB', text: Colors.textSecondary, dot: Colors.textTertiary },
  degraded: { bg: Colors.peachLight, text: Colors.peachDark, dot: Colors.peachDark },
};

const severityColors: Record<AlertSeverity, { bg: string; text: string }> = {
  low: { bg: Colors.skyLight, text: Colors.skyDark },
  medium: { bg: Colors.warningLight, text: Colors.warning },
  high: { bg: Colors.peachLight, text: Colors.danger },
  critical: { bg: Colors.dangerLight, text: Colors.danger },
};

const deliveryColors: Record<NudgeDeliveryState, { bg: string; text: string }> = {
  queued: { bg: Colors.surfaceAlt, text: Colors.textTertiary },
  delivering: { bg: Colors.skyLight, text: Colors.skyDark },
  delivered: { bg: Colors.mintLight, text: Colors.mintDark },
  acknowledged: { bg: Colors.lavenderLight, text: Colors.lavenderDark },
  failed: { bg: Colors.dangerLight, text: Colors.danger },
};

const elderLabels: Record<ElderStatus, string> = {
  online: 'Active',
  idle: 'Idle',
  offline: 'Offline',
  degraded: 'Degraded',
};

export default function StatusBadge({ type, value, size = 'small' }: StatusBadgeProps) {
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
