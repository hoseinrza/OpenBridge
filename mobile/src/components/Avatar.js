import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useAppTheme, fonts } from '../theme';

export default function Avatar({ uri, name = '', size = 44, group = false, status }) {
  const { colors } = useAppTheme();
  const [failed, setFailed] = useState(false);
  const showImage = uri && !failed;
  const initial = name.trim().charAt(0) || '?';

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
            {
              width: size, height: size, borderRadius: group ? size / 3 : size / 2,
              backgroundColor: group ? colors.accentSoft : colors.surface3,
            },
          ]}
        >
          {group
            ? <FontAwesome6 name="users" size={size * 0.36} color={colors.accentText} />
            : <Text style={[styles.initial, { color: colors.text2, fontSize: size * 0.4 }]}>{initial}</Text>}
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
