import React, { useRef } from 'react';
import { TouchableOpacity, Text, StyleSheet, Animated } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/contexts/ThemeContext';

interface QuickActionProps {
  icon: React.ReactNode;
  label: string;
  color: 'mint' | 'lavender' | 'peach' | 'sky';
  onPress: () => void;
}

export default function QuickAction({ icon, label, color, onPress }: QuickActionProps) {
  const colors = useColors();
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const bgColors = {
    mint: colors.mintLight,
    lavender: colors.lavenderLight,
    peach: colors.peachLight,
    sky: colors.skyLight,
  };

  const accentColors = {
    mint: colors.mintDark,
    lavender: colors.lavenderDark,
    peach: colors.peachDark,
    sky: colors.skyDark,
  };

  const handlePressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.93,
      useNativeDriver: true,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      friction: 3,
      useNativeDriver: true,
    }).start();
  };

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress();
  };

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        style={[styles.container, { backgroundColor: bgColors[color] }]}
        onPress={handlePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        activeOpacity={1}
      >
        {icon}
        <Text style={[styles.label, { color: accentColors[color] }]}>{label}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    padding: 14,
    width: 78,
    height: 78,
    gap: 6,
  },
  label: {
    fontSize: 10,
    fontWeight: '600' as const,
    textAlign: 'center',
  },
});
