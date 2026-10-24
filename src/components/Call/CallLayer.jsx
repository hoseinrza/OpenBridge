import { useEffect, useRef } from 'react';
import { Track } from 'livekit-client';
import Avatar from '../ui/Avatar.jsx';
import './Call.css';

const ENC = {
  none:     { icon: 'fa-lock-open', text: 'بدون رمزنگاری سرتاسری', className: 'is-off', title: 'این تماس فقط با رمزنگاری لایهٔ انتقال (DTLS-SRTP) محافظت می‌شود؛ سرور رسانه می‌تواند آن را ببیند' },
  pending:  { icon: 'fa-lock', text: 'رمزنگاری سرتاسری · در انتظار تأیید', className: 'is-pending', title: 'کلید روی دستگاه‌ها ساخته شده است؛ تا تأیید رمزنگاری هر دو طرف، نشان «تأییدشده» نمایش داده نمی‌شود' },
  verified: { icon: 'fa-lock', text: 'رمزنگاری سرتاسری', className: 'is-on', title: 'رسانه روی دستگاه‌ها رمز و رمزگشایی می‌شود؛ سرور رسانه کلید ندارد' },
  failed:   { icon: 'fa-triangle-exclamation', text: 'رمزنگاری تأیید نشد', className: 'is-failed', title: 'تماس به دلیل عدم تأیید رمزنگاری بسته شد' },
};

function EncryptionChip({ state }) {
  const item = ENC[state] ?? ENC.none;
  return (
    <span className={`call-enc ${item.className}`} title={item.title}>
      <i className={`fas ${item.icon}`} aria-hidden="true" />
      {item.text}
    </span>
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
          <Avatar src={avatar} name={name} size={72} />
        </div>
      )}
    </div>
  );
}

// LiveKit delivers remote audio as tracks; the SDK does not create an audio
// element for us. One hidden sink keeps every remote microphone and shared
// screen audio audible without a per-participant UI concern.
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

function Tile({ participant, local, currentUser, active, micOn }) {
  const name = local ? (currentUser?.name ?? 'شما') : (participant?.name || participant?.identity || 'کاربر');
  const track = cameraTrack(participant);
  const muted = local ? !micOn : isMuted(participant);
  const speaking = participant?.isSpeaking;

  return (
    <div className={`call-tile ${active ? 'is-speaking' : ''} ${speaking ? 'is-speaking' : ''}`}>
      <CameraSurface
        track={track}
        muted={local}
        local={local}
        name={name}
        avatar={local ? currentUser?.avatar : undefined}
      />
      <div className="call-tile-footer">
        <span className="call-tile-name" title={name}>{name}{local ? ' (شما)' : ''}</span>
        {muted && <i className="fas fa-microphone-slash call-tile-muted" aria-label="میکروفون بسته است" />}
      </div>
    </div>
  );
}

function EncryptionChipFor(call) {
  return <EncryptionChip state={call.callInfo?.e2ee ? call.encryptionState : 'none'} />;
}

