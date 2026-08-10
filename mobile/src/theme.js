// Ported from the web app's design tokens (src/index.css :root).
// Keep token NAMES in sync with the web app so the two stay comparable.

export const colors = {
  s0: '#0F1117',
  s1: '#11131B',
  s2: '#171923',
  s3: '#1D2030',

  accent:     '#6D4AFF',
  accentSoft: '#5B3FE0',
  accent2:    '#8B5CF6',
  accentDim:  'rgba(109,74,255,0.15)',
  accentGlow: 'rgba(109,74,255,0.32)',

  t1: '#F5F5F7',
  t2: '#9296A5',
  t3: '#696E7D',

  green:     '#35D07F',
  greenGlow: 'rgba(53,208,127,0.28)',
  yellow:    '#f0b232',
  red:       '#EF4444',
  redGlow:   'rgba(239,68,68,0.2)',

  border:   'rgba(255,255,255,0.08)',
  borderHi: 'rgba(255,255,255,0.14)',
};

export const radius = {
  sm: 8,
  md: 10,
  lg: 16,
};

// expo-font asset keys — load these via useFonts() before rendering.
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
  [fonts.bold]:      require('../assets/fonts/Vazirmatn-Bold.ttf'),
};

export const theme = { colors, radius, fonts };
export default theme;
