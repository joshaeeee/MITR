import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Animated,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  ArrowRight,
  ArrowLeft,
  User,
  Users,
  Heart,
  Pill,
  Wifi,
  Plus,
  X,
  Check,
  Stethoscope,
  Calendar,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import Colors from '@/constants/colors';
import {
  createCareReminder,
  getCareRemindersRaw,
  getElderProfileRaw,
  getFamilyMembersRaw,
  getOnboardingStatus,
  inviteFamilyMember,
  linkElderDevice,
  submitOnboardingAnswers,
  upsertElderProfile
} from '@/lib/api';

const TOTAL_STEPS = 6;

interface FamilyMemberInput {
  id: string;
  name: string;
  relation: string;
  phone: string;
}

interface MedicineInput {
  id: string;
  name: string;
  dosage: string;
  time: string;
}

const RELATIONS = ['Son', 'Daughter', 'Spouse', 'Daughter-in-law', 'Son-in-law', 'Grandchild', 'Sibling', 'Other'];
const TIMES = ['Morning', 'Afternoon', 'Evening', 'Night', 'Before meals', 'After meals'];

const STEP_INFO = [
  { icon: User, color: Colors.mintLight, iconColor: Colors.mintDark, title: "Elder's name", desc: 'Who will MITR be a companion for?' },
  { icon: Calendar, color: Colors.lavenderLight, iconColor: Colors.lavenderDark, title: 'Age & details', desc: 'A little more about your loved one' },
  { icon: Users, color: Colors.skyLight, iconColor: Colors.skyDark, title: 'Family members', desc: 'Who else will use this app?' },
  { icon: Stethoscope, color: Colors.peachLight, iconColor: Colors.peachDark, title: 'Medical history', desc: 'Any conditions to keep in mind?' },
  { icon: Pill, color: Colors.lavenderLight, iconColor: Colors.lavenderDark, title: 'Medicines', desc: 'Regular medications, if any' },
  { icon: Wifi, color: Colors.mintLight, iconColor: Colors.mintDark, title: 'Connect device', desc: 'Pair your MITR companion' },
];

