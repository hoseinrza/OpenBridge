import { useEffect, useRef } from 'react';
import { useVideo } from '../../hooks/useVideo.js';
import Sidebar from '../Sidebar/Sidebar.jsx';
import './VideoCall.css';

export default function VideoCallPage({ currentUser, onLogout }) {
  const videoRef       = useRef(null);
  const placeholderRef = useRef(null);

  const {
    micOn, camOn, screenOn, timerLabel,
    startCamera, toggleMic, toggleCam, toggleScreen, cleanup,
  } = useVideo();

  useEffect(() => {
    startCamera(videoRef.current, placeholderRef.current);
    return () => cleanup();
  }, [startCamera, cleanup]);

  return (
    <div className="app-layout detail-open">
      <Sidebar
        users={[]}
        activeUserId={null}
        currentUser={currentUser}
        onLogout={onLogout}
        page="video"
      />

      <div className="video-main">
        <div className="video-top-bar">
          <span className="room-label">
            <i className="fas fa-video" /> تماس ویدیویی — ChatRoom
          </span>
          <span className="call-timer">{timerLabel}</span>
        </div>

        <div className="video-grid">
          <div className="video-tile self-tile">
            <video ref={videoRef} autoPlay muted playsInline />
            <div className="video-placeholder active" ref={placeholderRef}>
              <img src={currentUser.avatar} alt="" />
              <span>دوربین خاموش است</span>
            </div>
            <div className="video-name-tag">{currentUser.name} (شما)</div>
          </div>
        </div>

        <div className="video-controls">
          <button
            className={`ctrl-btn ${micOn ? '' : 'off'}`}
            onClick={() => toggleMic()}
          >
            <i className={`fas fa-${micOn ? 'microphone' : 'microphone-slash'}`} />
            <span>میکروفون</span>
          </button>

          <button
            className={`ctrl-btn ${camOn ? '' : 'off'}`}
            onClick={() => toggleCam(placeholderRef.current)}
          >
            <i className={`fas fa-${camOn ? 'video' : 'video-slash'}`} />
            <span>دوربین</span>
          </button>

          <button
            className={`ctrl-btn ${screenOn ? 'off' : ''}`}
            onClick={() => toggleScreen(videoRef.current, placeholderRef.current)}
          >
            <i className="fas fa-display" />
            <span>صفحه‌نمایش</span>
          </button>

          <a href="/" className="ctrl-btn end-btn">
            <i className="fas fa-phone-slash" />
            <span>پایان تماس</span>
          </a>
        </div>
      </div>
    </div>
  );
}
