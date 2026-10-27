jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockSecureStore = new Map();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async key => mockSecureStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key, value) => { mockSecureStore.set(key, value); }),
  deleteItemAsync: jest.fn(async key => { mockSecureStore.delete(key); }),
  __reset: () => mockSecureStore.clear(),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }) => children,
}));

jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    FontAwesome6: ({ name, accessibilityLabel }) =>
      React.createElement(Text, { accessibilityLabel }, name),
  };
});

jest.mock('socket.io-client', () => ({ io: jest.fn() }));

// expo-audio patches native player prototypes when the module is evaluated,
// which the Jest native mock does not provide. The voice UI is not under test
// here, so a plain stub keeps screen tests independent of the native module.
jest.mock('expo-audio', () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })),
  setAudioModeAsync: jest.fn(async () => {}),
  useAudioRecorder: jest.fn(() => ({
    prepareToRecordAsync: jest.fn(async () => {}),
    record: jest.fn(),
    stop: jest.fn(async () => {}),
    getStatus: jest.fn(() => ({ isRecording: false, durationMillis: 0 })),
    uri: null,
  })),
  createAudioPlayer: jest.fn(() => ({
    play: jest.fn(),
    pause: jest.fn(),
    remove: jest.fn(),
    seekTo: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    playing: false,
    currentTime: 0,
    duration: 0,
  })),
}));

jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(() => '11111111-1111-4111-8111-111111111111'),
}));

// The native WebRTC modules only load when a call becomes active; these stubs
// keep a test that reaches the call layer from pulling in Android/iOS code.
jest.mock('@livekit/react-native', () => {
  const React = require('react');
  return {
    registerGlobals: jest.fn(),
    AudioSession: {
      startAudioSession: jest.fn(async () => {}),
      stopAudioSession: jest.fn(async () => {}),
    },
    LiveKitRoom: ({ children }) => React.createElement(React.Fragment, null, children),
    VideoTrack: () => null,
    useRoomContext: () => null,
    useParticipants: () => [],
    useTracks: () => [],
    useConnectionState: () => 'disconnected',
    useLocalParticipant: () => ({
      isMicrophoneEnabled: true,
      isCameraEnabled: false,
      localParticipant: null,
    }),
  };
});

jest.mock('livekit-client', () => ({
  ConnectionState: { Connected: 'connected', Reconnecting: 'reconnecting', SignalReconnecting: 'signalReconnecting' },
  Track: { Source: { Camera: 'camera', Microphone: 'microphone' } },
}));

// No microphone and no speaker on a test machine. The recorder's clock is a
// number a test sets by hand and the player's status is pushed with __emit, so
// a voice test drives the same code paths the phone does without the hardware.
jest.mock('expo-audio', () => {
  const recorder = {
    id: 'mock-recorder',
    uri: null,
    isRecording: false,
    durationMillis: 0,
    record: jest.fn(() => { recorder.isRecording = true; }),
    stop: jest.fn(async () => {
      recorder.isRecording = false;
      recorder.uri = recorder.uri ?? 'file:///mock/voice.m4a';
    }),
    getStatus: jest.fn(() => ({
      canRecord: true,
      isRecording: recorder.isRecording,
      durationMillis: recorder.durationMillis,
      mediaServicesDidReset: false,
      url: recorder.uri,
    })),
    __reset: () => {
      recorder.uri = null;
      recorder.isRecording = false;
      recorder.durationMillis = 0;
    },
  };

  const makePlayer = () => {
    const listeners = new Set();
    const push = () => {
      player.playing = player.status.playing;
      player.currentTime = player.status.currentTime;
      player.duration = player.status.duration;
      player.isLoaded = player.status.isLoaded;
      player.didJustFinish = player.status.didJustFinish;
      player.error = player.status.error;
      for (const listen of listeners) listen(player.status);
    };
    const player = {
      status: { playing: false, currentTime: 0, duration: 0, isLoaded: true, error: null, didJustFinish: false },
      addListener: (_event, listen) => { listeners.add(listen); return () => listeners.delete(listen); },
      play: jest.fn(() => { player.status = { ...player.status, playing: true, isLoaded: true }; push(); }),
      pause: jest.fn(() => { player.status = { ...player.status, playing: false }; push(); }),
      seekTo: jest.fn((seconds) => { player.status = { ...player.status, currentTime: seconds }; push(); }),
      remove: jest.fn(),
      __emit: (patch) => { player.status = { ...player.status, ...patch }; push(); },
    };
    return player;
  };

  const players = [];

  return {
    RecordingPresets: {
      HIGH_QUALITY: { extension: '.m4a', sampleRate: 44100, numberOfChannels: 2, bitRate: 128000 },
      LOW_QUALITY: { extension: '.m4a', sampleRate: 44100, numberOfChannels: 1, bitRate: 64000 },
    },
    requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })),
    getRecordingPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })),
    setAudioModeAsync: jest.fn(async () => {}),
    useAudioRecorder: () => recorder,
    createAudioPlayer: jest.fn(() => {
      const player = makePlayer();
      players.push(player);
      return player;
    }),
    __recorder: recorder,
    __players: players,
  };
});

const { configure } = require('@testing-library/react-native');
configure({ asyncUtilTimeout: 5000 });

// Neither picker exists on a test machine, and a suite that only renders the
// composer must not end up "picking" something. The default answer is a cancel,
// which is what a user backing out of the dialog returns; a test that wants a
// file overrides these in its own jest.mock.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: true })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: [] })),
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(async () => ({ canceled: true, assets: [] })),
}));
