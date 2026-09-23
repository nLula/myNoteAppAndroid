import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Theme } from '../theme';

export const MEDIA_VIDEO_EXTS = new Set(['mp4', 'm4v', '3gp', 'wmv', 'flv', 'mov', 'webm', 'avi', 'mkv', 'mpg', 'mpeg']);
export const MEDIA_AUDIO_EXTS = new Set(['mp3', 'm4a', 'ogg', 'oga', 'wav', 'flac', 'aac', 'opus', 'weba', 'wma']);

export function mediaKind(name: string): 'video' | 'audio' | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (MEDIA_VIDEO_EXTS.has(ext)) return 'video';
  if (MEDIA_AUDIO_EXTS.has(ext)) return 'audio';
  return null;
}

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Shown in place of a media player when the file hasn't synced to this device yet. */
export function MediaUnavailableCard({ kind, label, t }: { kind: 'video' | 'audio'; label: string; t: Theme }) {
  return (
    <View style={[styles.wrap, styles.audioBox, { backgroundColor: t.bgSurface, borderColor: t.border, opacity: 0.75 }]}>
      <View style={styles.audioRow}>
        <View style={[styles.playBtn, { backgroundColor: t.bgRaised }]}>
          <Feather name={kind === 'video' ? 'video' : 'music'} size={16} color={t.textMuted} />
        </View>
        <Text style={[styles.label, { color: t.textMuted, flex: 1, marginLeft: 8 }]} numberOfLines={2}>{label}</Text>
      </View>
      <Text style={[styles.label, { color: t.textMuted, marginTop: 6, fontStyle: 'italic' }]}>
        Not on this device yet — sync or transfer the file to play it.
      </Text>
    </View>
  );
}

/** Inline video player with native controls — equivalent to the PC's <video controls>. */
export function VideoAttachment({ uri, label, t }: { uri: string; label: string; t: Theme }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });
  return (
    <View style={styles.wrap}>
      <VideoView
        style={[styles.video, { backgroundColor: '#000', borderColor: t.border }]}
        player={player}
        nativeControls
        contentFit="contain"
      />
      <Text style={[styles.label, { color: t.textMuted }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

/** Inline audio player with play/pause + scrubber — equivalent to the PC's <audio controls>. */
export function AudioAttachment({ uri, label, t }: { uri: string; label: string; t: Theme }) {
  const player = useAudioPlayer(uri);
  const status = useAudioPlayerStatus(player);
  const [seeking, setSeeking] = useState<number | null>(null);

  useEffect(() => {
    return () => {
      try {
        player.pause();
      } catch {}
    };
  }, []);

  const duration = status.duration || 0;
  const current = seeking ?? status.currentTime ?? 0;

  function toggle() {
    if (status.playing) player.pause();
    else {
      if (status.didJustFinish || (duration && status.currentTime >= duration - 0.25)) {
        player.seekTo(0);
      }
      player.play();
    }
  }

  return (
    <View style={[styles.wrap, styles.audioBox, { backgroundColor: t.bgSurface, borderColor: t.border }]}>
      <Text style={[styles.label, { color: t.textMuted, marginBottom: 8 }]} numberOfLines={1}>{label}</Text>
      <View style={styles.audioRow}>
        <Pressable onPress={toggle} hitSlop={8} style={[styles.playBtn, { backgroundColor: t.accent }]}>
          <Feather name={status.playing ? 'pause' : 'play'} size={16} color="#fff" />
        </Pressable>
        <Text style={[styles.time, { color: t.textMuted }]}>{fmtTime(current)}</Text>
        <Slider
          style={styles.slider}
          minimumValue={0}
          maximumValue={duration || 1}
          value={current}
          onValueChange={(v) => setSeeking(v)}
          onSlidingComplete={(v) => {
            player.seekTo(v);
            setSeeking(null);
          }}
          minimumTrackTintColor={t.accent}
          maximumTrackTintColor={t.border}
          thumbTintColor={t.accent}
        />
        <Text style={[styles.time, { color: t.textMuted }]}>{fmtTime(duration)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginVertical: 10 },
  video: { width: '100%', aspectRatio: 16 / 9, borderRadius: 8, borderWidth: 1 },
  audioBox: { borderWidth: 1, borderRadius: 8, padding: 12 },
  audioRow: { flexDirection: 'row', alignItems: 'center' },
  playBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  slider: { flex: 1, height: 36, marginHorizontal: 4 },
  time: { fontSize: 11, width: 38, textAlign: 'center' },
  label: { fontSize: 12 },
});