export default function OnboardingScreen() {
  const router = useRouter();
  const [step, setStep] = useState<number>(0);

  const [elderName, setElderName] = useState<string>('');
  const [elderAge, setElderAge] = useState<string>('');
  const [elderCity, setElderCity] = useState<string>('');
  const [elderLanguage, setElderLanguage] = useState<string>('Hindi');

  const [familyMembers, setFamilyMembers] = useState<FamilyMemberInput[]>([]);
  const [showAddFamily, setShowAddFamily] = useState<boolean>(false);
  const [newMemberName, setNewMemberName] = useState<string>('');
  const [newMemberRelation, setNewMemberRelation] = useState<string>('');
  const [newMemberPhone, setNewMemberPhone] = useState<string>('');

  const [medicalConditions, setMedicalConditions] = useState<string>('');
  const [allergies, setAllergies] = useState<string>('');
  const [notes, setNotes] = useState<string>('');

  const [medicines, setMedicines] = useState<MedicineInput[]>([]);
  const [showAddMedicine, setShowAddMedicine] = useState<boolean>(false);
  const [newMedName, setNewMedName] = useState<string>('');
  const [newMedDosage, setNewMedDosage] = useState<string>('');
  const [newMedTime, setNewMedTime] = useState<string>('');

  const [deviceCode, setDeviceCode] = useState<string>('');
  const [loadingInitial, setLoadingInitial] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const fadeAnim = useRef(new Animated.Value(1)).current;
  const slideAnim = useRef(new Animated.Value(0)).current;

  const toLanguageCode = (value: string): string => {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'hindi') return 'hi-IN';
    if (normalized === 'english') return 'en-IN';
    if (normalized === 'tamil') return 'ta-IN';
    if (normalized === 'bengali') return 'bn-IN';
    if (normalized === 'marathi') return 'mr-IN';
    return 'hi-IN';
  };

  const toReminderTime = (value: string): string => {
    const normalized = value.trim().toLowerCase();
    if (normalized.includes('morning')) return '08:00';
    if (normalized.includes('afternoon')) return '13:00';
    if (normalized.includes('evening')) return '18:00';
    if (normalized.includes('night')) return '21:00';
    if (normalized.includes('before meals')) return '07:30';
    if (normalized.includes('after meals')) return '20:00';
    return '08:00';
  };

  const loadOnboardingData = useCallback(async () => {
    setLoadingInitial(true);
    try {
      const [status, elder, members, reminders] = await Promise.all([
        getOnboardingStatus(),
        getElderProfileRaw(),
        getFamilyMembersRaw(),
        getCareRemindersRaw()
      ]);
      const answers = status.profile ?? {};

      if (elder) {
        if (typeof elder.name === 'string' && elder.name) setElderName(elder.name);
        if (typeof elder.ageRange === 'string' && elder.ageRange) setElderAge(elder.ageRange);
        if (typeof elder.city === 'string' && elder.city) setElderCity(elder.city);
        if (typeof elder.language === 'string' && elder.language) {
          const lang = elder.language.toLowerCase();
          if (lang.startsWith('hi')) setElderLanguage('Hindi');
          else if (lang.startsWith('en')) setElderLanguage('English');
          else if (lang.startsWith('ta')) setElderLanguage('Tamil');
          else if (lang.startsWith('bn')) setElderLanguage('Bengali');
          else if (lang.startsWith('mr')) setElderLanguage('Marathi');
        }
      }

      if (typeof answers.elderName === 'string' && answers.elderName) setElderName(answers.elderName);
      if (typeof answers.elderAge === 'string' && answers.elderAge) setElderAge(answers.elderAge);
      if (typeof answers.elderCity === 'string' && answers.elderCity) setElderCity(answers.elderCity);
      if (typeof answers.elderLanguage === 'string' && answers.elderLanguage) setElderLanguage(answers.elderLanguage);
      if (typeof answers.medicalConditions === 'string') setMedicalConditions(answers.medicalConditions);
      if (typeof answers.allergies === 'string') setAllergies(answers.allergies);
      if (typeof answers.notes === 'string') setNotes(answers.notes);
      if (typeof answers.deviceCode === 'string') setDeviceCode(answers.deviceCode);

      if (typeof answers.familyMembersJson === 'string' && answers.familyMembersJson) {
        try {
          const parsed = JSON.parse(answers.familyMembersJson) as FamilyMemberInput[];
          if (Array.isArray(parsed)) setFamilyMembers(parsed);
        } catch {
          // ignore malformed cached onboarding payload
        }
      } else {
        const mappedMembers = members
          .filter((item) => String(item.role ?? '') !== 'owner')
          .map((item, idx) => ({
            id: String(item.id ?? `family-${idx}`),
            name: String(item.displayName ?? item.email ?? item.phone ?? 'Member'),
            relation: 'Family',
            phone: String(item.phone ?? '')
          }));
        if (mappedMembers.length > 0) setFamilyMembers(mappedMembers);
      }

      if (typeof answers.medicinesJson === 'string' && answers.medicinesJson) {
        try {
          const parsed = JSON.parse(answers.medicinesJson) as MedicineInput[];
          if (Array.isArray(parsed)) setMedicines(parsed);
        } catch {
          // ignore malformed cached onboarding payload
        }
      } else {
        const mappedReminders = reminders.map((item, idx) => {
          const description = String(item.description ?? '');
          const dosagePrefix = 'Dosage: ';
          return {
            id: String(item.id ?? `med-${idx}`),
            name: String(item.title ?? 'Medicine'),
            dosage: description.startsWith(dosagePrefix) ? description.slice(dosagePrefix.length) : '',
            time: String(item.scheduledTime ?? 'Morning')
          };
        });
        if (mappedReminders.length > 0) setMedicines(mappedReminders);
      }
    } catch (error) {
      Alert.alert('Unable to load onboarding data', (error as Error).message);
    } finally {
      setLoadingInitial(false);
    }
  }, []);

  useEffect(() => {
    void loadOnboardingData();
  }, [loadOnboardingData]);

  const animateTransition = useCallback((direction: 'forward' | 'back', cb: () => void) => {
    const outX = direction === 'forward' ? -40 : 40;
    const inX = direction === 'forward' ? 40 : -40;
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 0, duration: 150, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: outX, duration: 150, useNativeDriver: true }),
    ]).start(() => {
      cb();
      slideAnim.setValue(inX);
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver: true }),
        Animated.timing(slideAnim, { toValue: 0, duration: 250, useNativeDriver: true }),
      ]).start();
    });
  }, [fadeAnim, slideAnim]);

  const goNext = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (step < TOTAL_STEPS - 1) {
      animateTransition('forward', () => setStep(step + 1));
    } else {
      void handleComplete();
    }
  };

  const goBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (step > 0) {
      animateTransition('back', () => setStep(step - 1));
    }
  };

  const handleSkip = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    goNext();
  };

  const handleComplete = async () => {
    if (!elderName.trim()) {
      Alert.alert('Missing elder name', "Please enter your elder's name before finishing setup.");
      setStep(0);
      return;
    }

    setSubmitting(true);
    try {
      const normalizedFamily = familyMembers
        .filter((member) => member.name.trim().length > 0)
        .map((member) => ({
          id: member.id,
          name: member.name.trim(),
          relation: member.relation.trim() || 'Family',
          phone: member.phone.trim()
        }));

      const normalizedMedicines = medicines
        .filter((med) => med.name.trim().length > 0)
        .map((med) => ({
          id: med.id,
          name: med.name.trim(),
          dosage: med.dosage.trim(),
          time: med.time.trim() || 'Morning'
        }));

      await upsertElderProfile({
        name: elderName.trim(),
        ageRange: elderAge.trim() || undefined,
        language: toLanguageCode(elderLanguage),
        city: elderCity.trim() || undefined,
        timezone: 'Asia/Kolkata'
      });

      const existingMembers = await getFamilyMembersRaw();
      const existingMemberKeys = new Set(
        existingMembers.map((item) => `${String(item.displayName ?? '').toLowerCase()}|${String(item.phone ?? '')}`)
      );
      for (const member of normalizedFamily) {
        const key = `${member.name.toLowerCase()}|${member.phone}`;
        if (existingMemberKeys.has(key)) continue;
        await inviteFamilyMember({
          displayName: member.name,
          phone: member.phone || undefined,
          role: 'member'
        });
      }

      const existingReminders = await getCareRemindersRaw();
      const existingReminderTitles = new Set(existingReminders.map((item) => String(item.title ?? '').toLowerCase()));
      for (const med of normalizedMedicines) {
        if (existingReminderTitles.has(med.name.toLowerCase())) continue;
        await createCareReminder({
          title: med.name,
          description: med.dosage ? `Dosage: ${med.dosage}` : undefined,
          scheduledTime: toReminderTime(med.time),
          enabled: true
        });
      }

      const serialNumber = deviceCode.trim().toUpperCase();
      if (serialNumber) {
        await linkElderDevice({ serialNumber });
      }

      await submitOnboardingAnswers({
        elderName: elderName.trim(),
        elderAge: elderAge.trim(),
        elderCity: elderCity.trim(),
        elderLanguage,
        medicalConditions: medicalConditions.trim(),
        allergies: allergies.trim(),
        notes: notes.trim(),
        deviceCode: serialNumber,
        familyMembersJson: JSON.stringify(normalizedFamily),
        medicinesJson: JSON.stringify(normalizedMedicines)
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/(tabs)/(home)');
    } catch (error) {
      Alert.alert('Setup incomplete', (error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const addFamilyMember = () => {
    if (!newMemberName.trim()) return;
    setFamilyMembers([...familyMembers, {
      id: Date.now().toString(),
      name: newMemberName.trim(),
      relation: newMemberRelation || 'Family',
      phone: newMemberPhone,
    }]);
    setNewMemberName('');
    setNewMemberRelation('');
    setNewMemberPhone('');
    setShowAddFamily(false);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const removeFamilyMember = (id: string) => {
    setFamilyMembers(familyMembers.filter(m => m.id !== id));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const addMedicine = () => {
    if (!newMedName.trim()) return;
    setMedicines([...medicines, {
      id: Date.now().toString(),
      name: newMedName.trim(),
      dosage: newMedDosage,
      time: newMedTime || 'Morning',
    }]);
    setNewMedName('');
    setNewMedDosage('');
    setNewMedTime('');
    setShowAddMedicine(false);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const removeMedicine = (id: string) => {
    setMedicines(medicines.filter(m => m.id !== id));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const progress = ((step + 1) / TOTAL_STEPS) * 100;
  const info = STEP_INFO[step];
  const IconComponent = info.icon;

  const renderStep0 = () => (
    <View style={styles.stepContent}>
      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Elder full name</Text>
        <TextInput
          style={styles.textInput}
          placeholder="e.g. Kamla Devi"
          placeholderTextColor={Colors.textTertiary}
          value={elderName}
          onChangeText={setElderName}
          autoFocus
        />
      </View>
      <View style={styles.hintCard}>
        <Heart size={16} color={Colors.peachDark} />
        <Text style={styles.hintText}>This is the person who will interact with the MITR device at home.</Text>
      </View>
    </View>
  );

  const renderStep1 = () => (
    <View style={styles.stepContent}>
      <View style={styles.rowInputs}>
        <View style={[styles.inputGroup, { flex: 1 }]}>
          <Text style={styles.inputLabel}>Age</Text>
          <TextInput
            style={styles.textInput}
            placeholder="74"
            placeholderTextColor={Colors.textTertiary}
            value={elderAge}
            onChangeText={setElderAge}
            keyboardType="number-pad"
            maxLength={3}
          />
        </View>
        <View style={[styles.inputGroup, { flex: 2 }]}>
          <Text style={styles.inputLabel}>City</Text>
          <TextInput
            style={styles.textInput}
            placeholder="Jaipur"
            placeholderTextColor={Colors.textTertiary}
            value={elderCity}
            onChangeText={setElderCity}
          />
        </View>
      </View>
      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Preferred language</Text>
        <View style={styles.chipRow}>
          {['Hindi', 'English', 'Tamil', 'Bengali', 'Marathi', 'Other'].map(lang => (
            <TouchableOpacity
              key={lang}
              style={[styles.chip, elderLanguage === lang && styles.chipSelected]}
              onPress={() => setElderLanguage(lang)}
              activeOpacity={0.7}
            >
              <Text style={[styles.chipText, elderLanguage === lang && styles.chipTextSelected]}>{lang}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </View>
  );

  const renderStep2 = () => (
    <View style={styles.stepContent}>
      {familyMembers.map(member => (
        <View key={member.id} style={styles.listItem}>
          <View style={styles.listItemAvatar}>
            <Text style={styles.listItemInitial}>{member.name.charAt(0)}</Text>
          </View>
          <View style={styles.listItemInfo}>
            <Text style={styles.listItemName}>{member.name}</Text>
            <Text style={styles.listItemMeta}>{member.relation}{member.phone ? ` · ${member.phone}` : ''}</Text>
          </View>
          <TouchableOpacity onPress={() => removeFamilyMember(member.id)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <X size={18} color={Colors.textTertiary} />
          </TouchableOpacity>
        </View>
      ))}

      {showAddFamily ? (
        <View style={styles.addForm}>
          <TextInput
            style={styles.textInput}
            placeholder="Name"
            placeholderTextColor={Colors.textTertiary}
            value={newMemberName}
            onChangeText={setNewMemberName}
            autoFocus
          />
          <View style={styles.chipRow}>
            {RELATIONS.map(rel => (
              <TouchableOpacity
                key={rel}
                style={[styles.chipSmall, newMemberRelation === rel && styles.chipSelected]}
                onPress={() => setNewMemberRelation(rel)}
                activeOpacity={0.7}
              >
                <Text style={[styles.chipSmallText, newMemberRelation === rel && styles.chipTextSelected]}>{rel}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TextInput
            style={styles.textInput}
            placeholder="Phone (optional)"
            placeholderTextColor={Colors.textTertiary}
            value={newMemberPhone}
            onChangeText={setNewMemberPhone}
            keyboardType="phone-pad"
          />
          <View style={styles.addFormActions}>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowAddFamily(false)} activeOpacity={0.7}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.addConfirmBtn, !newMemberName.trim() && styles.addConfirmBtnDisabled]}
              onPress={addFamilyMember}
              activeOpacity={0.8}
              disabled={!newMemberName.trim()}
            >
              <Check size={16} color={Colors.white} />
              <Text style={styles.addConfirmBtnText}>Add</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <TouchableOpacity style={styles.addButton} onPress={() => setShowAddFamily(true)} activeOpacity={0.7}>
          <Plus size={18} color={Colors.skyDark} />
          <Text style={styles.addButtonText}>Add family member</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  const renderStep3 = () => (
    <View style={styles.stepContent}>
      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Medical conditions</Text>
        <TextInput
          style={[styles.textInput, styles.textArea]}
          placeholder="e.g. Diabetes Type 2, Hypertension"
          placeholderTextColor={Colors.textTertiary}
          value={medicalConditions}
          onChangeText={setMedicalConditions}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
        />
      </View>
      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Allergies</Text>
        <TextInput
          style={styles.textInput}
          placeholder="e.g. Penicillin, peanuts"
          placeholderTextColor={Colors.textTertiary}
          value={allergies}
          onChangeText={setAllergies}
        />
      </View>
      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Additional notes</Text>
        <TextInput
          style={[styles.textInput, styles.textArea]}
          placeholder="Anything else the care team should know"
          placeholderTextColor={Colors.textTertiary}
          value={notes}
          onChangeText={setNotes}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
        />
      </View>
    </View>
  );

  const renderStep4 = () => (
    <View style={styles.stepContent}>
      {medicines.map(med => (
        <View key={med.id} style={styles.listItem}>
          <View style={[styles.listItemAvatar, { backgroundColor: Colors.lavenderLight }]}>
            <Pill size={16} color={Colors.lavenderDark} />
          </View>
          <View style={styles.listItemInfo}>
            <Text style={styles.listItemName}>{med.name}</Text>
            <Text style={styles.listItemMeta}>{med.dosage ? `${med.dosage} · ` : ''}{med.time}</Text>
          </View>
          <TouchableOpacity onPress={() => removeMedicine(med.id)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <X size={18} color={Colors.textTertiary} />
          </TouchableOpacity>
        </View>
      ))}

      {showAddMedicine ? (
        <View style={styles.addForm}>
          <TextInput
            style={styles.textInput}
            placeholder="Medicine name"
            placeholderTextColor={Colors.textTertiary}
            value={newMedName}
            onChangeText={setNewMedName}
            autoFocus
          />
          <TextInput
            style={styles.textInput}
            placeholder="Dosage (e.g. 500mg, 1 tablet)"
            placeholderTextColor={Colors.textTertiary}
            value={newMedDosage}
            onChangeText={setNewMedDosage}
          />
          <View style={styles.chipRow}>
            {TIMES.map(time => (
              <TouchableOpacity
                key={time}
                style={[styles.chipSmall, newMedTime === time && styles.chipSelected]}
                onPress={() => setNewMedTime(time)}
                activeOpacity={0.7}
              >
                <Text style={[styles.chipSmallText, newMedTime === time && styles.chipTextSelected]}>{time}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.addFormActions}>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowAddMedicine(false)} activeOpacity={0.7}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.addConfirmBtn, !newMedName.trim() && styles.addConfirmBtnDisabled]}
              onPress={addMedicine}
              activeOpacity={0.8}
              disabled={!newMedName.trim()}
            >
              <Check size={16} color={Colors.white} />
              <Text style={styles.addConfirmBtnText}>Add</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <TouchableOpacity style={styles.addButton} onPress={() => setShowAddMedicine(true)} activeOpacity={0.7}>
          <Plus size={18} color={Colors.lavenderDark} />
          <Text style={[styles.addButtonText, { color: Colors.lavenderDark }]}>Add medicine</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  const renderStep5 = () => (
    <View style={styles.stepContent}>
      <View style={styles.deviceIllustration}>
        <View style={styles.deviceCircle}>
          <Wifi size={40} color={Colors.mintDark} />
        </View>
      </View>
      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Device code or serial number</Text>
        <TextInput
          style={[styles.textInput, styles.codeInput]}
          placeholder="MITR-XXXX-XX-XXXX"
          placeholderTextColor={Colors.textTertiary}
          value={deviceCode}
          onChangeText={setDeviceCode}
          autoCapitalize="characters"
        />
      </View>
      <Text style={styles.deviceHint}>
        Find this on the bottom of your MITR device or in the quick start guide.
      </Text>
      <TouchableOpacity style={styles.qrBtn} activeOpacity={0.7} onPress={() => Alert.alert('QR Scanner', 'Camera-based QR scanning will be available soon.')}>
        <Text style={styles.qrBtnText}>Scan QR code instead</Text>
      </TouchableOpacity>
    </View>
  );

  const STEP_RENDERERS = [renderStep0, renderStep1, renderStep2, renderStep3, renderStep4, renderStep5];

  if (loadingInitial) {
    return (
      <View style={styles.root}>
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={Colors.mintDark} />
            <Text style={styles.loadingText}>Loading your onboarding details...</Text>
          </View>
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.bgDecor}>
        <View style={[styles.bgBlob, { backgroundColor: info.color, top: -80, right: -60 }]} />
        <View style={[styles.bgBlob, { backgroundColor: Colors.peachLight, top: 60, left: -50, opacity: 0.3 }]} />
      </View>
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.topBar}>
            {step > 0 ? (
              <TouchableOpacity style={styles.backBtn} onPress={goBack} activeOpacity={0.7}>
                <ArrowLeft size={20} color={Colors.text} />
              </TouchableOpacity>
            ) : <View style={styles.backBtn} />}
            <View style={styles.progressContainer}>
              <View style={styles.progressTrack}>
                <Animated.View style={[styles.progressFill, { width: `${progress}%` }]} />
              </View>
              <Text style={styles.stepCounter}>{step + 1} of {TOTAL_STEPS}</Text>
            </View>
            <TouchableOpacity onPress={handleSkip} activeOpacity={0.7} style={styles.skipBtn} disabled={submitting}>
              <Text style={styles.skipText}>{submitting ? '...' : 'Skip'}</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            <Animated.View style={[styles.stepHeader, { opacity: fadeAnim, transform: [{ translateX: slideAnim }] }]}>
              <View style={[styles.stepIcon, { backgroundColor: info.color }]}>
                <IconComponent size={28} color={info.iconColor} />
              </View>
              <Text style={styles.stepTitle}>{info.title}</Text>
              <Text style={styles.stepDesc}>{info.desc}</Text>
            </Animated.View>

            <Animated.View style={{ opacity: fadeAnim, transform: [{ translateX: slideAnim }] }}>
              {STEP_RENDERERS[step]()}
            </Animated.View>
          </ScrollView>

          <View style={styles.bottomBar}>
            <TouchableOpacity
              style={[styles.continueBtn, submitting && styles.continueBtnDisabled]}
              onPress={goNext}
              activeOpacity={0.8}
              disabled={submitting}
            >
              <Text style={styles.continueBtnText}>
                {submitting ? 'Saving...' : step === TOTAL_STEPS - 1 ? 'Finish setup' : 'Continue'}
              </Text>
              <ArrowRight size={18} color={Colors.white} />
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  flex: {
    flex: 1,
  },
  bgDecor: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 300,
    overflow: 'hidden',
  },
  bgBlob: {
    position: 'absolute',
    width: 220,
    height: 220,
    borderRadius: 110,
    opacity: 0.5,
  },
  safeArea: {
    flex: 1,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 12,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressContainer: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  progressTrack: {
    width: '100%',
    height: 4,
    backgroundColor: Colors.borderLight,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: Colors.mintDark,
    borderRadius: 2,
  },
  stepCounter: {
    fontSize: 11,
    color: Colors.textTertiary,
    fontWeight: '500' as const,
  },
  skipBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  skipText: {
    fontSize: 14,
    color: Colors.textSecondary,
    fontWeight: '500' as const,
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingBottom: 20,
  },
  stepHeader: {
    alignItems: 'center',
    marginBottom: 28,
    marginTop: 8,
  },
  stepIcon: {
    width: 64,
    height: 64,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  stepTitle: {
    fontSize: 24,
    fontWeight: '700' as const,
    color: Colors.text,
    letterSpacing: -0.3,
    marginBottom: 6,
  },
  stepDesc: {
    fontSize: 15,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  stepContent: {
    gap: 14,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
    color: Colors.textSecondary,
  },
  inputGroup: {
    gap: 6,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '600' as const,
    color: Colors.textSecondary,
    marginLeft: 4,
  },
  textInput: {
    backgroundColor: Colors.white,
    borderRadius: 16,
    paddingHorizontal: 18,
    fontSize: 16,
    color: Colors.text,
    height: 52,
  },
  textArea: {
    height: 90,
    paddingTop: 14,
    paddingBottom: 14,
  },
  codeInput: {
    fontSize: 18,
    fontWeight: '600' as const,
    letterSpacing: 1,
    textAlign: 'center',
  },
  rowInputs: {
    flexDirection: 'row',
    gap: 12,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: Colors.white,
  },
  chipSelected: {
    backgroundColor: Colors.text,
  },
  chipText: {
    fontSize: 14,
    fontWeight: '500' as const,
    color: Colors.textSecondary,
  },
  chipTextSelected: {
    color: Colors.white,
  },
  chipSmall: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: Colors.white,
  },
  chipSmallText: {
    fontSize: 13,
    fontWeight: '500' as const,
    color: Colors.textSecondary,
  },
  hintCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Colors.peachLight,
    borderRadius: 14,
    padding: 14,
    marginTop: 4,
  },
  hintText: {
    flex: 1,
    fontSize: 13,
    color: Colors.peachDark,
    lineHeight: 18,
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    borderRadius: 16,
    padding: 14,
    gap: 12,
  },
  listItemAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.skyLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listItemInitial: {
    fontSize: 16,
    fontWeight: '700' as const,
    color: Colors.skyDark,
  },
  listItemInfo: {
    flex: 1,
  },
  listItemName: {
    fontSize: 15,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  listItemMeta: {
    fontSize: 12,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  addForm: {
    backgroundColor: Colors.white,
    borderRadius: 18,
    padding: 16,
    gap: 12,
  },
  addFormActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 4,
  },
  cancelBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 12,
  },
  cancelBtnText: {
    fontSize: 14,
    color: Colors.textSecondary,
    fontWeight: '500' as const,
  },
  addConfirmBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.text,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 12,
  },
  addConfirmBtnDisabled: {
    opacity: 0.4,
  },
  addConfirmBtnText: {
    fontSize: 14,
    color: Colors.white,
    fontWeight: '600' as const,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.white,
    borderRadius: 16,
    paddingVertical: 14,
    borderWidth: 1.5,
    borderColor: Colors.borderLight,
    borderStyle: 'dashed',
  },
  addButtonText: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: Colors.skyDark,
  },
  deviceIllustration: {
    alignItems: 'center',
    marginBottom: 8,
  },
  deviceCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: Colors.mintLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deviceHint: {
    fontSize: 13,
    color: Colors.textTertiary,
    textAlign: 'center',
    lineHeight: 18,
    marginTop: 4,
  },
  qrBtn: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  qrBtnText: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: Colors.skyDark,
    textDecorationLine: 'underline',
  },
  bottomBar: {
    paddingHorizontal: 24,
    paddingBottom: 8,
    paddingTop: 12,
  },
  continueBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: Colors.text,
    borderRadius: 18,
    paddingVertical: 18,
  },
  continueBtnDisabled: {
    opacity: 0.6,
  },
  continueBtnText: {
    color: Colors.white,
    fontSize: 16,
    fontWeight: '600' as const,
  },
});
