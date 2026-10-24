import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Platform, PermissionsAndroid, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  AudioSession, LiveKitRoom, VideoTrack, registerGlobals,
  useConnectionState, useLocalParticipant, useParticipants, useRoomContext, useTracks,
} from '@livekit/react-native';
import { ConnectionState, Track } from 'livekit-client';
import Avatar from './Avatar';
import { fonts, radius, spacing, type, useAppTheme } from '../theme';

// Must run before any LiveKit object uses WebRTC.
registerGlobals();

function Centered({ children, colors }) {
  return (
    <View style={[styles.centered, { backgroundColor: colors.bg }]}>{children}</View>
  );
}

function VideoTile({ trackRef, style, mirror = false, zOrder = 0 }) {
  return (
    <View style={style}>
      <VideoTrack
        trackRef={trackRef}
        style={StyleSheet.absoluteFill}
        objectFit="cover"
        mirror={mirror}
        zOrder={zOrder}
      />
    </View>
  );
}

function ConnChip({ state, colors }) {
  if (state === ConnectionState.Connected) return null;
  const reconnecting = state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting;
  return (
    <View style={[styles.connChip, { backgroundColor: reconnecting ? colors.warmSoft : colors.surface2 }]}>
      {reconnecting && <ActivityIndicator size="small" color={colors.warmInk} />}
      <Text style={[styles.connText, { color: reconnecting ? colors.warmInk : colors.text2 }]}>
        {reconnecting ? 'اتصال دوباره…' : 'در حال اتصال…'}
      </Text>
    </View>
  );
}

function ParticipantTile({ participant, isLocal, currentUser, trackRef, micOn, colors }) {
  const name = participant.name || participant.identity || 'کاربر';
  return (
    <View style={[styles.tile, participant.isSpeaking && { borderColor: colors.success, borderWidth: 2 }]}>
      {trackRef ? (
        <VideoTile trackRef={trackRef} style={StyleSheet.absoluteFill} mirror={isLocal} zOrder={isLocal ? 1 : 0} />
      ) : (
        <View style={styles.tileAvatar}>
          <Avatar name={isLocal ? (currentUser?.name ?? name) : name} size={72} />
        </View>
      )}
      <View style={styles.tileFooter}>
        <Text style={styles.tileName} numberOfLines={1}>
          {name}{isLocal ? ' (شما)' : ''}
        </Text>
        {!micOn && <FontAwesome6 name="microphone-slash" size={11} color="#FF8A85" />}
      </View>
    </View>
  );
}

