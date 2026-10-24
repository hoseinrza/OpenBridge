import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { fonts, radius, spacing, type, useAppTheme } from '../theme';
import { fa } from '../utils/persian';
import { playVoice, stopVoice, subscribeVoice } from '../services/voicePlayer';

// One recording, listened to on this phone.
//
// The length written on the bubble is the one the sender measured, because a
// streamed file reports no reliable length until it has been read; the rail
// under it is this device's own clock, so the number and the bar are two honest
// measurements rather than one pretending to be the other.
//
// Nothing is downloaded before the first tap. A history of a hundred recordings
// costs a hundred rows and no bytes.
export default function VoiceBubble({ id, src, durationMs, mine = false }) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [player, setPlayer] = useState({ id: null, loading: false, playing: false, error: '' });
  const [rail, setRail] = useState({ at: 0, total: 0 });
  const [heard, setHeard] = useState(false);

  const active = player.id === id;
  const playing = active && player.playing;

  useEffect(() => subscribeVoice(setPlayer), []);

  // A recording nobody is looking at anymore must not keep the speaker.
  useEffect(() => () => stopVoice(id), [id]);

  // Once it has been heard it stays heard: the mark answers «has this been
  // listened to here», and a finished message going back to unread would lie.
  useEffect(() => {
    if (active && player.playing) setHeard(true);
  }, [active, player.playing]);

  useEffect(() => {
    if (!active) { setRail({ at: 0, total: 0 }); return undefined; }
    setRail(prev => (prev.total === player.total && prev.at === player.at
      ? prev
      : { at: player.at, total: player.total }));
  }, [active, player.at, player.total]);

  // The label is where the listen stands while this bubble holds the speaker,
  // and the length the sender measured the rest of the time.
  const shownMs = active && rail.at > 0 ? rail.at : (durationMs ?? 0);
  const seconds = Math.max(0, Math.round(shownMs / 1000));
  const label = `${fa(String(Math.floor(seconds / 60)).padStart(2, '0'))}:${fa(String(seconds % 60).padStart(2, '0'))}`;
  const totalMs = rail.total > 0 ? rail.total : (durationMs ?? 0);
  const ratio = active && totalMs > 0 ? Math.min(1, rail.at / totalMs) : 0;

  return (
    <View style={styles.row}>
      <Pressable
        testID={`voice-play-${id}`}
        style={[styles.play, mine ? styles.playMine : styles.playOther, !heard && styles.playFresh]}
        onPress={() => playVoice(id, src)}
        disabled={!src}
        accessibilityRole="button"
        accessibilityLabel={playing ? 'توقف پیام صوتی' : 'پخش پیام صوتی'}
        accessibilityState={{ selected: playing }}
      >
        {active && player.loading
          ? <ActivityIndicator size="small" color={heard ? (mine ? colors.onBubbleOut : colors.accentText) : colors.onAccent} />
          : <FontAwesome6
              name={player.error && active ? 'triangle-exclamation' : playing ? 'pause' : 'play'}
              size={12}
              color={player.error && active
                ? (mine ? colors.onBubbleOut : colors.danger)
                : (!heard ? colors.onAccent : (mine ? colors.onBubbleOut : colors.text3))}
            />}
      </Pressable>

      <View style={[styles.track, mine && styles.trackMine]}>
        <View
          style={[styles.fill, mine && styles.fillMine, { width: `${ratio * 100}%` }]}
        />
      </View>

      <Text style={[styles.time, mine && styles.timeMine]}>{player.error && active ? 'پخش نشد' : label}</Text>
    </View>
  );
}

function makeStyles(colors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
      minWidth: 190, paddingVertical: 3,
    },
    play: {
      width: 30, height: 30, borderRadius: radius.pill,
      alignItems: 'center', justifyContent: 'center',
      borderWidth: 1,
    },
    playOther: { borderColor: colors.border, backgroundColor: colors.surface3 },
    playMine: { borderColor: 'rgba(255,255,255,0.42)', backgroundColor: 'rgba(255,255,255,0.16)' },
    // Unplayed is the state worth seeing at a glance, so it is the one that is
    // filled in; a recording already heard keeps a quiet circle.
    playFresh: { backgroundColor: colors.accent, borderColor: colors.accent },
    track: {
      flex: 1, height: 4, borderRadius: radius.pill,
      backgroundColor: colors.surface3, overflow: 'hidden',
    },
    trackMine: { backgroundColor: 'rgba(255,255,255,0.28)' },
    fill: { height: '100%', borderRadius: radius.pill, backgroundColor: colors.accent },
    fillMine: { backgroundColor: colors.onBubbleOut },
    time: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.xs, minWidth: 34 },
    timeMine: { color: 'rgba(255,255,255,0.82)' },
  });
}