function Preparing({ call, title, avatar, isGroup }) {
  return (
    <div className="call-center-card">
      <Avatar src={avatar} name={title} size={92} group={isGroup} />
      <h2 id="call-title" className="call-title">{title}</h2>
      <p className="call-subtitle"><span className="call-spinner" aria-hidden="true" /> در حال آماده‌سازی تماس…</p>
      <EncryptionChipFor call={call} />
      <div className="call-actions">
        <button
          type="button"
          className="call-btn call-btn-end"
          onClick={() => call.cancelCall()}
          aria-label="انصراف از تماس"
        >
          <i className="fas fa-xmark" aria-hidden="true" />
          <span>انصراف</span>
        </button>
      </div>
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

  return (
    <div className="call-center-card call-incoming">
      <div className="call-rings" aria-hidden="true">
        <span /><span /><span />
      </div>
      <Avatar src={avatar} name={title} size={104} group={isGroup} />
      <h2 id="call-title" className="call-title">{title}</h2>
      <p className="call-subtitle">
        {callerName && isGroup ? `${callerName} · ` : ''}
        تماس {callType === 'video' ? 'ویدیویی' : 'صوتی'} ورودی
      </p>
      <EncryptionChipFor call={call} />
      {waitingForKey && (
        <p className="call-hint" role="status">
          <span className="call-spinner" aria-hidden="true" /> در حال آماده‌سازی کلید رمزنگاری…
        </p>
      )}

      <div className="call-actions">
        <button
          type="button"
          className="call-btn call-btn-reject"
          onClick={() => call.rejectCall()}
          aria-label="رد تماس"
        >
          <i className="fas fa-phone-slash" aria-hidden="true" />
          <span>رد</span>
        </button>
        <button
          ref={acceptRef}
          type="button"
          className="call-btn call-btn-accept"
          onClick={() => call.acceptCall()}
          disabled={accepting || waitingForKey}
          aria-label="پاسخ به تماس"
        >
          {accepting
            ? <span className="call-spinner" aria-hidden="true" />
            : <i className="fas fa-phone" aria-hidden="true" />}
          <span>پاسخ</span>
        </button>
      </div>
    </div>
  );
}

function Outgoing({ call, title, avatar, isGroup, callType }) {
  return (
    <div className="call-center-card">
      <Avatar src={avatar} name={title} size={104} group={isGroup} />
      <h2 id="call-title" className="call-title">{title}</h2>
      <p className="call-subtitle">
        <span className="call-spinner" aria-hidden="true" />
        در حال زنگ زدن · تماس {callType === 'video' ? 'ویدیویی' : 'صوتی'}
      </p>
      <EncryptionChipFor call={call} />
      <div className="call-actions">
        <button
          type="button"
          className="call-btn call-btn-end"
          onClick={() => call.cancelCall()}
          aria-label="لغو تماس"
        >
          <i className="fas fa-phone-slash" aria-hidden="true" />
          <span>لغو</span>
        </button>
      </div>
    </div>
  );
}

function CallControls({ call, connecting }) {
  const canShareScreen = typeof navigator !== 'undefined'
    && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

  return (
    <div className="call-controls" role="toolbar" aria-label="کنترل‌های تماس">
      <button
        type="button"
        className={`call-ctrl ${call.micOn ? '' : 'is-off'}`}
        onClick={() => call.toggleMic()}
        aria-pressed={call.micOn}
        title={call.micOn ? 'قطع میکروفون' : 'روشن‌کردن میکروفون'}
      >
        <i className={`fas fa-${call.micOn ? 'microphone' : 'microphone-slash'}`} aria-hidden="true" />
        <span>میکروفون</span>
      </button>

      <button
        type="button"
        className={`call-ctrl ${call.camOn ? '' : 'is-off'}`}
        onClick={() => call.toggleCam()}
        aria-pressed={call.camOn}
        title={call.camOn ? 'خاموش‌کردن دوربین' : 'روشن‌کردن دوربین'}
      >
        <i className={`fas fa-${call.camOn ? 'video' : 'video-slash'}`} aria-hidden="true" />
        <span>دوربین</span>
      </button>

      {canShareScreen && (
        <button
          type="button"
          className={`call-ctrl ${call.screenOn ? 'is-on' : ''}`}
          onClick={() => call.toggleScreen()}
          aria-pressed={call.screenOn}
          title={call.screenOn ? 'پایان اشتراک صفحه' : 'اشتراک صفحه'}
        >
          <i className="fas fa-display" aria-hidden="true" />
          <span>صفحه</span>
        </button>
      )}

      {call.audioDevices.length > 1 && (
        <label className="call-device">
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

      <button
        type="button"
        className="call-ctrl call-ctrl-end"
        onClick={() => call.hangUp()}
        disabled={connecting && !call.room}
        aria-label="پایان تماس"
        title="پایان تماس"
      >
        <i className="fas fa-phone-slash" aria-hidden="true" />
        <span>پایان</span>
      </button>
    </div>
  );
}

function DirectStage({ call, currentUser }) {
  const room = call.room;
  if (!room) {
    const name = call.peer?.name || 'طرف مقابل';
    return (
      <div className="call-waiting">
        <Avatar src={call.peer?.avatar} name={name} size={104} />
        <p className="call-subtitle"><span className="call-spinner" aria-hidden="true" /> در انتظار اتصال…</p>
      </div>
    );
  }

  const remotes = [...room.remoteParticipants.values()];
  const remote = remotes[0];
  const local = room.localParticipant;
  const remoteScreen = remote ? screenTrack(remote) : undefined;
  const localScreen = screenTrack(local);
  const shared = remoteScreen || localScreen;
  const sharedByMe = Boolean(localScreen);

  return (
    <div className="call-stage-direct">
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
      ) : remote ? (
        <div className="call-remote-stage">
          <CameraSurface track={cameraTrack(remote)} name={remote.name || 'طرف مقابل'} />
          <div className="call-remote-name">
            {remote.name || 'طرف مقابل'}
            {isMuted(remote) && <i className="fas fa-microphone-slash" aria-label="میکروفون بسته است" />}
          </div>
        </div>
      ) : (
        <div className="call-waiting">
          <Avatar src={call.peer?.avatar} name={call.peer?.name || 'طرف مقابل'} size={104} />
          <p className="call-subtitle"><span className="call-spinner" aria-hidden="true" /> در انتظار اتصال…</p>
        </div>
      )}

      <div className="call-local-pip">
        <CameraSurface
          track={cameraTrack(local)}
          muted
          local
          name={currentUser?.name}
          avatar={currentUser?.avatar}
        />
        {!cameraTrack(local) && <span className="call-pip-label">دوربین خاموش است</span>}
      </div>
    </div>
  );
}

function GroupStage({ call, currentUser }) {
  const room = call.room;
  if (!room) {
    return (
      <div className="call-waiting">
        <Avatar src={call.group?.avatar} name={call.group?.name || 'گروه'} size={104} group />
        <p className="call-subtitle"><span className="call-spinner" aria-hidden="true" /> در انتظار اتصال…</p>
      </div>
    );
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
    <div className={`call-stage-grid count-${Math.min(tiles.length, 9)}`}>
      {share && (
        <div className="call-tile call-tile-screen">
          <CameraSurface
            track={share.track}
            screen
            name={share.participant === local ? currentUser?.name : share.participant.name}
          />
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
        <Tile
          key={participant.sid || participant.identity}
          participant={participant}
          local={isLocal}
          currentUser={currentUser}
          active={Boolean(participant.isSpeaking)}
          micOn={call.micOn}
        />
      ))}
      {remotes.length === 0 && (
        <p className="call-grid-hint"><span className="call-spinner" aria-hidden="true" /> در انتظار پیوستن اعضا…</p>
      )}
    </div>
  );
}