function CallUI({ call, currentUser, video, onEnd }) {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const room = useRoomContext();
  const participants = useParticipants();
  const cameraTracks = useTracks([Track.Source.Camera]);
  const { isMicrophoneEnabled, isCameraEnabled, localParticipant } = useLocalParticipant();
  const connection = useConnectionState();
  const [seconds, setSeconds] = useState(0);
  const [notice, setNotice] = useState('');

  const connected = connection === ConnectionState.Connected;
  useEffect(() => {
    if (!connected) return undefined;
    const id = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(id);
  }, [connected]);

  useEffect(() => {
    if (notice) {
      const id = setTimeout(() => setNotice(''), 2500);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [notice]);

  const localIdentity = localParticipant?.identity ?? room?.localParticipant?.identity;
  const remoteParticipants = participants.filter((participant) => participant.identity !== localIdentity);
  const cameraByIdentity = useMemo(() => {
    const map = new Map();
    for (const ref of cameraTracks) {
      if (ref?.participant?.identity && ref.publication?.track) {
        map.set(ref.participant.identity, ref);
      }
    }
    return map;
  }, [cameraTracks]);

  const isGroup = call.info?.kind === 'group';
  const title = (isGroup ? call.info?.group?.name : call.info?.peer?.name) || 'تماس';
  const localTrack = cameraByIdentity.get(localIdentity);
  const remote = remoteParticipants[0];
  const remoteTrack = remote ? cameraByIdentity.get(remote.identity) : null;
  const timer = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

  async function toggleMic() {
    try {
      await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
    } catch {
      setNotice('تغییر وضعیت میکروفون ممکن نشد');
    }
  }

  async function toggleCamera() {
    try {
      await localParticipant.setCameraEnabled(!isCameraEnabled);
    } catch {
      setNotice('تغییر وضعیت دوربین ممکن نشد');
    }
  }

  return (
    <View style={[styles.screen, { backgroundColor: '#08090d', paddingTop: insets.top }]}>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.headTitle} numberOfLines={1}>{title}</Text>
          <Text style={styles.headSub}>
            {call.info?.type === 'video' ? 'تماس ویدیویی' : 'تماس صوتی'} · {timer}
          </Text>
        </View>
        <View style={[styles.encChip, { backgroundColor: 'rgba(255,255,255,0.08)', borderColor: 'rgba(255,255,255,0.12)' }]}>
          <FontAwesome6 name="lock-open" size={10} color="rgba(255,255,255,0.72)" />
          <Text style={styles.encText}>بدون رمزنگاری سرتاسری</Text>
        </View>
      </View>

      <ConnChip state={connection} colors={colors} />
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      <View style={styles.stage}>
        {isGroup ? (
          <View style={styles.grid}>
            {participants.map((participant) => {
              const isLocal = participant.identity === localIdentity;
              return (
                <ParticipantTile
                  key={participant.sid || participant.identity}
                  participant={participant}
                  isLocal={isLocal}
                  currentUser={currentUser}
                  trackRef={isLocal ? localTrack : cameraByIdentity.get(participant.identity)}
                  micOn={isLocal ? isMicrophoneEnabled : participant.isMicrophoneEnabled !== false}
                  colors={colors}
                />
              );
            })}
            {remoteParticipants.length === 0 && (
              <Text style={styles.waiting}>در انتظار پیوستن اعضا…</Text>
            )}
          </View>
        ) : (
          <>
            <View style={styles.remote}>
              {remoteTrack ? (
                <VideoTile trackRef={remoteTrack} style={StyleSheet.absoluteFill} />
              ) : (
                <View style={styles.remoteEmpty}>
                  <Avatar name={remote?.name || call.info?.peer?.name} size={104} />
                  <Text style={styles.remoteEmptyText}>
                    {remote ? 'دوربین خاموش است' : 'در انتظار اتصال طرف مقابل…'}
                  </Text>
                </View>
              )}
              {remote?.name ? (
                <View style={styles.remoteName}>
                  <Text style={styles.remoteNameText}>{remote.name}</Text>
                </View>
              ) : null}
            </View>
            <View style={styles.localPip}>
              {localTrack ? (
                <VideoTile trackRef={localTrack} style={StyleSheet.absoluteFill} mirror zOrder={1} />
              ) : (
                <View style={styles.localPipEmpty}>
                  <Avatar name={currentUser?.name} size={40} />
                </View>
              )}
            </View>
          </>
        )}
      </View>

      <View style={[styles.controls, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
        <Pressable
          onPress={toggleMic}
          accessibilityRole="button"
          accessibilityLabel={isMicrophoneEnabled ? 'قطع میکروفون' : 'روشن‌کردن میکروفون'}
          style={[styles.ctrl, !isMicrophoneEnabled && styles.ctrlOff]}
        >
          <FontAwesome6 name={isMicrophoneEnabled ? 'microphone' : 'microphone-slash'} size={22} color="#fff" />
          <Text style={styles.ctrlLabel}>میکروفون</Text>
        </Pressable>

        <Pressable
          onPress={toggleCamera}
          accessibilityRole="button"
          accessibilityLabel={isCameraEnabled ? 'خاموش‌کردن دوربین' : 'روشن‌کردن دوربین'}
          style={[styles.ctrl, !isCameraEnabled && styles.ctrlOff]}
        >
          <FontAwesome6 name={isCameraEnabled ? 'video' : 'video-slash'} size={22} color="#fff" />
          <Text style={styles.ctrlLabel}>دوربین</Text>
        </Pressable>

        <Pressable
          onPress={onEnd}
          accessibilityRole="button"
          accessibilityLabel="پایان تماس"
          style={[styles.ctrl, styles.ctrlEnd]}
        >
          <FontAwesome6 name="phone-slash" size={22} color="#fff" />
          <Text style={styles.ctrlLabel}>پایان</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function CallRoom({ call, currentUser }) {
  const { colors } = useAppTheme();
  const [ready, setReady] = useState(Platform.OS !== 'android');
  const [permissionError, setPermissionError] = useState('');
  const endingRef = useRef(false);
  const failedRef = useRef(false);
  const phaseRef = useRef(call.phase);
  const video = call.info?.type === 'video';

  function failRoom(text) {
    if (endingRef.current || failedRef.current) return;
    failedRef.current = true;
    call.fail(text);
  }

  useEffect(() => { phaseRef.current = call.phase; }, [call.phase]);

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    let active = true;
    (async () => {
      try {
        const permissions = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
        if (video) permissions.push(PermissionsAndroid.PERMISSIONS.CAMERA);
        const results = await Promise.all(permissions.map((permission) => PermissionsAndroid.request(permission)));
        if (!active) return;
        if (results.every((result) => result === PermissionsAndroid.RESULTS.GRANTED)) {
          setReady(true);
        } else {
          setPermissionError('دسترسی به میکروفون یا دوربین داده نشد');
        }
      } catch {
        if (active) setPermissionError('درخواست دسترسی به میکروفون یا دوربین ناموفق بود');
      }
    })();
    return () => { active = false; };
  }, [video]);

  useEffect(() => {
    if (!permissionError || failedRef.current) return;
    failedRef.current = true;
    call.fail(permissionError);
  }, [permissionError, call]);

  useEffect(() => {
    AudioSession.startAudioSession().catch(() => {});
    return () => { AudioSession.stopAudioSession().catch(() => {}); };
  }, []);

  function handleEnd() {
    endingRef.current = true;
    call.hangUp();
  }
  if (!ready) {
    return (
      <Centered colors={colors}>
        <ActivityIndicator color={colors.accent} />
        <Text style={[styles.loadingText, { color: colors.text2 }]}>در حال گرفتن دسترسی دوربین و میکروفون…</Text>
      </Centered>
    );
  }

  if (!call.token || !call.url) {
    return (
      <Centered colors={colors}>
        <ActivityIndicator color={colors.accent} />
      </Centered>
    );
  }

  return (
    <LiveKitRoom
      serverUrl={call.url}
      token={call.token}
      connect
      audio
      video={video}
      options={{ adaptiveStream: true, dynacast: true }}
      onDisconnected={() => {
        if (!endingRef.current && phaseRef.current === 'active') {
          failRoom('اتصال تماس قطع شد');
        }
      }}
      onMediaDeviceFailure={() => failRoom('دسترسی به دوربین یا میکروفون ممکن نشد')}
      onError={(error) => failRoom(error?.message ?? 'برقراری تماس ناموفق بود')}
      onEncryptionError={() => failRoom('رمزنگاری رسانه با خطا مواجه شد')}
    >
      <CallUI
        call={call}
        currentUser={currentUser}
        video={video}
        onEnd={handleEnd}
      />
    </LiveKitRoom>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  loadingText: { fontFamily: fonts.regular, fontSize: type.base, writingDirection: 'rtl' },
  screen: { flex: 1 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  headText: { flex: 1, minWidth: 0 },
  headTitle: {
    fontFamily: fonts.bold,
    fontSize: type.md,
    color: '#F2EEE6',
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  headSub: {
    fontFamily: fonts.regular,
    fontSize: type.xs,
    color: 'rgba(242,238,230,0.6)',
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  encChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  encText: {
    fontFamily: fonts.medium,
    fontSize: 10,
    color: 'rgba(255,255,255,0.72)',
    writingDirection: 'rtl',
  },
  connChip: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    marginBottom: spacing.xs,
  },
  connText: { fontFamily: fonts.medium, fontSize: type.xs, writingDirection: 'rtl' },
  notice: {
    alignSelf: 'center',
    color: '#FFC95A',
    fontFamily: fonts.regular,
    fontSize: type.xs,
    marginBottom: spacing.xs,
    writingDirection: 'rtl',
  },
  stage: { flex: 1, marginHorizontal: spacing.sm, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: '#0b0c11' },
  remote: { flex: 1 },
  remoteEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  remoteEmptyText: {
    color: 'rgba(242,238,230,0.65)',
    fontFamily: fonts.regular,
    fontSize: type.sm,
    writingDirection: 'rtl',
  },
  remoteName: {
    position: 'absolute',
    bottom: spacing.md,
    right: spacing.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  remoteNameText: { color: '#fff', fontFamily: fonts.medium, fontSize: type.xs, writingDirection: 'rtl' },
  localPip: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    width: 96,
    height: 132,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: '#151821',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  localPipEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  grid: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignContent: 'center',
    padding: spacing.sm,
    gap: spacing.sm,
  },
  tile: {
    width: '48%',
    aspectRatio: 3 / 4,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: '#151821',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  tileAvatar: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tileFooter: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  tileName: {
    flex: 1,
    color: '#fff',
    fontFamily: fonts.medium,
    fontSize: type.xs,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  waiting: {
    width: '100%',
    textAlign: 'center',
    color: 'rgba(242,238,230,0.65)',
    fontFamily: fonts.regular,
    fontSize: type.sm,
    writingDirection: 'rtl',
    paddingVertical: spacing.xl,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    backgroundColor: '#08090d',
  },
  ctrl: {
    minWidth: 82,
    height: 58,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  ctrlOff: { backgroundColor: 'rgba(197,22,29,0.28)', borderColor: 'rgba(197,22,29,0.45)' },
  ctrlEnd: { backgroundColor: '#C5161D', borderColor: 'transparent', minWidth: 92 },
  ctrlLabel: { color: 'rgba(255,255,255,0.85)', fontFamily: fonts.medium, fontSize: 10, writingDirection: 'rtl' },
});
