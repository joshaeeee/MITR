import React from 'react';
import { View, TouchableOpacity, StyleSheet, ViewStyle } from 'react-native';
import { useColors } from '@/contexts/ThemeContext';

interface PastelCardProps {
  children: React.ReactNode;
  color?: 'mint' | 'lavender' | 'peach' | 'sky' | 'white';
  onPress?: () => void;
  style?: ViewStyle;
  padded?: boolean;
}

export default function PastelCard({ children, color = 'white', onPress, style, padded = true }: PastelCardProps) {
  const colors = useColors();
  const bgColors = {
    mint: colors.mintLight,
    lavender: colors.lavenderLight,
    peach: colors.peachLight,
    sky: colors.skyLight,
    white: colors.surface,
  };
  const Wrapper = onPress ? TouchableOpacity : View;
  return (
    <Wrapper
      onPress={onPress}
      activeOpacity={0.8}
      style={[
        styles.card,
        { backgroundColor: bgColors[color] },
        padded && styles.padded,
        style,
      ]}
    >
      {children}
    </Wrapper>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 20,
    overflow: 'hidden',
  },
  padded: {
    padding: 18,
  },
});
