import { useEffect, useRef } from 'react';
import { Track } from 'livekit-client';
import Avatar from '../ui/Avatar.jsx';
import './Call.css';

const ENC = {
  none:     { icon: 'fa-lock-open', text: 'بدون رمزنگاری سرتاسری', className: 'is-off', title: 'این تماس فقط با رمزنگاری لایهٔ انتقال محافظت می‌شود؛ سرور رسانه می‌تواند آن را ببیند' },
  pending:  { icon: 'fa-lock', text: 'در انتظار تأیید رمزنگاری', className: 'is-pending', title: 'کلید روی دستگاه‌ها ساخته شده است؛ تا تأیید هر دو طرف، نشان تأییدشده نمایش داده نمی‌شود' },
  verified: { icon: 'fa-lock', text: 'رمزنگاری سرتاسری', className: 'is-on', title: 'رسانه روی دستگاه‌ها رمز و رمزگشایی می‌شود؛ سرور رسانه کلید ندارد' },
  failed:   { icon: 'fa-triangle-exclamation', text: 'رمزنگاری تأیید نشد', className: 'is-failed', title: 'تماس به دلیل عدم تأیید رمزنگاری بسته شد' },
};

function CallLock({ state }) {
  const item = ENC[state] ?? ENC.none;
  return (
    <span className={`call-lock ${item.className}`} title={item.title} aria-label={item.text}>
      <i className={`fas ${item.icon}`} aria-hidden="true" />
      <span className="call-lock-text">{item.text}</span>
    </span>
  );
}

function CallLockFor(call) {
  return <CallLock state={call.callInfo?.e2ee ? call.encryptionState : 'none'} />;
}

function CallBackdrop({ avatar }) {
  return (
    <div className="call-backdrop" aria-hidden="true">
      {avatar
        ? <div className="call-backdrop-image" style={{ backgroundImage: `url("${avatar}")` }} />
        : <div className="call-backdrop-fallback" />}
      <div className="call-veil" />
    </div>
  );
}

function CameraSurface({ track, muted = false, local = false, screen = false, name, avatar }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !track) return undefined;
    track.attach(element);
    return () => { track.detach(element); };
  }, [track]);

  return (
    <div className={`call-video-surface ${screen ? 'is-screen' : ''}`}>
      {track ? (
        <video
          ref={videoRef}
          className={`${local && !screen ? 'is-local-mirror' : ''} ${screen ? 'is-contain' : ''}`}
          autoPlay
          playsInline
          muted={muted}
        />
      ) : (
        <div className="call-video-empty">
          <Avatar src={avatar} name={name} size={88} />
        </div>
      )}
    </div>
  );
}

function AudioElement({ track }) {
  const ref = useRef(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || !track) return undefined;
    track.attach(element);
    return () => { track.detach(element); };
  }, [track]);
  return <audio ref={ref} autoPlay playsInline />;
}

function RemoteAudio({ room }) {
  if (!room) return null;
  const tracks = [];
  for (const participant of room.remoteParticipants.values()) {
    const microphone = participant.getTrackPublication(Track.Source.Microphone);
    if (microphone?.track && !microphone.isMuted) {
      tracks.push({ key: `${participant.sid}-mic`, track: microphone.track });
    }
    const shared = participant.getTrackPublication(Track.Source.ScreenShareAudio);
    if (shared?.track && !shared.isMuted) {
      tracks.push({ key: `${participant.sid}-screen`, track: shared.track });
    }
  }
  return (
    <div className="call-audio-sink" aria-hidden="true">
      {tracks.map(({ key, track }) => <AudioElement key={key} track={track} />)}
    </div>
  );
}

function cameraTrack(participant) {
  const publication = participant?.getTrackPublication(Track.Source.Camera);
  return publication && !publication.isMuted ? publication.track : undefined;
}

function screenTrack(participant) {
  const publication = participant?.getTrackPublication(Track.Source.ScreenShare);
  return publication && !publication.isMuted ? publication.track : undefined;
}

function isMuted(participant) {
  return Boolean(participant?.getTrackPublication(Track.Source.Microphone)?.isMuted);
}

function ParticipantTile({ participant, local, currentUser, active, micOn }) {
  const name = local ? (currentUser?.name ?? 'شما') : (participant?.name || participant?.identity || 'کاربر');
  const track = cameraTrack(participant);
  const muted = local ? !micOn : isMuted(participant);

  return (
    <div className={`call-tile ${active ? 'is-speaking' : ''}`}>
      <CameraSurface
        track={track}
        muted={local}
        local={local}
        name={name}
        avatar={local ? currentUser?.avatar : undefined}
      />
      <div className="call-tile-shade" />
      <div className="call-tile-footer">
        <span className="call-tile-name" title={name}>{name}{local ? ' (شما)' : ''}</span>
        {muted && <i className="fas fa-microphone-slash call-tile-muted" aria-label="میکروفون بسته است" />}
      </div>
    </div>
  );
}

