import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList, I18nManager, Image, KeyboardAvoidingView, Linking, Platform,
  Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useChat } from '../hooks/useChat';
import { fonts, radius, spacing, type, useAppTheme } from '../theme';
import { dayKey, formatDayLabel } from '../utils/time';
import Avatar from '../components/Avatar';

const GROUP_GAP = 5 * 60 * 1000;
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢'];
// Yoga resolves flex-start/flex-end against the device direction, so the rows
// are pinned by physical side instead: own messages right, everyone else's left,
// on both RTL and LTR phones.
const RTL = I18nManager.isRTL;

function buildRows(messages) {
  const rows = [];
  let prevMsg = null;
  let prevDay = null;

  messages.forEach((msg, index) => {
    const day = dayKey(msg.createdAt);
    if (day !== prevDay) {
      rows.push({ type: 'day', key: `day-${day}`, label: formatDayLabel(msg.createdAt) });
      prevMsg = null;
      prevDay = day;
    }
    const next = messages[index + 1];
    const samePrev = prevMsg && prevMsg.senderId === msg.senderId && msg.createdAt - prevMsg.createdAt < GROUP_GAP;
    const sameNext = next && next.senderId === msg.senderId && next.createdAt - msg.createdAt < GROUP_GAP;
    rows.push({ type: 'msg', key: msg.id, msg, first: !samePrev, last: !sameNext });
    prevMsg = msg;
  });

  return rows;
}

