import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Check, Globe } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/contexts/ThemeContext';
import PastelCard from '@/components/PastelCard';
import { getOnboardingStatus, submitOnboardingAnswers } from '@/lib/api';

interface LanguageOption {
  code: string;
  name: string;
  nativeName: string;
}

const LANGUAGES: LanguageOption[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
  { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা' },
  { code: 'mr', name: 'Marathi', nativeName: 'मराठी' },
  { code: 'te', name: 'Telugu', nativeName: 'తెలుగు' },
  { code: 'gu', name: 'Gujarati', nativeName: 'ગુજરાતી' },
  { code: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ' },
  { code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം' },
  { code: 'pa', name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ' },
];

export default function LanguageSettingsScreen() {
  const router = useRouter();
  const colors = useColors();
  const [selected, setSelected] = useState<string>('en');
  const [saving, setSaving] = useState<boolean>(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 400,
      useNativeDriver: true,
    }).start();

    void (async () => {
      try {
        const status = await getOnboardingStatus();
        const fromProfile = status.profile?.appLanguage;
        if (fromProfile && LANGUAGES.some((lang) => lang.code === fromProfile)) {
          setSelected(fromProfile);
        }
      } catch {
        // keep default language when profile is unavailable
      }
    })();
  }, []);

  const handleSelect = (code: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelected(code);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await submitOnboardingAnswers({ appLanguage: selected });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: 'Language' }} />
      <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
        <View style={styles.header}>
          <View style={[styles.iconCircle, { backgroundColor: colors.skyLight }]}>
            <Globe size={24} color={colors.skyDark} />
          </View>
          <Text style={[styles.headerTitle, { color: colors.text }]}>App language</Text>
          <Text style={[styles.headerDesc, { color: colors.textSecondary }]}>Choose the language for the app interface. The elder device language is set separately.</Text>
        </View>

        <PastelCard color="white" style={styles.listCard} padded={false}>
          {LANGUAGES.map((lang, index) => (
            <React.Fragment key={lang.code}>
              {index > 0 && <View style={[styles.divider, { backgroundColor: colors.borderLight }]} />}
              <TouchableOpacity
                style={styles.langItem}
                onPress={() => handleSelect(lang.code)}
                activeOpacity={0.6}
              >
                <View style={styles.langInfo}>
                  <Text style={[styles.langName, { color: colors.text }]}>{lang.name}</Text>
                  <Text style={[styles.langNative, { color: colors.textTertiary }]}>{lang.nativeName}</Text>
                </View>
                {selected === lang.code && (
                  <View style={[styles.checkCircle, { backgroundColor: colors.mintDark }]}>
                    <Check size={14} color={colors.white} />
                  </View>
                )}
              </TouchableOpacity>
            </React.Fragment>
          ))}
        </PastelCard>

        <View style={styles.bottomBar}>
          <TouchableOpacity style={[styles.saveBtn, { backgroundColor: colors.text }]} onPress={handleSave} activeOpacity={0.8} disabled={saving}>
            <Text style={[styles.saveBtnText, { color: colors.surface }]}>{saving ? 'Saving...' : 'Save'}</Text>
          </TouchableOpacity>
        </View>
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
  header: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 24,
  },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700' as const,
    marginBottom: 6,
  },
  headerDesc: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  listCard: {
    marginHorizontal: 20,
    flex: 1,
  },
  langItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 15,
  },
  langInfo: {
    gap: 2,
  },
  langName: {
    fontSize: 15,
    fontWeight: '500' as const,
  },
  langNative: {
    fontSize: 13,
  },
  checkCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: {
    height: 1,
    marginLeft: 18,
  },
  bottomBar: {
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  saveBtn: {
    borderRadius: 18,
    paddingVertical: 18,
    alignItems: 'center',
  },
  saveBtnText: {
    fontSize: 16,
    fontWeight: '600' as const,
  },
});
