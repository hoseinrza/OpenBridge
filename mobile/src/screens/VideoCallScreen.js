import { StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';

// Placeholder — real WebRTC calling lands in Phase 9 (react-native-webrtc).
export default function VideoCallScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>تماس تصویری</Text>
      <Text style={styles.sub}>فاز ۹: تماس واقعی WebRTC اینجا میاد</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.s0, alignItems: 'center', justifyContent: 'center', gap: 8 },
  title:     { color: colors.t1, fontSize: 22, fontFamily: fonts.bold },
  sub:       { color: colors.t2, fontSize: 13, fontFamily: fonts.regular },
});
