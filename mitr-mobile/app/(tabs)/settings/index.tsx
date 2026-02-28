import React, { useRef, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Modal,
  Pressable,
  Platform,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  User,
  Users,
  Shield,
  Bell,
  Globe,
  FileText,
  HelpCircle,
  ChevronRight,
  Wifi,
  LogOut,
  Heart,
  Home,
} from 'lucide-react-native';
import Colors from '@/constants/colors';
import PastelCard from '@/components/PastelCard';
import {
  useCurrentUser,
  useElderProfile,
  useEscalationPolicy,
  useFamilyMembers,
  useOnboardingStatus,
  useSignOut
} from '@/lib/api';

interface SettingsItemProps {
  icon: React.ReactNode;
  label: string;
  subtitle?: string;
  onPress: () => void;
  color?: string;
  danger?: boolean;
}

function SettingsItem({ icon, label, subtitle, onPress, danger }: SettingsItemProps) {
  return (
    <TouchableOpacity style={styles.settingsItem} onPress={onPress} activeOpacity={0.6}>
      <View style={styles.settingsItemLeft}>
        {icon}
        <View>
          <Text style={[styles.settingsItemLabel, danger && styles.settingsItemDanger]}>
            {label}
          </Text>
          {subtitle && <Text style={styles.settingsItemSubtitle}>{subtitle}</Text>}
        </View>
      </View>
      <ChevronRight size={18} color={Colors.textTertiary} />
    </TouchableOpacity>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const [showSignOut, setShowSignOut] = useState<boolean>(false);
  const modalFade = useRef(new Animated.Value(0)).current;
  const modalSlide = useRef(new Animated.Value(60)).current;
  const { data: currentUser } = useCurrentUser();
  const { data: elderProfile } = useElderProfile();
  const { data: familyMembers = [] } = useFamilyMembers();
  const { data: escalationPolicy } = useEscalationPolicy();
  const { data: onboardingStatus } = useOnboardingStatus();
  const signOut = useSignOut();

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 500,
      useNativeDriver: true,
    }).start();
  }, []);

  const openSignOutModal = () => {
    setShowSignOut(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Animated.parallel([
      Animated.timing(modalFade, { toValue: 1, duration: 250, useNativeDriver: true }),
      Animated.spring(modalSlide, { toValue: 0, friction: 8, useNativeDriver: true }),
    ]).start();
  };

  const closeSignOutModal = () => {
    Animated.parallel([
      Animated.timing(modalFade, { toValue: 0, duration: 200, useNativeDriver: true }),
      Animated.timing(modalSlide, { toValue: 60, duration: 200, useNativeDriver: true }),
    ]).start(() => setShowSignOut(false));
  };

  const handleSignOut = async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await signOut.mutateAsync();
    closeSignOutModal();
    router.replace('/welcome');
  };

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
            <View style={styles.header}>
              <Text style={styles.title}>Settings</Text>
            </View>

            <PastelCard color="mint" style={styles.profileCard}>
              <View style={styles.profileRow}>
                <View style={styles.profileAvatar}>
                  <Text style={styles.profileInitial}>
                    {currentUser?.name?.charAt(0) ?? 'F'}
                  </Text>
                </View>
                <View style={styles.profileInfo}>
                  <Text style={styles.profileName}>{currentUser?.name ?? 'Family user'}</Text>
                  <Text style={styles.profileRole}>Owner · {currentUser?.email ?? '-'}</Text>
                </View>
              </View>
            </PastelCard>

            <PastelCard color="lavender" style={styles.elderCard}>
              <View style={styles.elderRow}>
                <View style={styles.elderAvatar}>
                  <Text style={styles.elderInitial}>
                    {elderProfile?.name?.charAt(0) ?? 'E'}
                  </Text>
                </View>
                <View style={styles.elderInfo}>
                  <Text style={styles.elderName}>{elderProfile?.name ?? 'Elder profile'}</Text>
                  <Text style={styles.elderMeta}>
                    {elderProfile?.age ?? '-'} yrs · {elderProfile?.city ?? '-'} · {elderProfile?.language ?? '-'}
                  </Text>
                </View>
                <ChevronRight size={18} color={Colors.textTertiary} />
              </View>
            </PastelCard>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Account</Text>
              <PastelCard color="white" style={styles.sectionCard} padded={false}>
                <SettingsItem
                  icon={<User size={20} color={Colors.skyDark} />}
                  label="Elder profile"
                  subtitle={elderProfile?.name ?? 'Not configured'}
                  onPress={() => {}}
                />
                <View style={styles.divider} />
                <SettingsItem
                  icon={<Users size={20} color={Colors.mintDark} />}
                  label="Family members"
                  subtitle={`${familyMembers.length} members`}
                  onPress={() => router.push('/family-members')}
                />
                <View style={styles.divider} />
                <SettingsItem
                  icon={<Wifi size={20} color={Colors.lavenderDark} />}
                  label="Device"
                  subtitle="MITR-2026-JA-0042"
                  onPress={() => router.push('/device-details')}
                />
              </PastelCard>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Care settings</Text>
              <PastelCard color="white" style={styles.sectionCard} padded={false}>
                <SettingsItem
                  icon={<Shield size={20} color={Colors.peachDark} />}
                  label="Escalation policy"
                  subtitle={
                    escalationPolicy
                      ? `Quiet ${String(escalationPolicy.quietHoursStart)}–${String(escalationPolicy.quietHoursEnd)}`
                      : 'Not set'
                  }
                  onPress={() => {}}
                />
                <View style={styles.divider} />
                <SettingsItem
                  icon={<Bell size={20} color={Colors.warning} />}
                  label="Notifications"
                  onPress={() => {}}
                />
              </PastelCard>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>General</Text>
              <PastelCard color="white" style={styles.sectionCard} padded={false}>
                <SettingsItem
                  icon={<Globe size={20} color={Colors.skyDark} />}
                  label="Language & display"
                  subtitle={String(onboardingStatus?.profile?.appLanguage ?? 'en').toUpperCase()}
                  onPress={() => router.push('/language-settings' as never)}
                />
                <View style={styles.divider} />
                <SettingsItem
                  icon={<FileText size={20} color={Colors.textSecondary} />}
                  label="Privacy & terms"
                  onPress={() => {}}
                />
                <View style={styles.divider} />
                <SettingsItem
                  icon={<HelpCircle size={20} color={Colors.textSecondary} />}
                  label="Help & support"
                  onPress={() => {}}
                />
              </PastelCard>
            </View>

            <View style={styles.section}>
              <PastelCard color="white" style={styles.sectionCard} padded={false}>
                <SettingsItem
                  icon={<LogOut size={20} color={Colors.danger} />}
                  label="Sign out"
                  onPress={openSignOutModal}
                  danger
                />
              </PastelCard>
            </View>

            <Text style={styles.version}>MITR Family v1.0.0</Text>
            <View style={styles.bottomSpacer} />
          </ScrollView>
        </Animated.View>
      </SafeAreaView>

      <Modal visible={showSignOut} transparent animationType="none">
        <Animated.View style={[styles.modalOverlay, { opacity: modalFade }]}>
          <Pressable style={styles.modalBackdrop} onPress={closeSignOutModal} />
          <Animated.View style={[styles.modalContent, { transform: [{ translateY: modalSlide }] }]}>
            <View style={styles.modalIllustration}>
              <View style={styles.modalIlluBlob1} />
              <View style={styles.modalIlluBlob2} />
              <View style={styles.modalIconWrap}>
                <Home size={28} color={Colors.lavenderDark} />
              </View>
              <View style={styles.modalHeartFloat1}>
                <Heart size={14} color={Colors.peach} fill={Colors.peachLight} />
              </View>
              <View style={styles.modalHeartFloat2}>
                <Heart size={10} color={Colors.mintDark} fill={Colors.mintLight} />
              </View>
            </View>
            <Text style={styles.modalTitle}>Leaving so soon?</Text>
            <Text style={styles.modalSubtitle}>
              You will be signed out. Your family care data stays safe and you can sign back in anytime.
            </Text>
            <TouchableOpacity style={styles.modalSignOutBtn} onPress={handleSignOut} activeOpacity={0.8}>
              <LogOut size={18} color={Colors.white} />
              <Text style={styles.modalSignOutText}>Sign out</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.modalCancelBtn} onPress={closeSignOutModal} activeOpacity={0.7}>
              <Text style={styles.modalCancelText}>Stay signed in</Text>
            </TouchableOpacity>
          </Animated.View>
        </Animated.View>
      </Modal>
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
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: '700' as const,
    color: Colors.text,
    letterSpacing: -0.5,
  },
  profileCard: {
    marginHorizontal: 20,
    marginBottom: 12,
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  profileAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileInitial: {
    fontSize: 20,
    fontWeight: '700' as const,
    color: Colors.mintDark,
  },
  profileInfo: {
    flex: 1,
  },
  profileName: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  profileRole: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  elderCard: {
    marginHorizontal: 20,
    marginBottom: 24,
  },
  elderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  elderAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  elderInitial: {
    fontSize: 20,
    fontWeight: '700' as const,
    color: Colors.lavenderDark,
  },
  elderInfo: {
    flex: 1,
  },
  elderName: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  elderMeta: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600' as const,
    color: Colors.textTertiary,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  sectionCard: {
    marginHorizontal: 20,
  },
  settingsItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  settingsItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    flex: 1,
  },
  settingsItemLabel: {
    fontSize: 15,
    fontWeight: '500' as const,
    color: Colors.text,
  },
  settingsItemDanger: {
    color: Colors.danger,
  },
  settingsItemSubtitle: {
    fontSize: 12,
    color: Colors.textTertiary,
    marginTop: 1,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.borderLight,
    marginLeft: 52,
  },
  version: {
    textAlign: 'center',
    fontSize: 12,
    color: Colors.textTertiary,
    marginTop: 20,
  },
  bottomSpacer: {
    height: 20,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: Colors.overlay,
  },
  modalBackdrop: {
    flex: 1,
  },
  modalContent: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 28,
    paddingBottom: Platform.OS === 'web' ? 28 : 44,
    paddingTop: 20,
    alignItems: 'center',
  },
  modalIllustration: {
    width: 100,
    height: 100,
    marginBottom: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalIlluBlob1: {
    position: 'absolute',
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: Colors.lavenderLight,
    opacity: 0.7,
  },
  modalIlluBlob2: {
    position: 'absolute',
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: Colors.peachLight,
    opacity: 0.5,
    top: 6,
    right: 2,
  },
  modalIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  modalHeartFloat1: {
    position: 'absolute',
    top: 8,
    left: 8,
    zIndex: 3,
  },
  modalHeartFloat2: {
    position: 'absolute',
    bottom: 12,
    right: 10,
    zIndex: 3,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700' as const,
    color: Colors.text,
    marginBottom: 8,
  },
  modalSubtitle: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 21,
    marginBottom: 24,
    paddingHorizontal: 10,
  },
  modalSignOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.danger,
    borderRadius: 16,
    paddingVertical: 16,
    width: '100%',
    marginBottom: 10,
  },
  modalSignOutText: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.white,
  },
  modalCancelBtn: {
    paddingVertical: 14,
    width: '100%',
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 15,
    fontWeight: '500' as const,
    color: Colors.textSecondary,
  },
});
