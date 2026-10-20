import { useMemo, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useAppTheme, fonts } from '../theme';

// Same idea as the web avatar: a user without a photo is represented by their
// initials on a colour picked deterministically from their name. Web paints a
// gradient, RN a flat tint — the palette is the darker stop of each web pair.
const PALETTE = [
  '#B0243A', '#D24A1B', '#E8830C', '#1F7A4C',
  '#0B6E77', '#1B5FBF', '#5B3BA8', '#9C2A77',
];

function initialsOf(name = '') {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = Array.from(words[0])[0];
  if (words.length === 1) return first.toUpperCase();
  return (first + Array.from(words[words.length - 1])[0]).toUpperCase();
}

function paletteOf(key) {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export default function Avatar({ uri, name = '', size = 44, group = false, status }) {
  const { colors } = useAppTheme();
  const [failed, setFailed] = useState(false);
  const showImage = uri && !failed;
  const initials = useMemo(() => initialsOf(name), [name]);
  const tint = paletteOf(name || initials);

  return (
    <View style={{ width: size, height: size }}>
      {showImage ? (
        <Image
          source={{ uri }}
          style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.surface2 }}
          onError={() => setFailed(true)}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <View
          style={[
            styles.fallback,
            group
              ? { backgroundColor: colors.accentSoft }
              : { backgroundColor: tint },
            { width: size, height: size, borderRadius: group ? size / 3 : size / 2 },
          ]}
        >
          {group
            ? <FontAwesome6 name="users" size={size * 0.36} color={colors.accentText} />
            : (
              <Text
                style={[styles.initial, { color: '#FFFFFF', fontSize: size * (initials.length > 1 ? 0.32 : 0.42) }]}
                numberOfLines={1}
              >
                {initials}
              </Text>
            )}
        </View>
      )}

      {status && (
        <View
          style={[
            styles.dot,
            {
              backgroundColor: status === 'online' ? colors.success : colors.text3,
              borderColor: colors.surface,
            },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: { alignItems: 'center', justifyContent: 'center' },
  initial: { fontFamily: fonts.semibold },
  dot: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
  },
});
