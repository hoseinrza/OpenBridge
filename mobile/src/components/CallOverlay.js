import { useMemo } from 'react';
import {
  ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Avatar from './Avatar';
import { useCall } from '../context/CallContext';
import { useAuth } from '../context/AuthContext';
import { fonts, type } from '../theme';

const CALL_BG = '#050608';

function Backdrop({ uri }) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {uri ? (
        <Image
          source={{ uri }}
          blurRadius={42}
          resizeMode="cover"
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: uri ? 'rgba(0,0,0,0.56)' : CALL_BG }]} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.18)' }]} />
    </View>
  );
}

function EncNote({ call, compact = false }) {
  const e2ee = call.info?.e2ee === true;
  return (
    <View style={styles.enc} accessibilityLabel={e2ee ? 'رمزنگاری‌شده' : 'بدون رمزنگاری'}>
      <FontAwesome6
        name={e2ee ? 'lock' : 'lock-open'}
        size={9}
        color={e2ee ? '#9fe7b5' : 'rgba(255,255,255,0.58)'}
      />
      <Text style={[styles.encText, e2ee && styles.encTextOn, compact && styles.encTextCompact]}>
        {e2ee ? 'رمزنگاری‌شده' : 'بدون رمزنگاری'}
      </Text>
    </View>
  );
}

function RoundButton({ icon, label, onPress, tone = 'neutral', disabled = false, busy = false, size = 64 }) {
  const toneStyle = tone === 'reject'
    ? styles.roundReject
    : tone === 'accept'
      ? styles.roundAccept
      : tone === 'end'
        ? styles.roundEnd
        : null;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.round,
        toneStyle,
        { width: size, height: size, borderRadius: size / 2 },
        pressed && !disabled && styles.roundPressed,
        disabled && styles.roundDisabled,
      ]}
    >
      {busy
        ? <ActivityIndicator color="#fff" />
        : <FontAwesome6 name={icon} size={Math.round(size * 0.32)} color="#fff" />}
    </Pressable>
  );
}

function RingScreen({ title, avatar, isGroup, subtitle, children }) {
  return (
    <View style={styles.ringScreen}>
      <View style={styles.hero}>
        <View style={styles.pulse} />
        <Avatar uri={avatar} name={title} size={124} group={isGroup} />
      </View>
      <Text style={styles.name} numberOfLines={2}>{title}</Text>
      <View style={styles.subtitle}>{subtitle}</View>
      <View style={styles.decision}>{children}</View>
    </View>
  );
}

function Incoming({ call, title, avatar, isGroup, callType, callerName }) {
  const accepting = call.busy;

  return (
    <RingScreen
      title={title}
      avatar={avatar}
      isGroup={isGroup}
      subtitle={(
        <>
          {callerName && isGroup ? <Text style={styles.from}>{callerName}</Text> : null}
          <Text style={styles.status}>{`تماس ${callType === 'video' ? 'ویدیویی' : 'صوتی'} ورودی`}</Text>
          <EncNote call={call} />
        </>
      )}
    >
      <RoundButton
        icon="phone-slash"
        label="رد تماس"
        tone="reject"
        size={68}
        onPress={call.rejectCall}
      />
      <RoundButton
        icon={callType === 'video' ? 'video' : 'phone'}
        label="پاسخ به تماس"
        tone="accept"
        size={68}
        onPress={call.acceptCall}
        disabled={accepting}
        busy={accepting}
      />
    </RingScreen>
  );
}

function Outgoing({ call, title, avatar, isGroup, callType }) {
  return (
    <RingScreen
      title={title}
      avatar={avatar}
      isGroup={isGroup}
      subtitle={(
        <>
          <View style={styles.ringingRow}>
            <ActivityIndicator size="small" color="rgba(255,255,255,0.7)" />
            <Text style={styles.status}>در حال زنگ زدن</Text>
          </View>
          <Text style={styles.type}>{callType === 'video' ? 'تماس ویدیویی' : 'تماس صوتی'}</Text>
          <EncNote call={call} />
        </>
      )}
    >
      <RoundButton
        icon="phone-slash"
        label="لغو تماس"
        tone="reject"
        size={68}
        onPress={call.cancelCall}
      />
    </RingScreen>
  );
}

function Preparing({ call, title, avatar, isGroup }) {
  return (
    <RingScreen
      title={title}
      avatar={avatar}
      isGroup={isGroup}
      subtitle={(
        <>
          <View style={styles.ringingRow}>
            <ActivityIndicator size="small" color="rgba(255,255,255,0.7)" />
            <Text style={styles.status}>در حال آماده‌سازی…</Text>
          </View>
          <EncNote call={call} />
        </>
      )}
    >
      <RoundButton
        icon="xmark"
        label="انصراف از تماس"
        tone="reject"
        size={68}
        onPress={call.cancelCall}
      />
    </RingScreen>
  );
}