function Active({ call, currentUser, connecting }) {
  const room = call.room;
  const typeLabel = call.callInfo?.type === 'video' ? 'ویدیویی' : 'صوتی';
  const reconnecting = call.connectionState === 'reconnecting';

  return (
    <div className="call-active">
      <header className="call-active-head">
        <div className="call-active-title">
          <span className="call-active-kicker">تماس {typeLabel}</span>
          <h2 id="call-title" className="call-active-name">
            {call.group?.name || call.peer?.name || 'تماس'}
          </h2>
        </div>
        <div className="call-active-meta">
          {call.phase === 'active' && <span className="call-timer" aria-label="مدت تماس">{call.timerLabel}</span>}
          {connecting && <span className="call-timer">در حال اتصال…</span>}
          <EncryptionChipFor call={call} />
        </div>
      </header>

      {reconnecting && (
        <div className="call-reconnect" role="status">
          <i className="fas fa-wifi" aria-hidden="true" />
          اتصال دوباره برقرار می‌شود…
        </div>
      )}

      <div className="call-stage">
        {call.callInfo?.kind === 'group'
          ? <GroupStage call={call} currentUser={currentUser} />
          : <DirectStage call={call} currentUser={currentUser} />}
      </div>

      {room && !room.canPlaybackAudio && (
        <button type="button" className="call-audio-unlock" onClick={() => call.startAudio()}>
          <i className="fas fa-volume-high" aria-hidden="true" />
          پخش صدا را فعال کنید
        </button>
      )}

      <CallControls call={call} connecting={connecting} />
    </div>
  );
}

function Ended({ call, title, avatar, isGroup }) {
  return (
    <div className="call-center-card">
      <Avatar src={avatar} name={title} size={84} group={isGroup} />
      <h2 id="call-title" className="call-title">{title}</h2>
      <p className={`call-ended-text ${call.error ? 'is-error' : ''}`} role="status">
        {call.error || call.notice || 'تماس پایان یافت'}
      </p>
      <div className="call-actions">
        <button
          type="button"
          className="call-btn call-btn-secondary"
          onClick={() => call.dismiss()}
          aria-label="بستن"
        >
          <span>بستن</span>
        </button>
      </div>
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
