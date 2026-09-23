import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Modal,
  PanResponder,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
  Dimensions,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import {
  listNotes,
  writeNote,
  deleteNote,
  isNoteEncrypted,
  isSessionActive,
  lockNote,
  openLockedSession,
  generateNoteFilename,
  NoteMeta,
} from '../notes';
import { exportNoteAsPdf, exportNoteAsHtml, shareExportedFile, saveExportedFile, ExportResult } from '../lib/export';
import { onSyncStatus, runSync, isSyncing } from '../lib/syncStatus';
import { useThemeCtx } from '../themeContext';

type Mode = 'new' | 'edit' | 'tag' | 'pdf' | 'share' | 'lock' | null;
type BarMode = 'search' | 'new' | 'password';
type SortBy = 'ctime' | 'alpha' | 'mtime';

const BAR_INDEX: Record<BarMode, number> = { search: 0, new: 1, password: 2 };
const screenWidth = Dimensions.get('window').width;

function formatNoteDate(epochMs: number): string {
  if (!epochMs) return '';
  const d = new Date(epochMs);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const noteStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((todayStart - noteStart) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export default function NoteListScreen({ navigation }: any) {
  const { theme: t } = useThemeCtx();
  const insets = useSafeAreaInsets();
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [mode, setMode] = useState<Mode>(null);
  const [barMode, setBarMode] = useState<BarMode>('search');
  const [searchQuery, setSearchQuery] = useState('');
  const [newName, setNewName] = useState('');
  const [pwTargetName, setPwTargetName] = useState<string | null>(null);
  const [pwTargetEncrypted, setPwTargetEncrypted] = useState(false);
  const [pwValue, setPwValue] = useState('');
  const [pwError, setPwError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>('ctime');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  function onSortPress(key: SortBy) {
    if (sortBy === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setSortDir(key === 'alpha' ? 'asc' : 'desc');
    }
  }
  const slideX = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const spinLoop = useRef<Animated.CompositeAnimation | null>(null);

  const pullY = useRef(new Animated.Value(0)).current;
  const isAtTop = useRef(true);
  const syncingRef = useRef(false);
  const pullDistance = useRef(0);
  const MAX_PULL = 56;

  const panResponder = useRef(
    PanResponder.create({
      // Capture phase: intercept before SectionList's scroll responder claims the touch.
      onMoveShouldSetPanResponderCapture: (_, gs) =>
        isAtTop.current && gs.dy > 2 && gs.vy > 0 && Math.abs(gs.dy) > Math.abs(gs.dx),
      onPanResponderGrant: () => {
        // gs.dy resets to 0 on grant, so track distance ourselves from this point.
        pullDistance.current = 0;
      },
      onPanResponderMove: (_, gs) => {
        const raw = Math.max(0, gs.dy);
        pullDistance.current = raw;
        pullY.setValue((raw * MAX_PULL) / (raw + MAX_PULL));
      },
      onPanResponderRelease: () => {
        if (pullDistance.current > 22 && !syncingRef.current) {
          runSync().catch(() => {});
        }
        pullDistance.current = 0;
        Animated.spring(pullY, { toValue: 0, useNativeDriver: true, tension: 120, friction: 10 }).start();
      },
      onPanResponderTerminate: () => {
        pullDistance.current = 0;
        Animated.spring(pullY, { toValue: 0, useNativeDriver: true, tension: 120, friction: 10 }).start();
      },
      // Prevent SectionList from reclaiming the gesture once we've captured it.
      onPanResponderTerminationRequest: () => false,
    })
  ).current;

  const pullOpacity = pullY.interpolate({ inputRange: [0, MAX_PULL * 0.35, MAX_PULL], outputRange: [0, 0.3, 1], extrapolate: 'clamp' });
  const hintTranslate = pullY.interpolate({ inputRange: [0, MAX_PULL], outputRange: [-10, 0], extrapolate: 'clamp' });

  const refresh = useCallback(() => {
    listNotes().then(setNotes);
  }, []);

  useFocusEffect(refresh);

  function startSpin() {
    spinLoop.current = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: true })
    );
    spinLoop.current.start();
  }

  function stopSpin() {
    spinLoop.current?.stop();
    // Finish the current revolution smoothly instead of snapping to a random angle.
    spin.stopAnimation((value) => {
      const target = Math.ceil(value) || 1;
      Animated.timing(spin, {
        toValue: target,
        duration: 200,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start(() => spin.setValue(0));
    });
  }

  useEffect(() => {
    if (isSyncing()) {
      setSyncing(true);
      syncingRef.current = true;
      startSpin();
    }
    return onSyncStatus((nowSyncing) => {
      setSyncing(nowSyncing);
      syncingRef.current = nowSyncing;
      if (nowSyncing) {
        startSpin();
      } else {
        stopSpin();
        refresh();
      }
    });
  }, []);

  const spinDeg = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  function animateTo(next: BarMode) {
    setBarMode(next);
    Animated.timing(slideX, {
      toValue: -BAR_INDEX[next] * screenWidth,
      duration: 260,
      useNativeDriver: true,
    }).start();
  }

  function selectMode(next: Mode) {
    if (mode === next) {
      setMode(null);
      if (barMode !== 'search') animateTo('search');
      return;
    }
    setMode(next);
    if (next === 'new') {
      animateTo('new');
    } else if (barMode !== 'search') {
      animateTo('search');
    }
  }

  async function onPullToRefresh() {
    if (syncing) return;
    try {
      const r = await runSync();
      if (!r.ok) {
        Alert.alert('Sync error', r.error ?? 'Unknown error');
      }
    } catch (e: any) {
      Alert.alert('Sync error', e.message ?? String(e));
    }
  }

  async function createNote() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const fileName = generateNoteFilename(trimmed);
    await writeNote(fileName, `# ${trimmed}\n`);
    setNewName('');
    setMode(null);
    animateTo('search');
    refresh();
    navigation.navigate('Editor', { name: fileName });
  }

  const [trashTarget, setTrashTarget] = useState<string | null>(null);

  function confirmDelete(name: string) {
    setTrashTarget(name);
  }

  async function onConfirmTrash() {
    if (!trashTarget) return;
    await deleteNote(trashTarget);
    setTrashTarget(null);
    refresh();
  }

  async function runExport(build: () => Promise<ExportResult>) {
    let result: ExportResult;
    try {
      result = await build();
    } catch (e: any) {
      Alert.alert('Export failed', e.message ?? String(e));
      return;
    }
    const { fileUri, filename, skipped } = result;
    // Only PDF has an overall size ceiling — HTML is streamed, so it can always
    // carry everything. Point there rather than just listing what was lost.
    const note = skipped.length
      ? `\n\nImages too large to embed:\n${skipped.join('\n')}` +
        (filename.endsWith('.pdf') ? '\n\nExport as HTML to include all images.' : '')
      : '';
    Alert.alert(filename, `Saved to the app's temporary folder.${note}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Share', onPress: () => { shareExportedFile(fileUri).catch(() => {}); } },
      {
        text: 'Save to folder…',
        onPress: async () => {
          try {
            const where = await saveExportedFile(fileUri, filename);
            if (where) Alert.alert('Saved', where);
          } catch (e: any) {
            Alert.alert('Could not save', e.message ?? String(e));
          }
        },
      },
    ]);
  }

  async function onNotePress(item: NoteMeta) {
    if (mode === null) {
      if (isNoteEncrypted(item.name)) {
        if (isSessionActive(item.name)) {
          navigation.navigate('View', { name: item.name });
        } else {
          setPwTargetName(item.name);
          setPwTargetEncrypted(true);
          setPwValue('');
          setPwError('');
          animateTo('password');
        }
      } else {
        navigation.navigate('View', { name: item.name });
      }
      return;
    }
    if (mode === 'edit') {
      if (isNoteEncrypted(item.name)) {
        if (isSessionActive(item.name)) {
          setMode(null);
          navigation.navigate('Editor', { name: item.name, isLockedSession: true });
        } else {
          setPwTargetName(item.name);
          setPwTargetEncrypted(true);
          setPwValue('');
          setPwError('');
          animateTo('password');
        }
      } else {
        setMode(null);
        navigation.navigate('Editor', { name: item.name });
      }
      return;
    }
    if (mode === 'tag') {
      setMode(null);
      navigation.navigate('Tags', { name: item.name });
      return;
    }
    if (mode === 'pdf') {
      setMode(null);
      await runExport(() => exportNoteAsPdf(item.name));
      return;
    }
    if (mode === 'share') {
      setMode(null);
      await runExport(() => exportNoteAsHtml(item.name));
      return;
    }
    if (mode === 'lock') {
      const encrypted = isNoteEncrypted(item.name);
      setPwTargetName(item.name);
      setPwTargetEncrypted(encrypted);
      setPwValue('');
      setPwError('');
      animateTo('password');
      return;
    }
  }

  async function confirmPassword() {
    if (!pwTargetName) return;
    if (!pwValue) return;
    setPwBusy(true);
    const tStart = Date.now();
    console.log('[unlock] confirmPassword: tap registered');
    try {
      if (pwTargetEncrypted) {
        try {
          await openLockedSession(pwTargetName, pwValue);
          console.log(`[unlock] confirmPassword: openLockedSession returned after ${Date.now() - tStart}ms`);
          const targetName = pwTargetName;
          cancelPasswordBar();
          setMode(null);
          navigation.navigate('View', { name: targetName });
          console.log(`[unlock] confirmPassword: navigate called at ${Date.now() - tStart}ms`);
        } catch (e) {
          console.log(`[unlock] confirmPassword: FAILED after ${Date.now() - tStart}ms`, e);
          setPwError('Incorrect password.');
        }
      } else {
        await lockNote(pwTargetName, pwValue);
        cancelPasswordBar();
        setMode(null);
        refresh();
      }
    } finally {
      setPwBusy(false);
    }
  }

  function cancelPasswordBar() {
    setPwTargetName(null);
    setPwValue('');
    setPwError('');
    animateTo('search');
  }


  const filtered = notes.filter((n) =>
    n.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const locked: NoteMeta[] = [];
  const unlocked: NoteMeta[] = [];
  for (const n of filtered) {
    (isNoteEncrypted(n.name) ? locked : unlocked).push(n);
  }

  let sections: { title: string; data: NoteMeta[] }[];

  if (sortBy === 'alpha') {
    const dir = sortDir === 'asc' ? 1 : -1;
    unlocked.sort((a, b) => dir * a.title.localeCompare(b.title));
    const byLetter = new Map<string, NoteMeta[]>();
    for (const n of unlocked) {
      const letter = (n.title[0] ?? '#').toUpperCase();
      if (!byLetter.has(letter)) byLetter.set(letter, []);
      byLetter.get(letter)!.push(n);
    }
    sections = [...byLetter.entries()]
      .sort(([a], [b]) => dir * a.localeCompare(b))
      .map(([letter, data]) => ({ title: letter, data }));
  } else {
    const key: keyof NoteMeta = sortBy === 'ctime' ? 'createdAt' : 'modifiedAt';
    const dir = sortDir === 'desc' ? 1 : -1;
    unlocked.sort((a, b) => dir * (b[key] - a[key]));
    sections = [{ title: '', data: unlocked }];
  }

  if (locked.length) {
    sections.push({ title: 'Locked', data: locked });
  }

  return (
    <View style={[styles.container, { backgroundColor: t.bgBase }]}>
      <View style={[styles.toolbar, { borderColor: t.border, paddingTop: insets.top + 8 }]}>
        <View style={styles.logoBtn}>
          <Animated.Image
            source={require('../assets/mynote_logo_small.png')}
            style={[styles.logo, { transform: [{ rotate: spinDeg }] }]}
          />
        </View>

        <Pressable style={[styles.toolBtn, styles.toolBtnGroupStart, mode === 'new' && { backgroundColor: t.accentSubtle }]} onPress={() => selectMode('new')}>
          <Feather name="plus" size={17} color={mode === 'new' ? t.accent : t.textMuted} />
        </Pressable>

        <Pressable style={[styles.toolBtn, styles.toolBtnGroupStart, mode === 'edit' && { backgroundColor: t.accentSubtle }]} onPress={() => selectMode('edit')}>
          <Feather name="edit-2" size={17} color={mode === 'edit' ? t.accent : t.textMuted} />
        </Pressable>
        <Pressable style={[styles.toolBtn, mode === 'tag' && { backgroundColor: t.accentSubtle }]} onPress={() => selectMode('tag')}>
          <Feather name="tag" size={17} color={mode === 'tag' ? t.accent : t.textMuted} />
        </Pressable>

        <Pressable style={[styles.toolBtn, styles.toolBtnGroupStart, mode === 'pdf' && { backgroundColor: t.accentSubtle }]} onPress={() => selectMode('pdf')}>
          <Feather name="file-text" size={17} color={mode === 'pdf' ? t.accent : t.textMuted} />
        </Pressable>
        <Pressable style={[styles.toolBtn, mode === 'share' && { backgroundColor: t.accentSubtle }]} onPress={() => selectMode('share')}>
          <Feather name="share-2" size={17} color={mode === 'share' ? t.accent : t.textMuted} />
        </Pressable>

        <Pressable style={[styles.toolBtn, styles.toolBtnGroupStart, mode === 'lock' && { backgroundColor: t.accentSubtle }]} onPress={() => selectMode('lock')}>
          <Feather name="lock" size={17} color={mode === 'lock' ? t.accent : t.textMuted} />
        </Pressable>

        <View style={{ flex: 1 }} />

        <Pressable style={styles.toolBtn} onPress={() => navigation.navigate('Settings')}>
          <Feather name="settings" size={17} color={t.textMuted} />
        </Pressable>
      </View>

      <View style={styles.barClip}>
        <Animated.View style={[styles.barRow, { transform: [{ translateX: slideX }] }]}>
          <View style={[styles.barSlot, { width: screenWidth }]}>
            <View style={[styles.searchWrap, { backgroundColor: t.bgSurface, borderColor: t.border }]}>
              <Feather name="search" size={16} color={t.textMuted} style={{ marginHorizontal: 8 }} />
              <TextInput
                style={[styles.barInput, { color: t.textPrimary }]}
                placeholder="Search notes…"
                placeholderTextColor={t.textMuted}
                value={searchQuery}
                onChangeText={setSearchQuery}
              />
            </View>
          </View>

          <View style={[styles.barSlot, { width: screenWidth }]}>
            <View style={[styles.searchWrap, { backgroundColor: t.bgSurface, borderColor: t.border }]}>
              <TextInput
                style={[styles.barInput, { color: t.textPrimary, marginLeft: 10 }]}
                placeholder="New note name"
                placeholderTextColor={t.textMuted}
                value={newName}
                onChangeText={setNewName}
                onSubmitEditing={createNote}
                autoFocus={barMode === 'new'}
              />
              <Pressable onPress={createNote} style={{ padding: 10 }}>
                <Feather name="plus" size={18} color={t.accent} />
              </Pressable>
            </View>
          </View>

          <View style={[styles.barSlot, { width: screenWidth }]}>
            <View style={[styles.searchWrap, { backgroundColor: t.bgSurface, borderColor: t.border }]}>
              <Feather name="lock" size={16} color={t.textMuted} style={{ marginHorizontal: 8 }} />
              <TextInput
                style={[styles.barInput, { color: t.textPrimary }]}
                placeholder="Enter password"
                placeholderTextColor={t.textMuted}
                secureTextEntry
                value={pwValue}
                onChangeText={setPwValue}
                onSubmitEditing={confirmPassword}
                autoFocus={barMode === 'password'}
              />
              <Pressable onPress={confirmPassword} style={{ padding: 10 }} disabled={pwBusy}>
                {pwBusy ? <ActivityIndicator size="small" color={t.accent} /> : <Feather name="check" size={18} color={t.accent} />}
              </Pressable>
              <Pressable onPress={cancelPasswordBar} style={{ padding: 10 }} disabled={pwBusy}>
                <Feather name="x" size={18} color={t.textMuted} />
              </Pressable>
            </View>
          </View>
        </Animated.View>
      </View>
      {!!pwError && <Text style={styles.pwError}>{pwError}</Text>}

      {/* Pull-to-sync area — PanResponder wraps the whole list section.
          The pull indicator sits behind; the list Animated.View slides over it. */}
      <View style={{ flex: 1 }} {...panResponder.panHandlers}>
        {/* Indicator revealed as the list slides down */}
        <Animated.View
          style={[styles.pullHint, { opacity: pullOpacity, transform: [{ translateY: hintTranslate }] }]}
          pointerEvents="none"
        >
          <Feather name="chevron-down" size={15} color={t.textMuted} />
          <Text style={[styles.pullHintText, { color: t.textMuted }]}>Release to sync</Text>
        </Animated.View>

        {/* List content — slides down on pull */}
        <Animated.View style={{ flex: 1, transform: [{ translateY: pullY }] }}>
          <View style={[styles.sortBar, { borderColor: t.border }]}>
            {([
              ['ctime', 'Created'],
              ['alpha', 'Alphabetic'],
              ['mtime', 'Changed'],
            ] as [SortBy, string][]).map(([key, label]) => {
              const active = sortBy === key;
              const arrow = !active ? '' : key === 'alpha' ? (sortDir === 'asc' ? ' A→Z' : ' Z→A') : sortDir === 'desc' ? ' ↓' : ' ↑';
              return (
                <Pressable key={key} onPress={() => onSortPress(key)} style={styles.sortBtn}>
                  <Text style={[styles.sortBtnText, { color: active ? t.accent : t.textMuted }]}>{label}{arrow}</Text>
                </Pressable>
              );
            })}
          </View>

          {mode && mode !== 'new' && (
            <Text style={[styles.modeHint, { color: t.accent }]}>
              Select a note to {mode === 'pdf' ? 'export as PDF' : mode === 'share' ? 'share as HTML' : mode}
            </Text>
          )}

          <SectionList
            sections={sections}
            keyExtractor={(item) => item.name}
            contentContainerStyle={{ paddingTop: 6, paddingBottom: 24 }}
            onScroll={(e) => { isAtTop.current = e.nativeEvent.contentOffset.y <= 0; }}
            scrollEventThrottle={16}
            renderSectionHeader={({ section }) => {
              if (!section.title) return null;
              if (section.title !== 'Locked' && section.data.length <= 1) return null;
              return (
                <View style={[styles.sectionHeader, { backgroundColor: t.bgBase }]}>
                  <Text style={[styles.sectionHeaderText, { color: t.textMuted }]}>{section.title}</Text>
                </View>
              );
            }}
            renderItem={({ item }) => (
              <Pressable
                style={[styles.card, { backgroundColor: t.bgSurface }]}
                onPress={() => onNotePress(item)}
                onLongPress={() => confirmDelete(item.name)}
              >
                <View style={styles.cardHeader}>
                  {isNoteEncrypted(item.name) && (
                    <Feather name="lock" size={12} color={t.textMuted} style={{ marginRight: 5 }} />
                  )}
                  <Text style={[styles.cardTitle, { color: t.textPrimary }]} numberOfLines={1}>{item.title}</Text>
                </View>
                <Text style={[styles.cardDate, { color: t.textMuted }]}>{formatNoteDate(item.modifiedAt)}</Text>
              </Pressable>
            )}
            ListEmptyComponent={<Text style={[styles.empty, { color: t.textMuted }]}>No notes yet.</Text>}
          />
        </Animated.View>
      </View>

      <Modal visible={!!trashTarget} transparent animationType="fade" onRequestClose={() => setTrashTarget(null)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, { backgroundColor: t.bgRaised, borderColor: t.border }]}>
            <Text style={[styles.modalMsg, { color: t.textPrimary }]}>Send to trash?</Text>
            <View style={styles.modalActions}>
              <Pressable style={[styles.modalBtn, { backgroundColor: t.bgSurface }]} onPress={() => setTrashTarget(null)}>
                <Text style={{ color: t.textMuted, fontWeight: '600' }}>No</Text>
              </Pressable>
              <Pressable style={[styles.modalBtn, { backgroundColor: t.accent }]} onPress={onConfirmTrash}>
                <Text style={{ color: '#fff', fontWeight: '600' }}>Yes</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  logoBtn: { padding: 6, marginRight: 2 },
  logo: { width: 24, height: 24, borderRadius: 6 },
  toolBtn: { padding: 8, borderRadius: 9, marginHorizontal: 1 },
  toolBtnGroupStart: { marginLeft: 8 },
  barClip: { overflow: 'hidden', height: 60 },
  barRow: { flexDirection: 'row', height: 60 },
  barSlot: { paddingHorizontal: 14, paddingVertical: 10, justifyContent: 'center' },
  searchWrap: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 22 },
  barInput: { flex: 1, paddingVertical: 9, fontSize: 15 },
  pwError: { color: '#e5484d', fontSize: 12, marginLeft: 16, marginTop: 2 },
  modeHint: { fontSize: 12, marginLeft: 16, marginTop: 4, marginBottom: 2 },
  sortBar: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingVertical: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sortBtn: { paddingHorizontal: 12, paddingVertical: 2 },
  sortBtnText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  card: {
    borderRadius: 12,
    marginHorizontal: 12,
    marginVertical: 4,
    paddingHorizontal: 15,
    paddingVertical: 13,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  cardTitle: { fontSize: 16, fontWeight: '600', flex: 1 },
  cardDate: { fontSize: 12, marginTop: 5 },
  empty: { textAlign: 'center', marginTop: 48, fontSize: 14 },
  sectionHeader: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 },
  sectionHeaderText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 28 },
  modalBox: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, padding: 24 },
  modalMsg: { fontSize: 16, fontWeight: '500', textAlign: 'center', marginBottom: 22 },
  modalActions: { flexDirection: 'row', justifyContent: 'center', gap: 12 },
  modalBtn: { paddingVertical: 11, paddingHorizontal: 28, borderRadius: 10 },
  pullHint: { position: 'absolute', top: 0, left: 0, right: 0, height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  pullHintText: { fontSize: 12 },
});