/* ── Ringing screens ─────────────────────────────────────────── */

function RingScreen({ title, avatar, isGroup, subtitle, children }) {
  return (
    <div className="call-screen">
      <div className="call-hero">
        <span className="call-pulse" aria-hidden="true" />
        <span className="call-pulse is-late" aria-hidden="true" />
        <Avatar src={avatar} name={title} size={128} group={isGroup} />
      </div>
      <div className="call-identity">
        <h2 id="call-title" className="call-name">{title}</h2>
        {subtitle}
      </div>
      {children}
    </div>
  );
}

function Incoming({ call, title, avatar, isGroup, callType, callerName }) {
  const acceptRef = useRef(null);
  useEffect(() => {
    if (call.keyReady) acceptRef.current?.focus();
  }, [call.keyReady]);

  const waitingForKey = call.callInfo?.e2ee && !call.keyReady;
  const accepting = call.busy;
  const acceptIcon = callType === 'video' ? 'fa-video' : 'fa-phone';

  return (
    <RingScreen
      title={title}
      avatar={avatar}
      isGroup={isGroup}
      subtitle={(
        <>
          {callerName && isGroup && <span className="call-from">{callerName}</span>}
          <p className="call-status">
            {waitingForKey ? 'در حال آماده‌سازی رمزنگاری…' : `تماس ${callType === 'video' ? 'ویدیویی' : 'صوتی'} ورودی`}
          </p>
          <CallLockFor call={call} />
        </>
      )}
    >
      <div className="call-decision">
        <button
          type="button"
          className="call-round call-round-reject"
          onClick={() => call.rejectCall()}
          aria-label="رد تماس"
          title="رد تماس"
        >
          <i className="fas fa-phone-slash" aria-hidden="true" />
        </button>
        <button
          ref={acceptRef}
          type="button"
          className="call-round call-round-accept"
          onClick={() => call.acceptCall()}
          disabled={accepting || waitingForKey}
          aria-label="پاسخ به تماس"
          title="پاسخ به تماس"
        >
          {accepting || waitingForKey
            ? <span className="call-spinner" aria-hidden="true" />
            : <i className={`fas ${acceptIcon}`} aria-hidden="true" />}
        </button>
      </div>
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
          <p className="call-status">
            <span className="call-spinner" aria-hidden="true" />
            در حال زنگ زدن
          </p>
          <span className="call-type">{callType === 'video' ? 'تماس ویدیویی' : 'تماس صوتی'}</span>
          <CallLockFor call={call} />
        </>
      )}
    >
      <div className="call-decision is-single">
        <button
          type="button"
          className="call-round call-round-reject"
          onClick={() => call.cancelCall()}
          aria-label="لغو تماس"
          title="لغو تماس"
        >
          <i className="fas fa-phone-slash" aria-hidden="true" />
        </button>
      </div>
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
          <p className="call-status">
            <span className="call-spinner" aria-hidden="true" />
            در حال آماده‌سازی…
          </p>
          <CallLockFor call={call} />
        </>
      )}
    >
      <div className="call-decision is-single">
        <button
          type="button"
          className="call-round call-round-reject"
          onClick={() => call.cancelCall()}
          aria-label="انصراف از تماس"
          title="انصراف از تماس"
        >
          <i className="fas fa-xmark" aria-hidden="true" />
        </button>
      </div>
    </RingScreen>
  );
}

/* ── Active call ─────────────────────────────────────────────── */

