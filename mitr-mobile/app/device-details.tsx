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
import { Stack } from 'expo-router';
import {
  Wifi,
  Cpu,
  Clock,
  Hash,
  CheckCircle,
  AlertTriangle,
  Unlink,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/contexts/ThemeContext';
import PastelCard from '@/components/PastelCard';
import { useDeviceStatus, useUnlinkDevice } from '@/lib/api';

export default function DeviceDetailsScreen() {
  const colors = useColors();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const { data } = useDeviceStatus();
  const unlink = useUnlinkDevice();
  const deviceInfo =
    data?.device ?? {
      serialNumber: 'Not linked',
      firmwareVersion: 'Unknown',
      lastHeartbeat: 'N/A',
      connectivityStatus: 'disconnected' as const,
      wifiStrength: 0,
      diagnosticStatus: 'warning' as const,
      linkedAt: new Date().toISOString(),
    };

  const connectivityColors = {
    connected: { bg: colors.mintLight, text: colors.mintDark, icon: colors.success },
    intermittent: { bg: colors.warningLight, text: colors.warning, icon: colors.warning },
    disconnected: { bg: colors.dangerLight, text: colors.danger, icon: colors.danger },
  };

  const diagnosticColors = {
    healthy: { bg: colors.mintLight, text: colors.mintDark },
    warning: { bg: colors.warningLight, text: colors.warning },
    error: { bg: colors.dangerLight, text: colors.danger },
  };

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 400,
      useNativeDriver: true,
    }).start();
  }, []);

  const conn = connectivityColors[deviceInfo.connectivityStatus];
  const diag = diagnosticColors[deviceInfo.diagnosticStatus];

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: 'MITR Device' }} />
      <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          <PastelCard color="mint" style={styles.statusCard}>
            <View style={styles.statusIcon}>
              <Wifi size={32} color={conn.icon} />
            </View>
            <Text style={[styles.statusTitle, { color: colors.text }]}>
              {deviceInfo.connectivityStatus === 'connected'
                ? 'Device Online'
                : deviceInfo.connectivityStatus === 'intermittent'
                ? 'Connection Unstable'
                : 'Device Offline'}
            </Text>
            <Text style={[styles.statusSubtitle, { color: colors.textSecondary }]}>Last heartbeat: {deviceInfo.lastHeartbeat}</Text>
          </PastelCard>

          <View style={styles.detailGrid}>
            <PastelCard color="white" style={styles.detailCard}>
              <View style={styles.detailRow}>
                <View style={[styles.detailIcon, { backgroundColor: colors.skyLight }]}>
                  <Hash size={16} color={colors.skyDark} />
                </View>
                <View>
                  <Text style={[styles.detailLabel, { color: colors.textTertiary }]}>Serial Number</Text>
                  <Text style={[styles.detailValue, { color: colors.text }]}>{deviceInfo.serialNumber}</Text>
                </View>
              </View>
            </PastelCard>

            <PastelCard color="white" style={styles.detailCard}>
              <View style={styles.detailRow}>
                <View style={[styles.detailIcon, { backgroundColor: colors.lavenderLight }]}>
                  <Cpu size={16} color={colors.lavenderDark} />
                </View>
                <View>
                  <Text style={[styles.detailLabel, { color: colors.textTertiary }]}>Firmware</Text>
                  <Text style={[styles.detailValue, { color: colors.text }]}>{deviceInfo.firmwareVersion}</Text>
                </View>
              </View>
            </PastelCard>

            <PastelCard color="white" style={styles.detailCard}>
              <View style={styles.detailRow}>
                <View style={[styles.detailIcon, { backgroundColor: conn.bg }]}>
                  <Wifi size={16} color={conn.text} />
                </View>
                <View>
                  <Text style={[styles.detailLabel, { color: colors.textTertiary }]}>Wi-Fi Strength</Text>
                  <Text style={[styles.detailValue, { color: colors.text }]}>{deviceInfo.wifiStrength}%</Text>
                </View>
              </View>
            </PastelCard>

            <PastelCard color="white" style={styles.detailCard}>
              <View style={styles.detailRow}>
                <View style={[styles.detailIcon, { backgroundColor: diag.bg }]}>
                  {deviceInfo.diagnosticStatus === 'healthy' ? (
                    <CheckCircle size={16} color={diag.text} />
                  ) : (
                    <AlertTriangle size={16} color={diag.text} />
                  )}
                </View>
                <View>
                  <Text style={[styles.detailLabel, { color: colors.textTertiary }]}>Diagnostics</Text>
                  <Text style={[styles.detailValue, { color: diag.text }]}>
                    {deviceInfo.diagnosticStatus.charAt(0).toUpperCase() +
                      deviceInfo.diagnosticStatus.slice(1)}
                  </Text>
                </View>
              </View>
            </PastelCard>

            <PastelCard color="white" style={styles.detailCard}>
              <View style={styles.detailRow}>
                <View style={[styles.detailIcon, { backgroundColor: colors.peachLight }]}>
                  <Clock size={16} color={colors.peachDark} />
                </View>
                <View>
                  <Text style={[styles.detailLabel, { color: colors.textTertiary }]}>Linked Since</Text>
                  <Text style={[styles.detailValue, { color: colors.text }]}>
                    {new Date(deviceInfo.linkedAt).toLocaleDateString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </Text>
                </View>
              </View>
            </PastelCard>
          </View>

          <View style={styles.wifiBar}>
            <Text style={[styles.wifiBarLabel, { color: colors.textSecondary }]}>Signal strength</Text>
            <View style={[styles.wifiBarTrack, { backgroundColor: colors.surfaceAlt }]}>
              <View style={[styles.wifiBarFill, { width: `${deviceInfo.wifiStrength}%`, backgroundColor: colors.mintDark }]} />
            </View>
            <Text style={[styles.wifiBarValue, { color: colors.textTertiary }]}>{deviceInfo.wifiStrength}%</Text>
          </View>

          <TouchableOpacity
            style={[styles.unlinkBtn, { backgroundColor: colors.dangerLight }]}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
              Alert.alert(
                'Unlink device?',
                    'This will disconnect the MITR device from this family account. You can re-link it later.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Unlink',
                    style: 'destructive',
                    onPress: () => {
                      void unlink.mutateAsync();
                    }
                  },
                ]
              );
            }}
            activeOpacity={0.7}
          >
            <Unlink size={18} color={colors.danger} />
            <Text style={[styles.unlinkBtnText, { color: colors.danger }]}>Unlink device</Text>
          </TouchableOpacity>

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
    paddingTop: 14,
  },
  statusCard: {
    marginHorizontal: 20,
    alignItems: 'center',
    marginBottom: 24,
  },
  statusIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255,255,255,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  statusTitle: {
    fontSize: 20,
    fontWeight: '700' as const,
    marginBottom: 4,
  },
  statusSubtitle: {
    fontSize: 14,
  },
  detailGrid: {
    paddingHorizontal: 20,
    gap: 10,
    marginBottom: 24,
  },
  detailCard: {},
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  detailIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailLabel: {
    fontSize: 12,
    fontWeight: '500' as const,
  },
  detailValue: {
    fontSize: 15,
    fontWeight: '600' as const,
    marginTop: 1,
  },
  wifiBar: {
    paddingHorizontal: 20,
    marginBottom: 32,
  },
  wifiBarLabel: {
    fontSize: 13,
    fontWeight: '500' as const,
    marginBottom: 8,
  },
  wifiBarTrack: {
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 4,
  },
  wifiBarFill: {
    height: '100%',
    borderRadius: 4,
  },
  wifiBarValue: {
    fontSize: 12,
    textAlign: 'right',
  },
  unlinkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 20,
    borderRadius: 16,
    paddingVertical: 16,
  },
  unlinkBtnText: {
    fontSize: 15,
    fontWeight: '600' as const,
  },
  bottomSpacer: {
    height: 20,
  },
});
