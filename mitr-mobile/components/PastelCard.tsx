import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ViewStyle } from 'react-native';
import Colors from '@/constants/colors';

interface PastelCardProps {
  children: React.ReactNode;
  color?: 'mint' | 'lavender' | 'peach' | 'sky' | 'white';
  onPress?: () => void;
  style?: ViewStyle;
  padded?: boolean;
}

const bgColors = {
  mint: Colors.mintLight,
  lavender: Colors.lavenderLight,
  peach: Colors.peachLight,
  sky: Colors.skyLight,
  white: Colors.white,
};

export default function PastelCard({ children, color = 'white', onPress, style, padded = true }: PastelCardProps) {
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