function Controls({ call, connecting }) {
  const canShareScreen = typeof navigator !== 'undefined'
    && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

  return (
    <div className="call-dock">
      <div className="call-dock-inner">
        <button
          type="button"
          className={`call-round ${call.micOn ? '' : 'is-off'}`}
          onClick={() => call.toggleMic()}
          aria-pressed={call.micOn}
          aria-label={call.micOn ? 'قطع میکروفون' : 'روشن‌کردن میکروفون'}
          title={call.micOn ? 'قطع میکروفون' : 'روشن‌کردن میکروفون'}
        >
          <i className={`fas fa-${call.micOn ? 'microphone' : 'microphone-slash'}`} aria-hidden="true" />
        </button>

        <button
          type="button"
          className={`call-round ${call.camOn ? '' : 'is-off'}`}
          onClick={() => call.toggleCam()}
          aria-pressed={call.camOn}
          aria-label={call.camOn ? 'خاموش‌کردن دوربین' : 'روشن‌کردن دوربین'}
          title={call.camOn ? 'خاموش‌کردن دوربین' : 'روشن‌کردن دوربین'}
        >
          <i className={`fas fa-${call.camOn ? 'video' : 'video-slash'}`} aria-hidden="true" />
        </button>

        {canShareScreen && (
          <button
            type="button"
            className={`call-round ${call.screenOn ? 'is-active' : ''}`}
            onClick={() => call.toggleScreen()}
            aria-pressed={call.screenOn}
            aria-label={call.screenOn ? 'پایان اشتراک صفحه' : 'اشتراک صفحه'}
            title={call.screenOn ? 'پایان اشتراک صفحه' : 'اشتراک صفحه'}
          >
            <i className="fas fa-display" aria-hidden="true" />
          </button>
        )}

        <button
          type="button"
          className="call-round call-round-end"
          onClick={() => call.hangUp()}
          disabled={connecting && !call.room}
          aria-label="پایان تماس"
          title="پایان تماس"
        >
          <i className="fas fa-phone-slash" aria-hidden="true" />
        </button>
      </div>

      {call.audioDevices.length > 1 && (
        <label className="call-audio-pill">
          <i className="fas fa-volume-high" aria-hidden="true" />
          <span className="sr-only">خروجی صدا</span>
          <select
            value={call.activeAudioDevice}
            onChange={(event) => call.switchAudioDevice(event.target.value)}
            aria-label="خروجی صدا"
          >
            {call.audioDevices.map((device, index) => (
              <option key={device.deviceId || index} value={device.deviceId}>
                {device.label || `خروجی ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

function AudioView({ peer, group, avatar, status }) {
  return (
    <div className="call-audio-view">
      <Avatar src={avatar} name={peer?.name || group?.name || 'تماس'} size={156} group={!peer} />
      <span className="call-audio-status">{status}</span>
    </div>
  );
}

function DirectStage({ call, currentUser }) {
  const room = call.room;
  if (!room) {
    return <AudioView peer={call.peer} avatar={call.peer?.avatar} status="در انتظار اتصال…" />;
  }

  const remotes = [...room.remoteParticipants.values()];
  const remote = remotes[0];
  const local = room.localParticipant;
  const remoteScreen = remote ? screenTrack(remote) : undefined;
  const localScreen = screenTrack(local);
  const shared = remoteScreen || localScreen;
  const sharedByMe = Boolean(localScreen);
  const remoteCamera = remote ? cameraTrack(remote) : undefined;
  const localCamera = cameraTrack(local);

  return (
    <div className="call-direct-stage">
      {shared ? (
        <div className="call-share-stage">
          <CameraSurface track={shared} screen name={sharedByMe ? currentUser?.name : (remote?.name || 'طرف مقابل')} />
          <span className="call-share-label">
            <i className="fas fa-display" aria-hidden="true" />
            {sharedByMe ? 'صفحهٔ شما' : `صفحهٔ ${remote?.name || 'طرف مقابل'}`}
          </span>
          {remote && !sharedByMe && (
            <div className="call-small-remote">
              <CameraSurface track={cameraTrack(remote)} muted={false} name={remote.name || 'طرف مقابل'} />
            </div>
          )}
        </div>
      ) : remoteCamera ? (
        <div className="call-remote-full">
          <CameraSurface track={remoteCamera} name={remote.name || 'طرف مقابل'} />
        </div>
      ) : (
        <AudioView
          peer={remote ? { name: remote.name } : call.peer}
          avatar={call.peer?.avatar}
          status={remote
            ? (call.callInfo?.type === 'video' ? 'دوربین خاموش است' : 'در حال تماس')
            : 'در انتظار اتصال…'}
        />
      )}

      {localCamera && (
        <div className="call-pip">
          <CameraSurface track={localCamera} muted local name={currentUser?.name} avatar={currentUser?.avatar} />
        </div>
      )}
    </div>
  );
}

function GroupStage({ call, currentUser }) {
  const room = call.room;
  if (!room) {
    return <AudioView group={call.group} avatar={call.group?.avatar} status="در انتظار اتصال…" />;
  }

  const remotes = [...room.remoteParticipants.values()];
  const local = room.localParticipant;
  const share = [...remotes, local]
    .map((participant) => ({ participant, track: screenTrack(participant) }))
    .find((entry) => entry.track);
  const tiles = [
    ...remotes.map((participant) => ({ participant, local: false })),
    { participant: local, local: true },
  ];

  return (
    <div className={`call-grid ${tiles.length > 4 ? 'is-dense' : ''}`}>
      {share && (
        <div className="call-tile call-tile-share">
          <CameraSurface
            track={share.track}
            screen
            name={share.participant === local ? currentUser?.name : share.participant.name}
          />
          <div className="call-tile-shade" />
          <div className="call-tile-footer">
            <span className="call-tile-name">
              <i className="fas fa-display" aria-hidden="true" />
              {' '}
              {share.participant === local ? 'صفحهٔ شما' : `صفحهٔ ${share.participant.name || 'یک عضو'}`}
            </span>
          </div>
        </div>
      )}
      {tiles.map(({ participant, local: isLocal }) => (
        <ParticipantTile
          key={participant.sid || participant.identity}
          participant={participant}
          local={isLocal}
          currentUser={currentUser}
          active={Boolean(participant.isSpeaking)}
          micOn={call.micOn}
        />
      ))}
      {!remotes.length && (
        <p className="call-grid-hint">
          <span className="call-spinner" aria-hidden="true" />
          در انتظار پیوستن اعضا…
        </p>
      )}
    </div>
  );
}

function Active({ call, currentUser, connecting }) {
  const room = call.room;
  const isGroup = call.callInfo?.kind === 'group';
  const title = (isGroup ? call.group?.name : call.peer?.name) || 'تماس';
  const reconnecting = call.connectionState === 'reconnecting';

  return (
    <div className="call-active">
      <div className="call-stage">
        {isGroup
          ? <GroupStage call={call} currentUser={currentUser} />
          : <DirectStage call={call} currentUser={currentUser} />}
      </div>

      <header className="call-top">
        <div className="call-top-text">
          <h2 id="call-title" className="call-top-name">{title}</h2>
          <div className="call-top-sub">
            {call.phase === 'active' ? <span className="call-timer">{call.timerLabel}</span> : <span>در حال اتصال…</span>}
            <CallLockFor call={call} />
          </div>
        </div>
      </header>

      {reconnecting && (
        <div className="call-reconnect" role="status">
          <i className="fas fa-wifi" aria-hidden="true" />
          اتصال دوباره برقرار می‌شود…
        </div>
      )}

      {room && !room.canPlaybackAudio && (
        <button type="button" className="call-audio-unlock" onClick={() => call.startAudio()}>
          <i className="fas fa-volume-high" aria-hidden="true" />
          پخش صدا را فعال کنید
        </button>
      )}

      <Controls call={call} connecting={connecting} />
    </div>
  );
}

function Ended({ call, title, avatar, isGroup }) {
  return (
    <div className="call-screen call-ended">
      <Avatar src={avatar} name={title} size={96} group={isGroup} />
      <h2 id="call-title" className="call-name">{title}</h2>
      <p className={`call-ended-text ${call.error ? 'is-error' : ''}`} role="status">
        {call.error || call.notice || 'تماس پایان یافت'}
      </p>
      <button type="button" className="call-text-btn" onClick={() => call.dismiss()} aria-label="بستن">
        بستن
      </button>
    </div>
  );
}

export default function CallLayer({ call, currentUser }) {
  const phase = call.phase;
  const info = call.callInfo;
  const isGroup = info?.kind === 'group';
  const title = (isGroup ? call.group?.name : call.peer?.name) || 'تماس';
  const avatar = isGroup ? call.group?.avatar : call.peer?.avatar;
  const callType = info?.type ?? 'audio';
  const callerName = info?.peer?.name ?? info?.from?.name ?? null;
  const open = phase !== 'idle';

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  useEffect(() => {
    if (phase !== 'incoming' && phase !== 'outgoing') return undefined;
    function onKeyDown(event) {
      if (event.key !== 'Escape') return;
      if (phase === 'incoming') call.rejectCall();
      else call.cancelCall();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [phase, call]);

  if (!open) return null;

  return (
    <div className="call-layer" role="dialog" aria-modal="true" aria-labelledby="call-title">
      <CallBackdrop avatar={avatar} />
      <RemoteAudio room={call.room} />
      {open && (call.error || call.notice) && phase !== 'ended' && (
        <div className={`call-toast ${call.error ? 'is-error' : ''}`} role="status" aria-live="polite">
          {call.error || call.notice}
        </div>
      )}

      {phase === 'preparing' && (
        <Preparing call={call} title={title} avatar={avatar} isGroup={isGroup} />
      )}
      {phase === 'incoming' && (
        <Incoming
          call={call}
          title={title}
          avatar={avatar}
          isGroup={isGroup}
          callType={callType}
          callerName={callerName}
        />
      )}
      {phase === 'outgoing' && (
        <Outgoing call={call} title={title} avatar={avatar} isGroup={isGroup} callType={callType} />
      )}
      {(phase === 'connecting' || phase === 'active') && (
        <Active call={call} currentUser={currentUser} connecting={phase === 'connecting'} />
      )}
      {phase === 'ended' && (
        <Ended call={call} title={title} avatar={avatar} isGroup={isGroup} />
      )}
    </div>
  );
}