function Ended({ call, title, avatar, isGroup }) {
  return (
    <View style={styles.ended}>
      <Avatar uri={avatar} name={title} size={96} group={isGroup} />
      <Text style={styles.name} numberOfLines={2}>{title}</Text>
      <Text style={[styles.endedText, call.error && styles.endedTextError]}>
        {call.error || call.notice || 'تماس پایان یافت'}
      </Text>
      <Pressable
        onPress={call.dismiss}
        accessibilityRole="button"
        accessibilityLabel="بستن"
        style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
      >
        <Text style={styles.closeText}>بستن</Text>
      </Pressable>
    </View>
  );
}

export default function CallOverlay() {
  const call = useCall();
  const { currentUser } = useAuth();
  const insets = useSafeAreaInsets();

  const CallRoom = useMemo(() => {
    if (call.phase !== 'active') return null;
    try {
      // Loaded only when a call is active, so the rest of the app can run in
      // environments without the native WebRTC module.
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
  const active = call.phase === 'active';

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
          active && styles.layerActive,
          {
            paddingTop: active ? 0 : insets.top,
            paddingBottom: active ? 0 : insets.bottom,
          },
        ]}
      >
        <Backdrop uri={avatar} />

        {call.phase === 'incoming' && (
          <Incoming
            call={call}
            title={title}
            avatar={avatar}
            isGroup={isGroup}
            callType={callType}
            callerName={callerName}
          />
        )}
        {call.phase === 'outgoing' && (
          <Outgoing call={call} title={title} avatar={avatar} isGroup={isGroup} callType={callType} />
        )}
        {call.phase === 'connecting' && !CallRoom && (
          <View style={styles.ended}>
            <ActivityIndicator color="#fff" />
            <Text style={styles.status}>در حال اتصال…</Text>
          </View>
        )}
        {active && CallRoom && (
          <CallRoom call={call} currentUser={currentUser} />
        )}
        {active && !CallRoom && (
          <Ended
            call={{ ...call, error: 'ماژول تماس بومی در این نصب نیست؛ نیاز به development build دارد' }}
            title={title}
            avatar={avatar}
            isGroup={isGroup}
          />
        )}
        {call.phase === 'ended' && (
          <Ended call={call} title={title} avatar={avatar} isGroup={isGroup} />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  layer: {
    flex: 1,
    backgroundColor: CALL_BG,
    alignItems: 'center',
    justifyContent: 'center',
  },
  layerActive: {
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    paddingHorizontal: 0,
  },
  ringScreen: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingBottom: 150,
  },
  hero: {
    width: 124,
    height: 124,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulse: {
    position: 'absolute',
    top: -15,
    left: -15,
    right: -15,
    bottom: -15,
    borderRadius: 80,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  name: {
    marginTop: 16,
    maxWidth: '92%',
    color: '#fff',
    fontFamily: fonts.bold,
    fontSize: 22,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  subtitle: {
    marginTop: 6,
    alignItems: 'center',
    gap: 4,
    maxWidth: '92%',
  },
  from: {
    color: 'rgba(255,255,255,0.58)',
    fontFamily: fonts.regular,
    fontSize: 13,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  status: {
    color: 'rgba(255,255,255,0.68)',
    fontFamily: fonts.regular,
    fontSize: 14,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  type: {
    color: 'rgba(255,255,255,0.4)',
    fontFamily: fonts.regular,
    fontSize: 12,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  ringingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  enc: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 2,
  },
  encText: {
    color: 'rgba(255,255,255,0.55)',
    fontFamily: fonts.medium,
    fontSize: 11,
    writingDirection: 'rtl',
  },
  encTextOn: { color: '#9fe7b5' },
  encTextCompact: { fontSize: 10 },
  decision: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 44,
  },
  round: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  roundReject: {
    backgroundColor: '#ff3b30',
    borderColor: 'transparent',
    shadowColor: '#ff3b30',
    shadowOpacity: 0.3,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  roundAccept: {
    backgroundColor: '#34c759',
    borderColor: 'transparent',
    shadowColor: '#34c759',
    shadowOpacity: 0.28,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  roundEnd: {
    backgroundColor: '#ff3b30',
    borderColor: 'transparent',
  },
  roundPressed: { transform: [{ scale: 0.95 }] },
  roundDisabled: { opacity: 0.55 },
  ended: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 28,
  },
  endedText: {
    maxWidth: 330,
    color: 'rgba(255,255,255,0.65)',
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 23,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  endedTextError: { color: '#ffb7b2' },
  close: {
    marginTop: 6,
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  closePressed: { backgroundColor: 'rgba(255,255,255,0.18)' },
  closeText: {
    color: 'rgba(255,255,255,0.85)',
    fontFamily: fonts.medium,
    fontSize: 13,
    writingDirection: 'rtl',
  },
});
