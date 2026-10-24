import { useMemo } from 'react';
import {
  Modal, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Avatar from './Avatar';
import { useCall } from '../context/CallContext';
import { useAuth } from '../context/AuthContext';
import { fonts, radius, spacing, type, useAppTheme } from '../theme';

function CallChip({ colors }) {
  return (
    <View style={[styles.chip, { backgroundColor: colors.surface2, borderColor: colors.border }]}>
      <FontAwesome6 name="lock-open" size={11} color={colors.text2} />
      <Text style={[styles.chipText, { color: colors.text2 }]}>بدون رمزنگاری سرتاسری</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  layerActive: {
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    paddingHorizontal: 0,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    alignItems: 'center',
    gap: spacing.md,
  },
  ring: {
    width: 132,
    height: 132,
    borderRadius: 66,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  title: {
    fontFamily: fonts.bold,
    fontSize: type.xl,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  subtitle: {
    fontFamily: fonts.regular,
    fontSize: type.base,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  chipText: {
    fontFamily: fonts.medium,
    fontSize: type.xs,
    writingDirection: 'rtl',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  btn: {
    minWidth: 100,
    height: 56,
    borderRadius: radius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  btnLabel: {
    fontFamily: fonts.semibold,
    fontSize: type.md,
    writingDirection: 'rtl',
  },
  ended: {
    fontFamily: fonts.regular,
    fontSize: type.base,
    textAlign: 'center',
    lineHeight: 24,
    writingDirection: 'rtl',
  },
});

function Incoming({ call, title, avatar, isGroup, callType, callerName, colors }) {
  return (
    <View style={styles.card}>
      <View style={[styles.ring, { borderColor: colors.accentSoft, backgroundColor: colors.surface }]}>
        <Avatar uri={avatar} name={title} size={104} group={isGroup} />
      </View>
      <Text style={[styles.title, { color: colors.text1 }]}>{title}</Text>
      <Text style={[styles.subtitle, { color: colors.text2 }]}>
        {callerName && isGroup ? `${callerName} · ` : ''}
        تماس {callType === 'video' ? 'ویدیویی' : 'صوتی'} ورودی
      </Text>
      <CallChip colors={colors} />
      <View style={styles.actions}>
        <Pressable
          onPress={call.rejectCall}
          accessibilityRole="button"
          accessibilityLabel="رد تماس"
          style={[styles.btn, { backgroundColor: colors.danger }]}
        >
          <FontAwesome6 name="phone-slash" size={18} color="#fff" />
          <Text style={[styles.btnLabel, { color: '#fff' }]}>رد</Text>
        </Pressable>
        <Pressable
          onPress={call.acceptCall}
          accessibilityRole="button"
          accessibilityLabel="پاسخ به تماس"
          style={[styles.btn, { backgroundColor: colors.success }]}
        >
          <FontAwesome6 name="phone" size={18} color="#fff" />
          <Text style={[styles.btnLabel, { color: '#fff' }]}>پاسخ</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Outgoing({ call, title, avatar, isGroup, callType, colors }) {
  return (
    <View style={styles.card}>
      <View style={[styles.ring, { borderColor: colors.accentSoft, backgroundColor: colors.surface }]}>
        <Avatar uri={avatar} name={title} size={104} group={isGroup} />
      </View>
      <Text style={[styles.title, { color: colors.text1 }]}>{title}</Text>
      <Text style={[styles.subtitle, { color: colors.text2 }]}>
        در حال زنگ زدن · تماس {callType === 'video' ? 'ویدیویی' : 'صوتی'}
      </Text>
      <CallChip colors={colors} />
      <View style={styles.actions}>
        <Pressable
          onPress={call.cancelCall}
          accessibilityRole="button"
          accessibilityLabel="لغو تماس"
          style={[styles.btn, { backgroundColor: colors.danger }]}
        >
          <FontAwesome6 name="phone-slash" size={18} color="#fff" />
          <Text style={[styles.btnLabel, { color: '#fff' }]}>لغو</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Ended({ call, title, avatar, isGroup, colors }) {
  return (
    <View style={styles.card}>
      <Avatar uri={avatar} name={title} size={84} group={isGroup} />
      <Text style={[styles.title, { color: colors.text1 }]}>{title}</Text>
      <Text style={[styles.ended, { color: call.error ? colors.danger : colors.text2 }]}>
        {call.error || call.notice || 'تماس پایان یافت'}
      </Text>
      <View style={styles.actions}>
        <Pressable
          onPress={call.dismiss}
          accessibilityRole="button"
          accessibilityLabel="بستن"
          style={[styles.btn, { backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border }]}
        >
          <Text style={[styles.btnLabel, { color: colors.text1 }]}>بستن</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function CallOverlay() {
  const call = useCall();
  const { currentUser } = useAuth();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();

  const CallRoom = useMemo(() => {
    if (call.phase !== 'active') return null;
    try {
      // Loaded only when a call is actually active, so the rest of the app can
      // run in environments without the native WebRTC module.
      return require('./CallRoom').default;
    } catch {
      return null;
    }
  }, [call.phase]);

  if (call.phase === 'idle') return null;

  const info = call.info;
  const isGroup = info?.kind === 'group';
  const title = (isGroup ? info?.group?.name : info?.peer?.name) || 'تماس';
  const avatar = isGroup ? info?.group?.avatar : info?.peer?.avatar;
  const callType = info?.type ?? 'audio';
  const callerName = info?.peer?.name ?? info?.from?.name ?? null;

  function close() {
    if (call.phase === 'incoming') call.rejectCall();
    else if (call.phase === 'outgoing' || call.phase === 'connecting') call.cancelCall();
    else if (call.phase === 'active') call.hangUp();
    else call.dismiss();
  }

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={close}
    >
      <View
        style={[
          styles.layer,
          { backgroundColor: colors.bg, paddingTop: insets.top, paddingBottom: insets.bottom },
          call.phase === 'active' && styles.layerActive,
        ]}
      >
        {call.phase === 'incoming' && (
          <Incoming
            call={call}
            title={title}
            avatar={avatar}
            isGroup={isGroup}
            callType={callType}
            callerName={callerName}
            colors={colors}
          />
        )}
        {call.phase === 'outgoing' && (
          <Outgoing call={call} title={title} avatar={avatar} isGroup={isGroup} callType={callType} colors={colors} />
        )}
        {call.phase === 'connecting' && !CallRoom && (
          <View style={styles.card}>
            <Avatar uri={avatar} name={title} size={96} group={isGroup} />
            <Text style={[styles.title, { color: colors.text1 }]}>{title}</Text>
            <Text style={[styles.subtitle, { color: colors.text2 }]}>در حال اتصال…</Text>
          </View>
        )}
        {call.phase === 'active' && CallRoom && (
          <CallRoom call={call} currentUser={currentUser} />
        )}
        {call.phase === 'active' && !CallRoom && (
          <Ended
            call={{ ...call, error: 'ماژول تماس بومی در این نصب نیست؛ نیاز به development build دارد' }}
            title={title}
            avatar={avatar}
            isGroup={isGroup}
            colors={colors}
          />
        )}
        {call.phase === 'ended' && (
          <Ended call={call} title={title} avatar={avatar} isGroup={isGroup} colors={colors} />
        )}
      </View>
    </Modal>
  );
}
