import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Animated,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ArrowLeft, Phone, Mail, ArrowRight, Eye, EyeOff } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import Colors from '@/constants/colors';
import {
  getOnboardingStatus,
  loginWithEmailSession,
  signupWithEmailSession,
  startOtpChallenge,
  verifyOtpChallenge
} from '@/lib/api';

type AuthMode = 'choose' | 'phone' | 'email-login' | 'email-signup' | 'otp';

export default function SignupScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>('choose');
  const [phone, setPhone] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [otp, setOtp] = useState<string>('');
  const [challengeId, setChallengeId] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;

  useEffect(() => {
    animateIn();
  }, [mode]);

  const animateIn = () => {
    fadeAnim.setValue(0);
    slideAnim.setValue(30);
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 350, useNativeDriver: true }),
    ]).start();
  };

  const handleBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (mode === 'choose') {
      router.back();
    } else if (mode === 'otp') {
      setMode('phone');
    } else {
      setMode('choose');
    }
  };

  const handlePhoneContinue = async () => {
    if (phone.length < 10) {
      Alert.alert('Invalid number', 'Please enter a valid phone number.');
      return;
    }
    setBusy(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const result = await startOtpChallenge(phone);
      setChallengeId(result.challengeId);
      if (result.devOtpCode) {
        setOtp(result.devOtpCode);
      }
      setMode('otp');
    } catch (error) {
      Alert.alert('Unable to send code', (error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleOtpVerify = async () => {
    if (!challengeId) {
      Alert.alert('Verification missing', 'Please request a new OTP code.');
      return;
    }
    if (otp.length < 6) {
      Alert.alert('Invalid OTP', 'Please enter the 6-digit code sent to your phone.');
      return;
    }
    setBusy(true);
    try {
      await verifyOtpChallenge({ challengeId, code: otp, name: name.trim() || undefined });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/onboarding' as never);
    } catch (error) {
      Alert.alert('OTP verification failed', (error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleEmailLogin = async () => {
    if (!email.includes('@') || password.length < 6) {
      Alert.alert('Invalid details', 'Please check your email and password.');
      return;
    }
    setBusy(true);
    try {
      await loginWithEmailSession(email.trim().toLowerCase(), password);
      const status = await getOnboardingStatus();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace((status.completed ? '/(tabs)/(home)' : '/onboarding') as never);
    } catch (error) {
      Alert.alert('Sign in failed', (error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleEmailSignup = async () => {
    if (!name.trim() || !email.includes('@') || password.length < 6) {
      Alert.alert('Missing info', 'Please fill in all fields correctly.');
      return;
    }
    setBusy(true);
    try {
      await signupWithEmailSession({
        email: email.trim().toLowerCase(),
        password,
        name: name.trim()
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/onboarding' as never);
    } catch (error) {
      Alert.alert('Sign up failed', (error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const renderChoose = () => (
    <Animated.View style={[styles.formContainer, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
      <Text style={styles.heading}>Welcome to MITR</Text>
      <Text style={styles.subtitle}>Choose how you would like to continue</Text>

      <TouchableOpacity style={styles.authOptionCard} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setMode('phone'); }} activeOpacity={0.7}>
        <View style={[styles.authOptionIcon, { backgroundColor: Colors.mintLight }]}>
          <Phone size={22} color={Colors.mintDark} />
        </View>
        <View style={styles.authOptionText}>
          <Text style={styles.authOptionTitle}>Continue with Phone</Text>
          <Text style={styles.authOptionDesc}>We will send you a verification code</Text>
        </View>
        <ArrowRight size={18} color={Colors.textTertiary} />
      </TouchableOpacity>

      <TouchableOpacity style={styles.authOptionCard} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setMode('email-signup'); }} activeOpacity={0.7}>
        <View style={[styles.authOptionIcon, { backgroundColor: Colors.lavenderLight }]}>
          <Mail size={22} color={Colors.lavenderDark} />
        </View>
        <View style={styles.authOptionText}>
          <Text style={styles.authOptionTitle}>Sign up with Email</Text>
          <Text style={styles.authOptionDesc}>Create a new account</Text>
        </View>
        <ArrowRight size={18} color={Colors.textTertiary} />
      </TouchableOpacity>

      <TouchableOpacity style={styles.loginLink} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setMode('email-login'); }} activeOpacity={0.7}>
        <Text style={styles.loginLinkText}>Already have an account? <Text style={styles.loginLinkBold}>Sign in</Text></Text>
      </TouchableOpacity>
    </Animated.View>
  );

  const renderPhone = () => (
    <Animated.View style={[styles.formContainer, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
      <Text style={styles.heading}>Your phone number</Text>
      <Text style={styles.subtitle}>We will send a 6-digit code to verify</Text>

      <View style={styles.inputRow}>
        <View style={styles.countryCode}>
          <Text style={styles.countryCodeText}>+91</Text>
        </View>
        <TextInput
          style={styles.phoneInput}
          placeholder="98765 43210"
          placeholderTextColor={Colors.textTertiary}
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          maxLength={10}
          autoFocus
        />
      </View>

      <TouchableOpacity
        style={[styles.primaryBtn, phone.length < 10 && styles.primaryBtnDisabled]}
        onPress={handlePhoneContinue}
        activeOpacity={0.8}
        disabled={phone.length < 10 || busy}
      >
        <Text style={styles.primaryBtnText}>{busy ? 'Sending...' : 'Send code'}</Text>
        <ArrowRight size={18} color={Colors.white} />
      </TouchableOpacity>
    </Animated.View>
  );

  const renderOtp = () => (
    <Animated.View style={[styles.formContainer, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
      <Text style={styles.heading}>Enter verification code</Text>
      <Text style={styles.subtitle}>Sent to +91 {phone}</Text>

      <TextInput
        style={styles.otpInput}
        placeholder="000000"
        placeholderTextColor={Colors.textTertiary}
        value={otp}
        onChangeText={setOtp}
        keyboardType="number-pad"
        maxLength={6}
        autoFocus
        textAlign="center"
      />

      <TouchableOpacity
        style={[styles.primaryBtn, (otp.length < 6 || busy) && styles.primaryBtnDisabled]}
        onPress={handleOtpVerify}
        activeOpacity={0.8}
        disabled={otp.length < 6 || busy}
      >
        <Text style={styles.primaryBtnText}>{busy ? 'Verifying...' : 'Verify & continue'}</Text>
        <ArrowRight size={18} color={Colors.white} />
      </TouchableOpacity>

      <TouchableOpacity style={styles.resendLink} activeOpacity={0.7}>
        <Text style={styles.resendText}>Did not receive it? <Text style={styles.loginLinkBold}>Resend</Text></Text>
      </TouchableOpacity>
    </Animated.View>
  );

  const renderEmailLogin = () => (
    <Animated.View style={[styles.formContainer, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
      <Text style={styles.heading}>Welcome back</Text>
      <Text style={styles.subtitle}>Sign in to your account</Text>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Email</Text>
        <TextInput
          style={styles.textInput}
          placeholder="you@example.com"
          placeholderTextColor={Colors.textTertiary}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoFocus
        />
      </View>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Password</Text>
        <View style={styles.passwordRow}>
          <TextInput
            style={[styles.textInput, styles.passwordInput]}
            placeholder="Your password"
            placeholderTextColor={Colors.textTertiary}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
          />
          <TouchableOpacity style={styles.eyeBtn} onPress={() => setShowPassword(!showPassword)}>
            {showPassword ? <EyeOff size={18} color={Colors.textTertiary} /> : <Eye size={18} color={Colors.textTertiary} />}
          </TouchableOpacity>
        </View>
      </View>

      <TouchableOpacity style={styles.primaryBtn} onPress={handleEmailLogin} activeOpacity={0.8} disabled={busy}>
        <Text style={styles.primaryBtnText}>{busy ? 'Signing in...' : 'Sign in'}</Text>
        <ArrowRight size={18} color={Colors.white} />
      </TouchableOpacity>

      <TouchableOpacity style={styles.loginLink} onPress={() => setMode('email-signup')} activeOpacity={0.7}>
        <Text style={styles.loginLinkText}>New here? <Text style={styles.loginLinkBold}>Create account</Text></Text>
      </TouchableOpacity>
    </Animated.View>
  );

  const renderEmailSignup = () => (
    <Animated.View style={[styles.formContainer, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
      <Text style={styles.heading}>Create your account</Text>
      <Text style={styles.subtitle}>Let us get you started</Text>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Your name</Text>
        <TextInput
          style={styles.textInput}
          placeholder="Priya Sharma"
          placeholderTextColor={Colors.textTertiary}
          value={name}
          onChangeText={setName}
          autoFocus
        />
      </View>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Email</Text>
        <TextInput
          style={styles.textInput}
          placeholder="you@example.com"
          placeholderTextColor={Colors.textTertiary}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />
      </View>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Password</Text>
        <View style={styles.passwordRow}>
          <TextInput
            style={[styles.textInput, styles.passwordInput]}
            placeholder="Min 6 characters"
            placeholderTextColor={Colors.textTertiary}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
          />
          <TouchableOpacity style={styles.eyeBtn} onPress={() => setShowPassword(!showPassword)}>
            {showPassword ? <EyeOff size={18} color={Colors.textTertiary} /> : <Eye size={18} color={Colors.textTertiary} />}
          </TouchableOpacity>
        </View>
      </View>

      <TouchableOpacity style={styles.primaryBtn} onPress={handleEmailSignup} activeOpacity={0.8} disabled={busy}>
        <Text style={styles.primaryBtnText}>{busy ? 'Creating...' : 'Create account'}</Text>
        <ArrowRight size={18} color={Colors.white} />
      </TouchableOpacity>

      <TouchableOpacity style={styles.loginLink} onPress={() => setMode('email-login')} activeOpacity={0.7}>
        <Text style={styles.loginLinkText}>Already a member? <Text style={styles.loginLinkBold}>Sign in</Text></Text>
      </TouchableOpacity>
    </Animated.View>
  );

  return (
    <View style={styles.root}>
      <View style={styles.bgDecor}>
        <View style={[styles.blob, styles.blob1]} />
        <View style={[styles.blob, styles.blob2]} />
      </View>
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <TouchableOpacity style={styles.backBtn} onPress={handleBack} activeOpacity={0.7}>
            <ArrowLeft size={22} color={Colors.text} />
          </TouchableOpacity>

          <View style={styles.content}>
            {mode === 'choose' && renderChoose()}
            {mode === 'phone' && renderPhone()}
            {mode === 'otp' && renderOtp()}
            {mode === 'email-login' && renderEmailLogin()}
            {mode === 'email-signup' && renderEmailSignup()}
          </View>

          <Text style={styles.legalText}>
            By continuing, you agree to our Terms of Service and Privacy Policy.
          </Text>
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
    height: 350,
    overflow: 'hidden',
  },
  blob: {
    position: 'absolute',
    borderRadius: 999,
  },
  blob1: {
    width: 200,
    height: 200,
    backgroundColor: Colors.peachLight,
    top: -50,
    right: -30,
    opacity: 0.5,
  },
  blob2: {
    width: 160,
    height: 160,
    backgroundColor: Colors.mintLight,
    top: 80,
    left: -40,
    opacity: 0.4,
  },
  safeArea: {
    flex: 1,
  },
  backBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 20,
    marginTop: 8,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  formContainer: {
    gap: 16,
  },
  heading: {
    fontSize: 28,
    fontWeight: '700' as const,
    color: Colors.text,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 15,
    color: Colors.textSecondary,
    lineHeight: 22,
    marginBottom: 8,
  },
  authOptionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    borderRadius: 18,
    padding: 18,
    gap: 14,
  },
  authOptionIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  authOptionText: {
    flex: 1,
  },
  authOptionTitle: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  authOptionDesc: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  loginLink: {
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: 4,
  },
  loginLinkText: {
    fontSize: 14,
    color: Colors.textSecondary,
  },
  loginLinkBold: {
    fontWeight: '600' as const,
    color: Colors.text,
  },
  inputRow: {
    flexDirection: 'row',
    gap: 10,
  },
  countryCode: {
    backgroundColor: Colors.white,
    borderRadius: 16,
    paddingHorizontal: 18,
    justifyContent: 'center',
    height: 56,
  },
  countryCodeText: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  phoneInput: {
    flex: 1,
    backgroundColor: Colors.white,
    borderRadius: 16,
    paddingHorizontal: 18,
    fontSize: 18,
    fontWeight: '500' as const,
    color: Colors.text,
    height: 56,
    letterSpacing: 1,
  },
  otpInput: {
    backgroundColor: Colors.white,
    borderRadius: 16,
    paddingHorizontal: 18,
    fontSize: 32,
    fontWeight: '700' as const,
    color: Colors.text,
    height: 64,
    letterSpacing: 12,
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
  passwordRow: {
    position: 'relative',
  },
  passwordInput: {
    paddingRight: 50,
  },
  eyeBtn: {
    position: 'absolute',
    right: 16,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: Colors.text,
    borderRadius: 18,
    paddingVertical: 18,
    marginTop: 8,
  },
  primaryBtnDisabled: {
    opacity: 0.4,
  },
  primaryBtnText: {
    color: Colors.white,
    fontSize: 16,
    fontWeight: '600' as const,
  },
  resendLink: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  resendText: {
    fontSize: 14,
    color: Colors.textSecondary,
  },
  legalText: {
    fontSize: 12,
    color: Colors.textTertiary,
    textAlign: 'center',
    paddingHorizontal: 40,
    paddingBottom: 16,
    lineHeight: 18,
  },
});
