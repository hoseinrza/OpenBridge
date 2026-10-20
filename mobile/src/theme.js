// Mirrors the web app's design tokens (src/index.css). Keep token names and
// values in sync so both clients feel like one product.
import { useColorScheme } from 'react-native';

const shared = {
  accent:     '#C5161D',
  onAccent:   '#FFFFFF',
  warm:       '#FFC928',
  danger:     '#B3261E',
  dangerSoft: 'rgba(179,38,30,0.10)',
  success:    '#1E7D4B',
  successSoft:'rgba(30,125,75,0.12)',
};

export const lightColors = {
  ...shared,
  bg:        '#F6F3EE',
  surface:   '#FFFFFF',
  surface2:  '#F1EDE6',
  surface3:  '#E8E2D9',
  sidebar:   '#F1EDE6',
  chat:      '#FAF8F4',
  bubbleIn:  '#FFFFFF',
  bubbleOut: '#C5161D',
  onBubbleOut: '#FFFFFF',

  text1: '#211E1A',
  text2: '#5D574E',
  text3: '#6E675C',

  accentText: '#A91118',
  accentSoft: 'rgba(197,22,29,0.08)',
  warmSoft:   'rgba(255,201,40,0.18)',
  warmInk:    '#6B4E00',

  border:       'rgba(33,30,26,0.10)',
  borderStrong: 'rgba(33,30,26,0.20)',
  focus:        '#C5161D',
  overlay:      'rgba(33,30,26,0.45)',
};

export const darkColors = {
  ...shared,
  // Filled accent surfaces keep the brand red so white labels stay AA;
  // accentText is the light variant used for text/icons on dark surfaces.
  accent:     '#C5161D',
  danger:     '#F26B66',
  dangerSoft: 'rgba(242,107,102,0.14)',
  success:    '#4BC98A',
  successSoft:'rgba(75,201,138,0.14)',

  bg:        '#121110',
  surface:   '#1B1917',
  surface2:  '#24211D',
  surface3:  '#2F2A25',
  sidebar:   '#171513',
  chat:      '#141210',
  bubbleIn:  '#24211D',
  bubbleOut: '#B3161C',
  onBubbleOut: '#FFFFFF',

  text1: '#F2EEE6',
  text2: '#B9B1A5',
  text3: '#938B7E',

  accentText: '#FF8A85',
  accentSoft: 'rgba(230,58,63,0.14)',
  warmSoft:   'rgba(245,197,66,0.14)',
  warmInk:    '#F5D77E',

  border:       'rgba(255,255,255,0.09)',
  borderStrong: 'rgba(255,255,255,0.18)',
  focus:        '#FF8A85',
  overlay:      'rgba(0,0,0,0.6)',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const radius = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
};

export const type = {
  xs: 11,
  sm: 12.5,
  base: 14,
  md: 15,
  lg: 18,
  xl: 22,
  xxl: 28,
};

export const navFonts = {
  regular: { fontFamily: 'Vazirmatn-Regular', fontWeight: '400' },
  medium:  { fontFamily: 'Vazirmatn-Medium', fontWeight: '500' },
  bold:    { fontFamily: 'Vazirmatn-Bold', fontWeight: '700' },
  heavy:   { fontFamily: 'Vazirmatn-Bold', fontWeight: '800' },
};

export const fonts = {
  regular:  'Vazirmatn-Regular',
  medium:   'Vazirmatn-Medium',
  semibold: 'Vazirmatn-SemiBold',
  bold:     'Vazirmatn-Bold',
};

export const fontAssets = {
  [fonts.regular]:  require('../assets/fonts/Vazirmatn-Regular.ttf'),
  [fonts.medium]:   require('../assets/fonts/Vazirmatn-Medium.ttf'),
  [fonts.semibold]: require('../assets/fonts/Vazirmatn-SemiBold.ttf'),
  [fonts.bold]:     require('../assets/fonts/Vazirmatn-Bold.ttf'),
};

export function useAppTheme() {
  const scheme = useColorScheme();
  const dark = scheme === 'dark';
  const colors = dark ? darkColors : lightColors;
  return { dark, scheme: dark ? 'dark' : 'light', colors };
}
