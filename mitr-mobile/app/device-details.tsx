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
  WifiOff,
  Battery,
  Cpu,
  Clock,
  Hash,
  CheckCircle,
  AlertTriangle,
  Unlink,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import Colors from '@/constants/colors';
import PastelCard from '@/components/PastelCard';
import { useDeviceStatus, useUnlinkDevice } from '@/lib/api';

const connectivityColors = {
  connected: { bg: Colors.mintLight, text: Colors.mintDark, icon: Colors.success },
  intermittent: { bg: Colors.warningLight, text: Colors.warning, icon: Colors.warning },
  disconnected: { bg: Colors.dangerLight, text: Colors.danger, icon: Colors.danger },
};

const diagnosticColors = {
  healthy: { bg: Colors.mintLight, text: Colors.mintDark },
  warning: { bg: Colors.warningLight, text: Colors.warning },
  error: { bg: Colors.dangerLight, text: Colors.danger },
};

export default function DeviceDetailsScreen() {
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
    <View style={styles.root}>
      <Stack.Screen options={{ title: 'MITR Device' }} />
      <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          <PastelCard color="mint" style={styles.statusCard}>
            <View style={styles.statusIcon}>
              <Wifi size={32} color={conn.icon} />
            </View>
            <Text style={styles.statusTitle}>
              {deviceInfo.connectivityStatus === 'connected'
                ? 'Device Online'
                : deviceInfo.connectivityStatus === 'intermittent'
                ? 'Connection Unstable'
                : 'Device Offline'}
            </Text>
            <Text style={styles.statusSubtitle}>Last heartbeat: {deviceInfo.lastHeartbeat}</Text>
          </PastelCard>

          <View style={styles.detailGrid}>
            <PastelCard color="white" style={styles.detailCard}>
              <View style={styles.detailRow}>
                <View style={[styles.detailIcon, { backgroundColor: Colors.skyLight }]}>
                  <Hash size={16} color={Colors.skyDark} />
                </View>
                <View>
                  <Text style={styles.detailLabel}>Serial Number</Text>
                  <Text style={styles.detailValue}>{deviceInfo.serialNumber}</Text>
                </View>
              </View>
            </PastelCard>

            <PastelCard color="white" style={styles.detailCard}>
              <View style={styles.detailRow}>
                <View style={[styles.detailIcon, { backgroundColor: Colors.lavenderLight }]}>
                  <Cpu size={16} color={Colors.lavenderDark} />
                </View>
                <View>
                  <Text style={styles.detailLabel}>Firmware</Text>
                  <Text style={styles.detailValue}>{deviceInfo.firmwareVersion}</Text>
                </View>
              </View>
            </PastelCard>

            <PastelCard color="white" style={styles.detailCard}>
              <View style={styles.detailRow}>
                <View style={[styles.detailIcon, { backgroundColor: conn.bg }]}>
                  <Wifi size={16} color={conn.text} />
                </View>
                <View>
                  <Text style={styles.detailLabel}>Wi-Fi Strength</Text>
                  <Text style={styles.detailValue}>{deviceInfo.wifiStrength}%</Text>
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
                  <Text style={styles.detailLabel}>Diagnostics</Text>
                  <Text style={[styles.detailValue, { color: diag.text }]}>
                    {deviceInfo.diagnosticStatus.charAt(0).toUpperCase() +
                      deviceInfo.diagnosticStatus.slice(1)}
                  </Text>
                </View>
              </View>
            </PastelCard>

            <PastelCard color="white" style={styles.detailCard}>
              <View style={styles.detailRow}>
                <View style={[styles.detailIcon, { backgroundColor: Colors.peachLight }]}>
                  <Clock size={16} color={Colors.peachDark} />
                </View>
                <View>
                  <Text style={styles.detailLabel}>Linked Since</Text>
                  <Text style={styles.detailValue}>
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
            <Text style={styles.wifiBarLabel}>Signal strength</Text>
            <View style={styles.wifiBarTrack}>
              <View style={[styles.wifiBarFill, { width: `${deviceInfo.wifiStrength}%` }]} />
            </View>
            <Text style={styles.wifiBarValue}>{deviceInfo.wifiStrength}%</Text>
          </View>

          <TouchableOpacity
            style={styles.unlinkBtn}
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
            <Unlink size={18} color={Colors.danger} />
            <Text style={styles.unlinkBtnText}>Unlink device</Text>
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
    backgroundColor: Colors.background,
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
    color: Colors.text,
    marginBottom: 4,
  },
  statusSubtitle: {
    fontSize: 14,
    color: Colors.textSecondary,
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
    color: Colors.textTertiary,
    fontWeight: '500' as const,
  },
  detailValue: {
    fontSize: 15,
    fontWeight: '600' as const,
    color: Colors.text,
    marginTop: 1,
  },
  wifiBar: {
    paddingHorizontal: 20,
    marginBottom: 32,
  },
  wifiBarLabel: {
    fontSize: 13,
    color: Colors.textSecondary,
    fontWeight: '500' as const,
    marginBottom: 8,
  },
  wifiBarTrack: {
    height: 8,
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 4,
  },
  wifiBarFill: {
    height: '100%',
    backgroundColor: Colors.mintDark,
    borderRadius: 4,
  },
  wifiBarValue: {
    fontSize: 12,
    color: Colors.textTertiary,
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
    backgroundColor: Colors.dangerLight,
  },
  unlinkBtnText: {
    color: Colors.danger,
    fontSize: 15,
    fontWeight: '600' as const,
  },
  bottomSpacer: {
    height: 20,
  },
});
