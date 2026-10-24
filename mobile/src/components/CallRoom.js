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
import { fonts, type } from '../theme';

// Must run before any LiveKit object uses WebRTC.
registerGlobals();

function Centered({ children }) {
  return <View style={styles.centered}>{children}</View>;
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

function LockNote({ e2ee }) {
  return (
    <View style={styles.lock}>
      <FontAwesome6
        name={e2ee ? 'lock' : 'lock-open'}
        size={9}
        color={e2ee ? '#9fe7b5' : 'rgba(255,255,255,0.55)'}
      />
      <Text style={[styles.lockText, e2ee && styles.lockTextOn]}>
        {e2ee ? 'رمزنگاری' : 'بدون رمزنگاری'}
      </Text>
    </View>
  );
}

function ConnChip({ state }) {
  const reconnecting = state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting;
  if (!reconnecting) return null;
  return (
    <View style={styles.conn}>
      <ActivityIndicator size="small" color="#fff" />
      <Text style={styles.connText}>اتصال دوباره…</Text>
    </View>
  );
}

function ControlButton({ icon, label, onPress, off = false, end = false, size = 56 }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.ctrl,
        { width: size, height: size, borderRadius: size / 2 },
        off && styles.ctrlOff,
        end && styles.ctrlEnd,
        pressed && styles.ctrlPressed,
      ]}
    >
      <FontAwesome6 name={icon} size={Math.round(size * 0.34)} color={off ? '#111' : '#fff'} />
    </Pressable>
  );
}

function ParticipantTile({ participant, isLocal, currentUser, trackRef, micOn }) {
  const name = isLocal ? (currentUser?.name ?? 'شما') : (participant?.name || participant?.identity || 'کاربر');
  const muted = isLocal ? !micOn : participant?.isMicrophoneEnabled === false;

  return (
    <View style={[styles.tile, participant?.isSpeaking && styles.tileSpeaking]}>
      {trackRef ? (
        <VideoTile
          trackRef={trackRef}
          style={StyleSheet.absoluteFill}
          mirror={isLocal}
          zOrder={isLocal ? 1 : 0}
        />
      ) : (
        <View style={styles.tileAvatar}>
          <Avatar
            uri={isLocal ? currentUser?.avatar : undefined}
            name={name}
            size={64}
          />
        </View>
      )}
      <View style={styles.tileShade} />
      <View style={styles.tileFooter}>
        <Text style={styles.tileName} numberOfLines={1}>
          {name}{isLocal ? ' (شما)' : ''}
        </Text>
        {muted && <FontAwesome6 name="microphone-slash" size={10} color="#ff8a85" />}
      </View>
    </View>
  );
}

function AudioView({ avatar, name, status, size = 150 }) {
  return (
    <View style={styles.audioView}>
      <Avatar uri={avatar} name={name} size={size} />
      <Text style={styles.audioStatus}>{status}</Text>
    </View>
  );
}

function CallUI({ call, currentUser, onEnd }) {
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
    if (!notice) return undefined;
    const id = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(id);
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
    <View style={styles.screen}>
      <View style={[styles.top, { paddingTop: insets.top + 10 }]}>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        <View style={styles.subRow}>
          <Text style={styles.timer}>{connected ? timer : 'در حال اتصال…'}</Text>
          <LockNote e2ee={call.info?.e2ee === true} />
        </View>
      </View>

      <ConnChip state={connection} />
      {notice ? <Text style={[styles.notice, { top: insets.top + 92 }]}>{notice}</Text> : null}

      <View style={styles.stage}>
        {isGroup ? (
          <View style={[styles.grid, { top: insets.top + 70, bottom: insets.bottom + 98 }]}>
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
                />
              );
            })}
            {!remoteParticipants.length && (
              <Text style={styles.gridHint}>در انتظار پیوستن اعضا…</Text>
            )}
          </View>
        ) : (
          <>
            {remoteTrack ? (
              <VideoTile trackRef={remoteTrack} style={StyleSheet.absoluteFill} />
            ) : (
              <AudioView
                avatar={call.info?.peer?.avatar}
                name={remote?.name || call.info?.peer?.name || 'طرف مقابل'}
                status={remote
                  ? (call.info?.type === 'video' ? 'دوربین خاموش است' : 'در حال تماس')
                  : 'در انتظار اتصال…'}
              />
            )}
            {localTrack && (
              <View style={[styles.pip, { top: insets.top + 70 }]}>
                <VideoTile trackRef={localTrack} style={StyleSheet.absoluteFill} mirror zOrder={1} />
              </View>
            )}
          </>
        )}
      </View>

      <View style={[styles.controls, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.controlsRow}>
          <ControlButton
            icon={isMicrophoneEnabled ? 'microphone' : 'microphone-slash'}
            label={isMicrophoneEnabled ? 'قطع میکروفون' : 'روشن‌کردن میکروفون'}
            onPress={toggleMic}
            off={!isMicrophoneEnabled}
          />
          <ControlButton
            icon={isCameraEnabled ? 'video' : 'video-slash'}
            label={isCameraEnabled ? 'خاموش‌کردن دوربین' : 'روشن‌کردن دوربین'}
            onPress={toggleCamera}
            off={!isCameraEnabled}
          />
          <ControlButton
            icon="phone-slash"
            label="پایان تماس"
            onPress={onEnd}
            end
            size={60}
          />
        </View>
      </View>
    </View>
  );
}

