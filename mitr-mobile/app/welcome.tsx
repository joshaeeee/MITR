import React, { useRef, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Dimensions,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Heart, ArrowRight, Sun, Cloud, Star, Flower2, Shield, Users } from 'lucide-react-native';
import Colors from '@/constants/colors';
import { loginWithEmailSession } from '@/lib/api';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export default function WelcomeScreen() {
  const router = useRouter();
  const [skipBusy, setSkipBusy] = useState(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(40)).current;
  const logoScale = useRef(new Animated.Value(0.5)).current;
  const floatAnim1 = useRef(new Animated.Value(0)).current;
  const floatAnim2 = useRef(new Animated.Value(0)).current;
  const floatAnim3 = useRef(new Animated.Value(0)).current;
  const sparkle1 = useRef(new Animated.Value(0.3)).current;
  const sparkle2 = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.spring(logoScale, {
        toValue: 1,
        friction: 5,
        useNativeDriver: true,
      }),
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 600,
          useNativeDriver: true,
        }),
      ]),
    ]).start();

    Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim1, { toValue: -12, duration: 2200, useNativeDriver: true }),
        Animated.timing(floatAnim1, { toValue: 0, duration: 2200, useNativeDriver: true }),
      ])
    ).start();
    Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim2, { toValue: 10, duration: 2800, useNativeDriver: true }),
        Animated.timing(floatAnim2, { toValue: 0, duration: 2800, useNativeDriver: true }),
      ])
    ).start();
    Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim3, { toValue: -8, duration: 3000, useNativeDriver: true }),
        Animated.timing(floatAnim3, { toValue: 8, duration: 3000, useNativeDriver: true }),
      ])
    ).start();
    Animated.loop(
      Animated.sequence([
        Animated.timing(sparkle1, { toValue: 1, duration: 1500, useNativeDriver: true }),
        Animated.timing(sparkle1, { toValue: 0.3, duration: 1500, useNativeDriver: true }),
      ])
    ).start();
    Animated.loop(
      Animated.sequence([
        Animated.timing(sparkle2, { toValue: 1, duration: 2000, useNativeDriver: true }),
        Animated.timing(sparkle2, { toValue: 0.4, duration: 2000, useNativeDriver: true }),
      ])
    ).start();
  }, []);

  const handleSkipToProduct = async () => {
    if (skipBusy) return;
    setSkipBusy(true);
    try {
      await loginWithEmailSession('tester@gmail.com', '12345678910');
      router.replace('/(tabs)/(home)' as never);
    } catch (error) {
      Alert.alert('Skip failed', (error as Error).message);
    } finally {
      setSkipBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <View style={styles.topDecoration}>
        <View style={[styles.blob, styles.blob1]} />
        <View style={[styles.blob, styles.blob2]} />
        <View style={[styles.blob, styles.blob3]} />
        <View style={[styles.blob, styles.blob4]} />
      </View>

      <Animated.View style={[styles.floatingIcon, styles.floatSun, { transform: [{ translateY: floatAnim1 }] }]}>
        <View style={styles.iconBubblePeach}>
          <Sun size={22} color={Colors.peachDark} />
        </View>
      </Animated.View>
      <Animated.View style={[styles.floatingIcon, styles.floatCloud, { transform: [{ translateY: floatAnim2 }] }]}>
        <View style={styles.iconBubbleSky}>
          <Cloud size={20} color={Colors.skyDark} />
        </View>
      </Animated.View>
      <Animated.View style={[styles.floatingIcon, styles.floatFlower, { transform: [{ translateY: floatAnim3 }] }]}>
        <View style={styles.iconBubbleMint}>
          <Flower2 size={18} color={Colors.mintDark} />
        </View>
      </Animated.View>
      <Animated.View style={[styles.floatingIcon, styles.floatStar1, { opacity: sparkle1 }]}>
        <Star size={12} color={Colors.lavenderDark} fill={Colors.lavenderLight} />
      </Animated.View>
      <Animated.View style={[styles.floatingIcon, styles.floatStar2, { opacity: sparkle2 }]}>
        <Star size={10} color={Colors.peachDark} fill={Colors.peachLight} />
      </Animated.View>
      <Animated.View style={[styles.floatingIcon, styles.floatStar3, { opacity: sparkle1 }]}>
        <Star size={8} color={Colors.mintDark} fill={Colors.mintLight} />
      </Animated.View>

      <SafeAreaView style={styles.safeArea}>
        <View style={styles.content}>
          <Animated.View style={[styles.illustrationArea, { transform: [{ scale: logoScale }] }]}>
            <View style={styles.illuOuterRing}>
              <View style={styles.illuMiddleRing}>
                <View style={styles.logoCircle}>
                  <Heart size={42} color={Colors.peachDark} fill={Colors.peachLight} />
                </View>
              </View>
            </View>
            <View style={styles.illuOrbit1}>
              <View style={styles.orbitDotMint}>
                <Shield size={14} color={Colors.mintDark} />
              </View>
            </View>
            <View style={styles.illuOrbit2}>
              <View style={styles.orbitDotLavender}>
                <Users size={14} color={Colors.lavenderDark} />
              </View>
            </View>
            <View style={styles.illuOrbit3}>
              <View style={styles.orbitDotSky}>
                <Heart size={12} color={Colors.peachDark} fill={Colors.peachLight} />
              </View>
            </View>
          </Animated.View>

          <Animated.View
            style={[styles.textContainer, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}
          >
            <Text style={styles.brand}>MITR Family</Text>
            <Text style={styles.tagline}>
              {'Gentle care,\nalways connected.'}
            </Text>
            <Text style={styles.description}>
              Stay close to your loved ones with a calm, reassuring companion.
              Know they are well, every day.
            </Text>
          </Animated.View>

          <Animated.View
            style={[styles.actions, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}
          >
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={() => router.push('/signup' as never)}
              activeOpacity={0.8}
            >
              <Text style={styles.primaryBtnText}>Get started</Text>
              <ArrowRight size={20} color={Colors.white} />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={() => router.push('/signup' as never)}
              activeOpacity={0.7}
            >
              <Text style={styles.secondaryBtnText}>I already have an account</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.skipBtn}
              onPress={handleSkipToProduct}
              activeOpacity={0.7}
              disabled={skipBusy}
            >
              <Text style={styles.skipBtnText}>
                {skipBusy ? 'Skipping...' : 'Skip for now (tester account)'}
              </Text>
            </TouchableOpacity>
          </Animated.View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  topDecoration: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 500,
    overflow: 'hidden',
  },
  blob: {
    position: 'absolute',
    borderRadius: 999,
  },
  blob1: {
    width: 260,
    height: 260,
    backgroundColor: Colors.mintLight,
    top: -80,
    right: -50,
    opacity: 0.55,
  },
  blob2: {
    width: 200,
    height: 200,
    backgroundColor: Colors.lavenderLight,
    top: 30,
    left: -50,
    opacity: 0.5,
  },
  blob3: {
    width: 140,
    height: 140,
    backgroundColor: Colors.peachLight,
    top: 180,
    right: 40,
    opacity: 0.45,
  },
  blob4: {
    width: 100,
    height: 100,
    backgroundColor: Colors.skyLight,
    top: 300,
    left: 40,
    opacity: 0.35,
  },
  floatingIcon: {
    position: 'absolute',
    zIndex: 5,
  },
  floatSun: {
    top: 100,
    right: 30,
  },
  floatCloud: {
    top: 160,
    left: 24,
  },
  floatFlower: {
    top: 280,
    right: 50,
  },
  floatStar1: {
    top: 130,
    left: SCREEN_WIDTH * 0.45,
  },
  floatStar2: {
    top: 220,
    left: 60,
  },
  floatStar3: {
    top: 310,
    right: 100,
  },
  iconBubblePeach: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.peachLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBubbleSky: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.skyLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBubbleMint: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: Colors.mintLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  safeArea: {
    flex: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: 30,
    justifyContent: 'center',
  },
  illustrationArea: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 36,
    height: 160,
    width: 160,
    alignSelf: 'center',
  },
  illuOuterRing: {
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 1.5,
    borderColor: Colors.mintLight,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  illuMiddleRing: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: 'rgba(248, 232, 224, 0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Colors.peachLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  illuOrbit1: {
    position: 'absolute',
    top: 4,
    right: 10,
  },
  illuOrbit2: {
    position: 'absolute',
    bottom: 10,
    left: 2,
  },
  illuOrbit3: {
    position: 'absolute',
    top: 50,
    left: -2,
  },
  orbitDotMint: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: Colors.mintLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orbitDotLavender: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: Colors.lavenderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orbitDotSky: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.peachLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textContainer: {
    marginBottom: 44,
  },
  brand: {
    fontSize: 14,
    fontWeight: '700' as const,
    color: Colors.textTertiary,
    letterSpacing: 2.5,
    textTransform: 'uppercase' as const,
    marginBottom: 10,
  },
  tagline: {
    fontSize: 34,
    fontWeight: '700' as const,
    color: Colors.text,
    letterSpacing: -0.8,
    lineHeight: 40,
    marginBottom: 14,
  },
  description: {
    fontSize: 15,
    color: Colors.textSecondary,
    lineHeight: 23,
  },
  actions: {
    gap: 12,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: Colors.text,
    borderRadius: 18,
    paddingVertical: 18,
  },
  primaryBtnText: {
    color: Colors.white,
    fontSize: 17,
    fontWeight: '600' as const,
  },
  secondaryBtn: {
    alignItems: 'center',
    paddingVertical: 14,
  },
  secondaryBtnText: {
    color: Colors.textSecondary,
    fontSize: 15,
    fontWeight: '500' as const,
  },
  skipBtn: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  skipBtnText: {
    color: Colors.textTertiary,
    fontSize: 13,
    fontWeight: '500' as const,
  },
});
