import { useCallback, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { useChat } from '../hooks/useChat';
import { colors, fonts } from '../theme';

export default function ChatScreen({ route }) {
  const peer = route.params?.peer;
  const { currentUser } = useAuth();
  const { messages, isTyping, connected, sendMessage, notifyTyping } = useChat(peer, currentUser);
  const [text, setText]   = useState('');
  const [error, setError] = useState('');

  const onSend = useCallback(() => {
    if (!text.trim()) return;
    if (!sendMessage(text)) {
      setError('اتصال به سرور برقرار نیست — دوباره تلاش کن');
      return;
    }
    setError('');
    setText('');
  }, [text, sendMessage]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {!connected && (
        <View style={styles.offlineBar}>
          <Text style={styles.offlineText}>در حال اتصال...</Text>
        </View>
      )}

      <FlatList
        data={[...messages].reverse()}
        inverted
        keyExtractor={(m) => String(m.id)}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={[styles.row, item.side === 'mine' ? styles.rowMine : styles.rowOther]}>
            <View style={[styles.bubble, item.side === 'mine' ? styles.bubbleMine : styles.bubbleOther]}>
              <Text style={[styles.bubbleText, item.side === 'mine' && styles.bubbleTextMine]}>{item.text}</Text>
              <View style={styles.metaRow}>
                <Text style={[styles.time, item.side === 'mine' && styles.timeMine]}>{item.time}</Text>
                {item.side === 'mine' && (
                  <FontAwesome6
                    name="check-double"
                    size={11}
                    color={item.read ? '#BFD8FF' : 'rgba(255,255,255,0.6)'}
                  />
                )}
              </View>
            </View>
          </View>
        )}
      />

      {isTyping && (
        <Text style={styles.typing}>{peer?.name} در حال نوشتن است...</Text>
      )}

      {!!error && <Text style={styles.sendError}>{error}</Text>}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={(v) => { setText(v); setError(''); notifyTyping(); }}
          placeholder="پیامی بنویسید..."
          placeholderTextColor={colors.t3}
          multiline
        />
        <Pressable style={styles.sendBtn} onPress={onSend}>
          <FontAwesome6 name="paper-plane" size={15} color="#fff" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.s0 },
  list: { padding: 16, gap: 6, flexGrow: 1, justifyContent: 'flex-end' },

  offlineBar: { backgroundColor: colors.s2, paddingVertical: 5, alignItems: 'center' },
  offlineText: { color: colors.t3, fontFamily: fonts.regular, fontSize: 11 },

  row: { flexDirection: 'row' },
  rowMine:  { justifyContent: 'flex-end' },
  rowOther: { justifyContent: 'flex-start' },

  bubble: { maxWidth: '78%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9, marginVertical: 3 },
  bubbleOther: { backgroundColor: colors.s2, borderWidth: 1, borderColor: colors.border, borderBottomLeftRadius: 4 },
  bubbleMine:  { backgroundColor: colors.accent, borderBottomRightRadius: 4 },

  bubbleText:     { color: colors.t1, fontFamily: fonts.regular, fontSize: 14, textAlign: 'right' },
  bubbleTextMine: { color: '#fff' },

  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  time:     { color: colors.t3, fontFamily: fonts.regular, fontSize: 10 },
  timeMine: { color: 'rgba(255,255,255,0.75)' },

  typing: { color: colors.t3, fontFamily: fonts.regular, fontSize: 12, paddingHorizontal: 16, paddingBottom: 4 },
  sendError: { color: colors.red, fontFamily: fonts.regular, fontSize: 11, paddingHorizontal: 16, paddingBottom: 4, textAlign: 'right' },

  composer: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8,
    paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border,
  },
  input: {
    flex: 1, backgroundColor: colors.s2, borderWidth: 1, borderColor: colors.border,
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, maxHeight: 120,
    color: colors.t1, fontFamily: fonts.regular, fontSize: 14, textAlign: 'right',
  },
  sendBtn: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accent,
    alignItems: 'center', justifyContent: 'center',
  },
});
