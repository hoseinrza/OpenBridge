import { useState, useRef, useCallback, useEffect } from 'react';

export function useVideo() {
  const [micOn,    setMicOn]    = useState(true);
  const [camOn,    setCamOn]    = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [seconds,  setSeconds]  = useState(0);

  const streamRef = useRef(null);

  // Timer
  useEffect(() => {
    const id = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const timerLabel = String(Math.floor(seconds / 60)).padStart(2, '0')
    + ':' + String(seconds % 60).padStart(2, '0');

  // Start camera
  const startCamera = useCallback(async (videoEl, placeholderEl) => {
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      videoEl.srcObject = streamRef.current;
      placeholderEl.classList.remove('active');
      setCamOn(true);
    } catch {
      placeholderEl.classList.add('active');
      setCamOn(false);
    }
  }, []);

  // Toggle mic
  const toggleMic = useCallback((videoEl) => {
    setMicOn(prev => {
      const next = !prev;
      streamRef.current?.getAudioTracks().forEach(t => { t.enabled = next; });
      return next;
    });
  }, []);

  // Toggle camera
  const toggleCam = useCallback((videoEl, placeholderEl) => {
    setCamOn(prev => {
      const next = !prev;
      streamRef.current?.getVideoTracks().forEach(t => { t.enabled = next; });
      if (placeholderEl) placeholderEl.classList.toggle('active', !next);
      return next;
    });
  }, []);

  // Screen share
  const toggleScreen = useCallback(async (videoEl, placeholderEl) => {
    if (!screenOn) {
      try {
        const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
        videoEl.srcObject = s;
        placeholderEl.classList.remove('active');
        setScreenOn(true);
        s.getVideoTracks()[0].addEventListener('ended', () => {
          placeholderEl.classList.add('active');
          setScreenOn(false);
        });
      } catch {}
    } else {
      videoEl.srcObject?.getTracks().forEach(t => t.stop());
      videoEl.srcObject = null;
      placeholderEl.classList.add('active');
      setScreenOn(false);
    }
  }, [screenOn]);

  // Cleanup
  const cleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
  }, []);

  return { micOn, camOn, screenOn, timerLabel, startCamera, toggleMic, toggleCam, toggleScreen, cleanup };
}
