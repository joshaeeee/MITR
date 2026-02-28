export interface ColorScheme {
  background: string;
  surface: string;
  surfaceAlt: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  border: string;
  borderLight: string;

  mint: string;
  mintLight: string;
  mintDark: string;

  lavender: string;
  lavenderLight: string;
  lavenderDark: string;

  peach: string;
  peachLight: string;
  peachDark: string;

  sky: string;
  skyLight: string;
  skyDark: string;

  success: string;
  successLight: string;
  warning: string;
  warningLight: string;
  danger: string;
  dangerLight: string;
  info: string;
  infoLight: string;

  white: string;
  black: string;
  overlay: string;

  tabActive: string;
  tabInactive: string;
}

export const LightColors: ColorScheme = {
  background: '#F7F5F2',
  surface: '#FFFFFF',
  surfaceAlt: '#F0EEEB',
  text: '#1A1A2E',
  textSecondary: '#6B6B80',
  textTertiary: '#9B9BAF',
  border: '#E8E6E3',
  borderLight: '#F0EEEB',

  mint: '#C8E6D0',
  mintLight: '#E8F5EC',
  mintDark: '#5BA87A',

  lavender: '#D8CCE8',
  lavenderLight: '#EDE6F5',
  lavenderDark: '#8B6BAF',

  peach: '#F5D5C8',
  peachLight: '#FBE8E0',
  peachDark: '#D4856A',

  sky: '#C8DDF0',
  skyLight: '#E0EDF8',
  skyDark: '#5B8AB5',

  success: '#5BA87A',
  successLight: '#E8F5EC',
  warning: '#D4A03C',
  warningLight: '#FDF3E0',
  danger: '#D45B5B',
  dangerLight: '#FDE8E8',
  info: '#5B8AB5',
  infoLight: '#E0EDF8',

  white: '#FFFFFF',
  black: '#1A1A2E',
  overlay: 'rgba(26, 26, 46, 0.4)',

  tabActive: '#1A1A2E',
  tabInactive: '#9B9BAF',
};

export const DarkColors: ColorScheme = {
  background: '#0D0D14',
  surface: '#1A1A28',
  surfaceAlt: '#242436',
  text: '#F2F2FA',
  textSecondary: '#A8A8C0',
  textTertiary: '#6E6E88',
  border: '#2C2C44',
  borderLight: '#222234',

  mint: '#1B3D2A',
  mintLight: '#142E20',
  mintDark: '#5EE09A',

  lavender: '#352A54',
  lavenderLight: '#2A2044',
  lavenderDark: '#C4A8F0',

  peach: '#4A2820',
  peachLight: '#3A1E18',
  peachDark: '#F0A888',

  sky: '#1A3048',
  skyLight: '#14263C',
  skyDark: '#70B8F0',

  success: '#5EE09A',
  successLight: '#142E20',
  warning: '#F0C850',
  warningLight: '#3A3018',
  danger: '#F06060',
  dangerLight: '#3A1818',
  info: '#70B8F0',
  infoLight: '#14263C',

  white: '#FFFFFF',
  black: '#0D0D14',
  overlay: 'rgba(0, 0, 0, 0.7)',

  tabActive: '#F2F2FA',
  tabInactive: '#5A5A78',
};

export const DarkCardColors = {
  mint: '#1E4830',
  lavender: '#3C2E5C',
  peach: '#52302A',
  sky: '#1E3850',
} as const;

const Colors = LightColors;
export default Colors;