export default function ChatScreen({ route }) {
  const peer = route.params?.peer;
  const { currentUser } = useAuth();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const {
    messages, isTyping, typingName, connected, locked,
    historyState, historyError, retryHistory,
    sendMessage, notifyTyping, toggleReaction,
  } = useChat(peer, currentUser);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [reactionPicker, setReactionPicker] = useState(null);
  const listRef = useRef(null);

  const styles = useMemo(() => makeStyles(colors), [colors]);
  const isGroup = peer?.kind === 'group';
  const rows = useMemo(() => buildRows(messages).reverse(), [messages]);

  useEffect(() => { setReactionPicker(null); }, [peer?.id]);

  // Tap once to react, tap the same emoji again to take it back; the server
  // answers with the finished list and the chips redraw from that.
  const onReact = useCallback((msgId, emoji) => {
    setReactionPicker(null);
    if (!toggleReaction(msgId, emoji)) {
      setError('اتصال به سرور برقرار نیست؛ واکنش ثبت نشد');
    }
  }, [toggleReaction]);

  const onSend = useCallback(async () => {
    const value = text.trim();
    if (!value || sending || locked) return;
    setSending(true);
    setError('');
    const result = await sendMessage(value);
    setSending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setText('');
  }, [text, sending, sendMessage, locked]);

  function openFile(msg) {
    if (msg.src) Linking.openURL(msg.src).catch(() => setError('باز کردن فایل ناموفق بود'));
  }

  const canSend = !!text.trim() && !sending && connected && !locked;

  function renderItem({ item }) {
    if (item.type === 'day') {
      return (
        <View style={styles.dayRow}>
          <View style={styles.dayPill}>
            <Text style={styles.dayText}>{item.label}</Text>
          </View>
        </View>
      );
    }

    const { msg, first, last } = item;
    const isMine = msg.side === 'mine';
    const reactions = msg.reactions ?? [];
    const held = new Set(reactions.filter(r => r.mine).map(r => r.emoji));
    const pickerOpen = reactionPicker === msg.id;

    return (
      <View style={[styles.msgRow, isMine ? styles.msgRowMine : styles.msgRowOther]}>
        <View style={[styles.bubbleCol, isMine ? styles.bubbleColMine : styles.bubbleColOther]}>
          <Pressable
            testID={`bubble-${isMine ? 'mine' : 'other'}`}
            style={[
              styles.bubble,
              isMine ? styles.bubbleMine : styles.bubbleOther,
              last && (isMine ? styles.bubbleMineLast : styles.bubbleOtherLast),
              reactions.length > 0 && styles.bubbleHasReactions,
            ]}
            onLongPress={() => setReactionPicker(pickerOpen ? null : msg.id)}
            onPress={() => { if (pickerOpen) setReactionPicker(null); }}
          >
            {isGroup && !isMine && first && (
              <Text style={styles.sender} numberOfLines={1}>{msg.sender || 'کاربر'}</Text>
            )}

            {msg.type === 'image' && msg.src ? (
              <Pressable
                onPress={() => openFile(msg)}
                onLongPress={() => setReactionPicker(pickerOpen ? null : msg.id)}
                accessibilityRole="imagebutton"
                accessibilityLabel="باز کردن تصویر"
              >
                <Image
                  source={{ uri: msg.src }}
                  style={styles.image}
                  resizeMode="cover"
                  accessibilityLabel={msg.text || 'تصویر ارسالی'}
                />
              </Pressable>
            ) : msg.type === 'file' && msg.src ? (
              <Pressable
                style={[styles.fileRow, isMine && styles.fileRowMine]}
                onPress={() => openFile(msg)}
                onLongPress={() => setReactionPicker(pickerOpen ? null : msg.id)}
                accessibilityRole="button"
                accessibilityLabel={`دانلود ${msg.name || 'فایل'}`}
              >
                <FontAwesome6 name="file-arrow-down" size={15} color={isMine ? colors.onBubbleOut : colors.accentText} />
                <Text style={[styles.fileName, isMine && styles.textMine]} numberOfLines={1}>
                  {msg.name || 'فایل'}
                </Text>
              </Pressable>
            ) : null}

            {!!msg.text && (
              <Text style={[styles.bubbleText, isMine && styles.bubbleTextMine]}>{msg.text}</Text>
            )}

            {pickerOpen && (
              <View
                style={[styles.tapbackRow, isMine ? styles.tapbackRowMine : styles.tapbackRowOther]}
                accessibilityRole="menu"
              >
                {REACTIONS.map(emoji => (
                  <Pressable
                    key={emoji}
                    testID={`reaction-option-${emoji}`}
                    style={[
                      styles.tapback,
                      isMine && styles.tapbackOut,
                      held.has(emoji) && styles.tapbackHeld,
                      held.has(emoji) && isMine && styles.tapbackOutHeld,
                    ]}
                    onPress={() => onReact(msg.id, emoji)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: held.has(emoji) }}
                    accessibilityLabel={held.has(emoji) ? `برداشتن واکنش ${emoji}` : `افزودن واکنش ${emoji}`}
                  >
                    <Text style={styles.tapbackText}>{emoji}</Text>
                  </Pressable>
                ))}
                <Pressable
                  style={[styles.tapbackClose, isMine && styles.tapbackOut]}
                  onPress={() => setReactionPicker(null)}
                  accessibilityRole="button"
                  accessibilityLabel="بستن واکنش‌ها"
                >
                  <FontAwesome6 name="xmark" size={11} color={isMine ? colors.onBubbleOut : colors.text2} />
                </Pressable>
              </View>
            )}

            <View style={styles.metaRow}>
              <Text style={[styles.time, isMine && styles.timeMine]}>{msg.time}</Text>
              {isMine && (
                <FontAwesome6
                  name="check-double"
                  size={10}
                  color={msg.read ? '#FFE0DE' : 'rgba(255,255,255,0.68)'}
                  accessibilityLabel={msg.read ? 'خوانده شد' : 'ارسال شد'}
                />
              )}
            </View>

            {reactions.length > 0 && (
              <View style={styles.reactions}>
                {reactions.map(({ emoji, mine }, index) => (
                  <Pressable
                    key={emoji}
                    testID={`reaction-chip-${index}`}
                    style={[
                      styles.reactionChip,
                      isMine && styles.reactionChipOut,
                      mine && styles.reactionChipHeld,
                      mine && isMine && styles.reactionChipOutHeld,
                    ]}
                    onPress={() => onReact(msg.id, emoji)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: mine }}
                    accessibilityLabel={mine ? `برداشتن واکنش ${emoji}` : `افزودن واکنش ${emoji}`}
                  >
                    <Text style={styles.reactionText}>{emoji}</Text>
                  </Pressable>
                ))}
              </View>
            )}

            {last && (
              <View
                pointerEvents="none"
                style={[styles.bubbleTail, isMine ? styles.bubbleTailMine : styles.bubbleTailOther]}
              />
            )}
          </Pressable>
        </View>

        {!isMine && (
          <View style={styles.avatarSlot}>
            {last
              ? <Avatar uri={msg.avatar} name={msg.sender || peer?.name} size={28} />
              : null}
          </View>
        )}
      </View>
    );
  }

  const header = isGroup ? (
    <View style={styles.intro}>
      <Avatar name={peer?.name} group size={64} />
      <Text style={styles.introName}>{peer?.name}</Text>
      <Text style={styles.introMeta}>
        {locked
          ? `گروه رمزنگاری‌شده · ${(peer?.memberCount ?? 0).toLocaleString('fa-IR')} عضو`
          : `گروه شامل ${(peer?.memberCount ?? 0).toLocaleString('fa-IR')} عضو`}
      </Text>
      {peer?.participants?.length > 0 && (
        <Text style={styles.introMembers} numberOfLines={3}>
          {peer.participants.map(p => p.name).join('، ')}
        </Text>
      )}
    </View>
  ) : (
    <View style={styles.intro}>
      <Avatar uri={peer?.avatar} name={peer?.name} size={64} status={peer?.status} />
      <Text style={styles.introName}>{peer?.name}</Text>
      <Text style={styles.introMeta}>
        {locked
          ? 'رمزنگاری سرتاسری · فقط در نسخهٔ وب قابل خواندن'
          : `${peer?.status === 'online' ? 'آنلاین' : 'آفلاین'}${peer?.username ? ` · @${peer.username}` : ''}`}
      </Text>
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 56 + insets.top : 0}
    >
      {!connected && (
        <View style={styles.offlineBar}>
          <Text style={styles.offlineText}>در حال اتصال به سرور…</Text>
        </View>
      )}

      {locked && (
        <View style={styles.lockedBar} accessibilityRole="alert">
          <FontAwesome6 name="lock" size={11} color={colors.text2} />
          <Text style={styles.lockedText}>
            این گفتگو سرتاسری رمزنگاری شده؛ خواندن و فرستادن پیام در آن فقط از نسخهٔ وب ممکن است.
          </Text>
        </View>
      )}

      {historyState === 'loading' && messages.length === 0 ? (
        <View style={styles.centerState}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.stateText}>در حال دریافت پیام‌ها…</Text>
        </View>
      ) : historyState === 'error' && messages.length === 0 ? (
        <View style={styles.centerState}>
          <FontAwesome6 name="triangle-exclamation" size={22} color={colors.danger} />
          <Text style={styles.stateText}>{historyError || 'دریافت پیام‌ها ناموفق بود'}</Text>
          <Pressable style={styles.retryBtn} onPress={retryHistory} accessibilityRole="button">
            <FontAwesome6 name="rotate-right" size={12} color={colors.onAccent} />
            <Text style={styles.retryText}>تلاش دوباره</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={rows}
          inverted
          keyExtractor={item => item.key}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ListFooterComponent={header}
          ListEmptyComponent={
            <View style={styles.centerState}>
              <Text style={styles.stateText}>
                {locked
                  ? 'پیام‌های این گفتگو فقط روی دستگاه اعضا رمزگشایی می‌شوند؛ برای خواندنشان از نسخهٔ وب استفاده کن.'
                  : 'هنوز پیامی رد و بدل نشده — اولین پیام را بنویس.'}
              </Text>
            </View>
          }
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={() => setReactionPicker(null)}
        />
      )}

      {isTyping && (
        <View style={styles.typingRow}>
          <View style={styles.typingDots}>
            <View style={styles.typingDot} />
            <View style={styles.typingDot} />
            <View style={styles.typingDot} />
          </View>
          <Text style={styles.typingText} numberOfLines={1}>{typingName || peer?.name} در حال نوشتن است…</Text>
        </View>
      )}

      {!!error && (
        <View style={styles.sendErrorRow} accessibilityRole="alert">
          <FontAwesome6 name="circle-exclamation" size={12} color={colors.danger} />
          <Text style={styles.sendError}>{error}</Text>
          <Pressable onPress={() => setError('')} hitSlop={10} accessibilityRole="button" accessibilityLabel="بستن خطا">
            <FontAwesome6 name="xmark" size={12} color={colors.text2} />
          </Pressable>
        </View>
      )}

      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        <TextInput
          style={[styles.input, locked && styles.inputLocked]}
          value={text}
          onChangeText={(value) => { setText(value); setError(''); notifyTyping(); }}
          editable={!locked}
          placeholder={locked
            ? 'نوشتن در این گفتگو فقط از نسخهٔ وب ممکن است'
            : (connected ? 'پیامت را بنویس…' : 'در انتظار اتصال…')}
          placeholderTextColor={colors.text3}
          multiline
          maxLength={4000}
          testID="composer-input"
          accessibilityLabel="متن پیام"
        />
        <Pressable
          testID="composer-send"
          style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
          onPress={onSend}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel="ارسال پیام"
          accessibilityState={{ disabled: !canSend }}
        >
          {sending
            ? <ActivityIndicator color={colors.onAccent} size="small" />
            : <FontAwesome6 name="paper-plane" size={15} color={canSend ? colors.onAccent : colors.text3} />}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function makeStyles(colors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.chat },
    list: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.md },

    offlineBar: { backgroundColor: colors.surface2, paddingVertical: 5, alignItems: 'center' },
    offlineText: { color: colors.text2, fontFamily: fonts.regular, fontSize: type.xs },
    lockedBar: {
      flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.sm,
      paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
      backgroundColor: colors.surface2, borderBottomWidth: 1, borderBottomColor: colors.border,
    },
    lockedText: {
      flex: 1, color: colors.text2, fontFamily: fonts.regular, fontSize: type.xs,
      textAlign: 'right', lineHeight: 18,
    },

    centerState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.xxxl,
    },
    stateText: { color: colors.text2, fontFamily: fonts.regular, fontSize: type.sm, textAlign: 'center', lineHeight: 22 },
    retryBtn: {
      flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.sm,
      minHeight: 44, paddingHorizontal: spacing.lg,
      borderRadius: radius.md, backgroundColor: colors.accent,
    },
    retryText: { color: colors.onAccent, fontFamily: fonts.semibold, fontSize: type.sm },

    // VirtualizedList flips footer/empty cells itself for `inverted`; adding a
    // manual scaleY here would double-flip the content upside down.
    intro: {
      alignItems: 'center',
      gap: spacing.xs,
      paddingVertical: spacing.xl,
      paddingHorizontal: spacing.lg,
    },
    introName: { color: colors.text1, fontFamily: fonts.semibold, fontSize: type.md, marginTop: spacing.xs },
    introMeta: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.sm },
    introMembers: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.xs, textAlign: 'center', marginTop: spacing.xs },

    dayRow: { alignItems: 'center', marginVertical: spacing.md, paddingVertical: spacing.xs },
    dayPill: {
      paddingHorizontal: spacing.md,
      paddingVertical: 3,
      borderRadius: radius.pill,
      backgroundColor: colors.surface2,
      borderWidth: 1,
      borderColor: colors.border,
    },
    dayText: { color: colors.text3, fontFamily: fonts.medium, fontSize: type.xs },

    msgRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.xs, marginVertical: 2 },
    msgRowMine: { justifyContent: RTL ? 'flex-start' : 'flex-end' },
    // Reversed in LTR so the avatar lands on the outer (left) edge; in RTL the
    // normal row already draws the avatar on the left.
    msgRowOther: { flexDirection: RTL ? 'row' : 'row-reverse', justifyContent: 'flex-end' },
    avatarSlot: { width: 28 },
    bubbleCol: { maxWidth: '78%' },
    bubbleColMine: { alignItems: RTL ? 'flex-start' : 'flex-end' },
    bubbleColOther: { alignItems: RTL ? 'flex-end' : 'flex-start' },
    sender: { color: colors.accentText, fontFamily: fonts.medium, fontSize: type.sm, marginBottom: 2 },

    bubble: {
      borderRadius: radius.md,
      paddingHorizontal: spacing.sm + 3,
      paddingVertical: 7,
      gap: 3,
      minWidth: 74,
    },
    bubbleHasReactions: { paddingBottom: 4 },
    bubbleOther: {
      backgroundColor: colors.bubbleIn,
      borderWidth: 1,
      borderColor: colors.border,
    },
    bubbleMine: {
      backgroundColor: colors.bubbleOut,
      experimental_backgroundImage: colors.bubbleOutGrad,
    },
    bubbleOtherLast: { borderBottomLeftRadius: 2 },
    bubbleMineLast: { borderBottomRightRadius: 2 },
    // Telegram's tail is a curved sliver outside the flattened bottom corner.
    bubbleTail: { position: 'absolute', bottom: 0, width: 10, height: 13 },
    bubbleTailMine: {
      right: -9,
      backgroundColor: colors.bubbleOutTail,
      borderBottomLeftRadius: 10,
    },
    bubbleTailOther: {
      left: -9,
      backgroundColor: colors.bubbleIn,
      borderBottomRightRadius: 10,
    },

    bubbleText: { color: colors.text1, fontFamily: fonts.regular, fontSize: type.base, lineHeight: 22 },
    bubbleTextMine: { color: colors.onBubbleOut },
    textMine: { color: colors.onBubbleOut },

    image: { width: 220, height: 160, maxWidth: '100%', borderRadius: radius.sm },
    fileRow: {
      flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.sm,
      paddingVertical: 2, maxWidth: 240,
    },
    fileRowMine: {},
    fileName: { flex: 1, color: colors.accentText, fontFamily: fonts.medium, fontSize: type.sm },

    reactions: {
      flexDirection: 'row', flexWrap: 'wrap', alignSelf: 'flex-start',
      gap: 3, maxWidth: '100%', marginTop: 2, marginBottom: -1,
    },
    reactionChip: {
      minWidth: 24, minHeight: 23,
      paddingHorizontal: 7, paddingVertical: 2,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: 'transparent',
      backgroundColor: colors.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // Held by this device: pressed, so it reads as yours and taps lift it again.
    reactionChipHeld: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
    // On the outgoing red bubble a light chip would disappear, so it keeps the
    // bubble's own palette and only the border marks the reaction as yours.
    reactionChipOut: { backgroundColor: 'rgba(255,255,255,0.18)' },
    reactionChipOutHeld: { borderColor: '#FFE0DE', backgroundColor: 'rgba(255,255,255,0.30)' },
    reactionText: { color: colors.text1, fontFamily: fonts.regular, fontSize: 14, lineHeight: 18 },

    /* Floats above the bubble instead of sitting in its flow, so opening it
       never changes the bubble height or moves the conversation. Own messages
       anchor to their right edge, incoming ones to their left, so the tray
       always opens toward the middle of the screen. */
    tapbackRow: {
      position: 'absolute',
      top: -44,
      zIndex: 20,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      paddingHorizontal: 3,
      paddingVertical: 3,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface3,
      shadowColor: '#000',
      shadowOpacity: 0.18,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 3 },
      elevation: 8,
    },
    tapbackRowMine: { right: 0 },
    tapbackRowOther: { left: 0 },
    tapback: {
      width: 34, height: 34,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface3,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tapbackHeld: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
    tapbackOut: { borderColor: 'rgba(255,255,255,0.32)', backgroundColor: 'rgba(255,255,255,0.16)' },
    tapbackOutHeld: { borderColor: '#FFE0DE', backgroundColor: 'rgba(255,255,255,0.30)' },
    tapbackText: { fontSize: 17 },
    tapbackClose: {
      width: 26, height: 26,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface3,
      alignItems: 'center',
      justifyContent: 'center',
    },

    metaRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end', gap: 4 },
    time: { color: colors.text3, fontFamily: fonts.regular, fontSize: 10.5 },
    timeMine: { color: 'rgba(255,255,255,0.78)' },

    typingRow: {
      flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.sm,
      paddingHorizontal: spacing.lg, paddingBottom: spacing.xs,
    },
    typingDots: { flexDirection: 'row', gap: 3 },
    typingDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.text3 },
    typingText: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.xs },

    sendErrorRow: {
      flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.sm,
      marginHorizontal: spacing.md, marginBottom: spacing.xs,
      paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
      borderRadius: radius.sm, backgroundColor: colors.dangerSoft,
    },
    sendError: { flex: 1, color: colors.text1, fontFamily: fonts.regular, fontSize: type.sm, textAlign: 'right' },

    composer: {
      flexDirection: 'row-reverse', alignItems: 'flex-end', gap: spacing.sm,
      paddingHorizontal: spacing.md, paddingTop: spacing.sm,
      borderTopWidth: 1, borderTopColor: colors.border,
      backgroundColor: colors.chat,
    },
    input: {
      flex: 1,
      minHeight: 44,
      maxHeight: 132,
      paddingHorizontal: spacing.md + 2,
      paddingTop: 11,
      paddingBottom: 10,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      backgroundColor: colors.surface,
      color: colors.text1,
      fontFamily: fonts.regular,
      fontSize: type.base,
      textAlign: 'right',
    },
    inputLocked: { backgroundColor: colors.surface2, color: colors.text3 },
    sendBtn: {
      width: 44, height: 44, borderRadius: radius.md,
      backgroundColor: colors.accent,
      alignItems: 'center', justifyContent: 'center',
    },
    sendBtnDisabled: { backgroundColor: colors.surface3 },
  });
}