export default function CallRoom({ call, currentUser }) {
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
      <Centered>
        <ActivityIndicator color="#fff" />
        <Text style={styles.loadingText}>در حال گرفتن دسترسی دوربین و میکروفون…</Text>
      </Centered>
    );
  }

  if (!call.token || !call.url) {
    return (
      <Centered>
        <ActivityIndicator color="#fff" />
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
      <CallUI call={call} currentUser={currentUser} onEnd={handleEnd} />
    </LiveKitRoom>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: '#050608',
  },
  loadingText: {
    color: 'rgba(255,255,255,0.7)',
    fontFamily: fonts.regular,
    fontSize: type.base,
    writingDirection: 'rtl',
  },
  screen: { flex: 1, backgroundColor: 'transparent' },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 4,
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 16,
    backgroundColor: 'rgba(0,0,0,0.28)',
  },
  title: {
    maxWidth: '86%',
    color: '#fff',
    fontFamily: fonts.semibold,
    fontSize: 16,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  timer: {
    color: 'rgba(255,255,255,0.7)',
    fontFamily: fonts.medium,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  lock: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  lockText: {
    color: 'rgba(255,255,255,0.55)',
    fontFamily: fonts.medium,
    fontSize: 10,
    writingDirection: 'rtl',
  },
  lockTextOn: { color: '#9fe7b5' },
  conn: {
    position: 'absolute',
    top: 78,
    alignSelf: 'center',
    zIndex: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  connText: {
    color: 'rgba(255,255,255,0.82)',
    fontFamily: fonts.medium,
    fontSize: 11,
    writingDirection: 'rtl',
  },
  notice: {
    position: 'absolute',
    alignSelf: 'center',
    zIndex: 6,
    color: '#ffc95a',
    fontFamily: fonts.regular,
    fontSize: 11,
    writingDirection: 'rtl',
  },
  stage: { ...StyleSheet.absoluteFillObject },
  audioView: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingBottom: 80,
  },
  audioStatus: {
    color: 'rgba(255,255,255,0.6)',
    fontFamily: fonts.regular,
    fontSize: 13,
    writingDirection: 'rtl',
  },
  pip: {
    position: 'absolute',
    right: 12,
    width: 100,
    height: 140,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: '#111',
    zIndex: 3,
  },
  grid: {
    position: 'absolute',
    left: 6,
    right: 6,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignContent: 'center',
    justifyContent: 'space-between',
    rowGap: 6,
  },
  tile: {
    width: '48%',
    aspectRatio: 3 / 4,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#10131a',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  tileSpeaking: {
    borderColor: '#34c759',
    borderWidth: 2,
  },
  tileAvatar: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tileShade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '45%',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  tileFooter: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: 'rgba(0,0,0,0.38)',
  },
  tileName: {
    flex: 1,
    color: '#fff',
    fontFamily: fonts.medium,
    fontSize: 10,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  gridHint: {
    width: '100%',
    paddingVertical: 18,
    color: 'rgba(255,255,255,0.6)',
    fontFamily: fonts.regular,
    fontSize: 12,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  controls: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 5,
    paddingTop: 24,
    backgroundColor: 'rgba(0,0,0,0.34)',
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  ctrl: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  ctrlOff: {
    backgroundColor: '#fff',
    borderColor: '#fff',
  },
  ctrlEnd: {
    backgroundColor: '#ff3b30',
    borderColor: 'transparent',
  },
  ctrlPressed: { transform: [{ scale: 0.95 }] },
});
