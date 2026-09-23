import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import {
  readNoteBody,
  autoSaveNoteBody,
  recordNoteHistory,
  cleanUpRemovedAttachments,
  isScratchNote,
  promoteScratchNote,
  saveLockedSession,
  closeLockedSession,
  readActiveSessionBody,
  sessionRemainingMs,
  copyAttachmentToStorage,
  contentHasOversizedAttachment,
} from '../notes';
import { useThemeCtx } from '../themeContext';
import { runSync, isSyncing, onSyncStatus } from '../lib/syncStatus';

// Characters to drop the caret past its target before scrolling back, so the
// target ends up at the top of the field rather than the bottom. Needs to
// exceed a screenful of text; overshooting further only costs one intermediate
// frame that is never settled on.
const CARET_OVERSHOOT = 4000;

function nowFileName(ext: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${ext}`;
}

export default function EditorScreen({ route, navigation }: any) {
  const { theme: t } = useThemeCtx();
  const insets = useSafeAreaInsets();
  const { name, isLockedSession, startOffset } = route.params as
    { name: string; isLockedSession?: boolean; startOffset?: number };
  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [attachBusy, setAttachBusy] = useState(false);
  const [syncBlocking, setSyncBlocking] = useState(false);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const relockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef('');
  const initialBodyRef = useRef<string | null>(null);
  const cursorPos = useRef(0);
  const pendingNavAction = useRef<any>(null);
  const hasNewAttachmentRef = useRef(false);
  const inputRef = useRef<TextInput>(null);
  const searchRef = useRef<TextInput>(null);
  const pendingCaretRef = useRef<number | null>(null);

  const matches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const hay = content.toLowerCase();
    const out: number[] = [];
    let i = hay.indexOf(q);
    while (i !== -1) {
      out.push(i);
      i = hay.indexOf(q, i + q.length);
    }
    return out;
  }, [content, searchQuery]);

  /**
   * Put the caret at a source offset and scroll it to the top of the field.
   *
   * Focus first — an unfocused input ignores the caret move. Then work around
   * how Android reveals a caret: it scrolls the smallest amount that makes it
   * visible, so a caret approached from above parks at the BOTTOM of the field,
   * about a screen later than where view mode was looking. Dropping the caret
   * past the target first and coming back makes the correction scroll upward,
   * which leaves the target at the top. The two steps need a frame between them
   * or Android coalesces them and only honours the final position.
   */
  function moveCaretTo(start: number, end: number) {
    const max = contentRef.current.length;
    const s = Math.max(0, Math.min(start, max));
    const e = Math.max(s, Math.min(end, max));
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const overshoot = Math.min(s + CARET_OVERSHOOT, max);
    if (overshoot > s) {
      input.setSelection(overshoot, overshoot);
      setTimeout(() => inputRef.current?.setSelection(s, e), 50);
    } else {
      input.setSelection(s, e);
    }
  }

  function jumpToMatch(idx: number) {
    if (!matches.length) return;
    const n = ((idx % matches.length) + matches.length) % matches.length;
    setMatchIndex(n);
    moveCaretTo(matches[n], matches[n] + searchQuery.trim().length);
  }

  // Restore the reading position once the text is actually in the input. A large
  // note can still be laying out on the first tick, and an unlaid-out field
  // ignores the caret move, so try again shortly after.
  useEffect(() => {
    if (!loaded || pendingCaretRef.current == null) return;
    const off = pendingCaretRef.current;
    pendingCaretRef.current = null;
    const attempt = (tag: string) => {
      console.log(`[editpos] moving caret to ${off} (${tag})`);
      moveCaretTo(off, off);
    };
    const t1 = setTimeout(() => attempt('first'), 150);
    const t2 = setTimeout(() => attempt('retry'), 500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [loaded]);

  // A new query lands on the first match; keep the index in range as it changes.
  useEffect(() => {
    if (!matches.length) return;
    setMatchIndex(0);
    moveCaretTo(matches[0], matches[0] + searchQuery.trim().length);
  }, [matches]);

  function persist(text: string) {
    contentRef.current = text;
    if (isLockedSession) {
      saveLockedSession(name, text);
    } else {
      autoSaveNoteBody(name, text);
    }
  }

  /**
   * Open where the reader left off in view mode. Only takes over when the view
   * was actually scrolled — opening at the top keeps the old behaviour of not
   * focusing, so the keyboard doesn't appear unasked.
   */
  function applyStartPosition(text: string) {
    const off = typeof startOffset === 'number'
      ? Math.max(0, Math.min(startOffset, text.length))
      : text.length;
    cursorPos.current = off;
    console.log(`[editpos] editor received startOffset=${startOffset} len=${text.length} → caret=${off}`);
    if (off > 0 && typeof startOffset === 'number') pendingCaretRef.current = off;
  }

  function navTitleFromContent(text: string): string {
    // `[ \t]` not `\s` — see extractTitle in notes.ts: `\s` matches the newline,
    // so an empty heading would pick up the first line of the body.
    const m = text.match(/^#[ \t]+(.+)/m);
    return m ? m[1].trim() : name.replace(/\.md$/, '');
  }

  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e: any) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      persist(contentRef.current);

      if (isLockedSession || !hasNewAttachmentRef.current) return;
      if (contentHasOversizedAttachment(contentRef.current)) return;

      e.preventDefault();
      pendingNavAction.current = e.data.action;
      setSyncBlocking(true);

      (async () => {
        try {
          if (isSyncing()) {
            await new Promise<void>((resolve) => {
              const unsub = onSyncStatus((nowSyncing) => { if (!nowSyncing) { unsub(); resolve(); } });
            });
          }
          await runSync();
        } catch {}
        setSyncBlocking(false);
        if (pendingNavAction.current) {
          navigation.dispatch(pendingNavAction.current);
          pendingNavAction.current = null;
        }
      })();
    });
    return unsub;
  }, [navigation]);

  useEffect(() => {
    navigation.setOptions({
      title: name.replace(/\.md$/, ''),
      headerStyle: { backgroundColor: t.bgSurface },
      headerTintColor: t.textPrimary,
      headerRight: () => (
        <View style={{ flexDirection: 'row' }}>
          <Pressable
            onPress={() => { setSearchVisible(true); setTimeout(() => searchRef.current?.focus(), 50); }}
            style={{ padding: 6 }}
          >
            <Feather name="search" size={19} color={t.textMuted} />
          </Pressable>
          <Pressable onPress={() => { Keyboard.dismiss(); setAttachMenuOpen(true); }} style={{ padding: 6 }}>
            <Feather name="paperclip" size={19} color={t.textMuted} />
          </Pressable>
        </View>
      ),
    });

    if (isLockedSession) {
      const tMount = Date.now();
      console.log('[unlock] EditorScreen mounted, isLockedSession=true');
      try {
        const text = readActiveSessionBody(name);
        console.log(`[unlock] EditorScreen: readActiveSessionBody took ${Date.now() - tMount}ms`);
        setContent(text);
        contentRef.current = text;
        initialBodyRef.current = text;
        applyStartPosition(text);
        navigation.setOptions({ title: navTitleFromContent(text) });
        setLoaded(true);
        console.log(`[unlock] EditorScreen: setLoaded(true) called at ${Date.now() - tMount}ms`);
        const remaining = sessionRemainingMs(name);
        relockTimer.current = setTimeout(() => {
          persist(contentRef.current);
          closeLockedSession(name);
          Alert.alert('Note locked', 'This note auto-locked after 5 minutes.');
          navigation.goBack();
        }, remaining);
      } catch {
        Alert.alert('Session expired', 'Please unlock the note again.');
        navigation.goBack();
      }
    } else {
      readNoteBody(name).then((text) => {
        setContent(text);
        contentRef.current = text;
        initialBodyRef.current = text;
        applyStartPosition(text);
        navigation.setOptions({ title: navTitleFromContent(text) });
        setLoaded(true);
      });
    }

    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (relockTimer.current) clearTimeout(relockTimer.current);
      persist(contentRef.current);
      if (!isLockedSession) {
        recordNoteHistory(name, initialBodyRef.current, contentRef.current);
        cleanUpRemovedAttachments(name, initialBodyRef.current, contentRef.current);
        // Last, so the content and history are written under the old name and
        // then carried across: a named scratch note graduates to a real one.
        if (isScratchNote(name)) {
          try {
            const promoted = promoteScratchNote();
            if (promoted) console.log(`[scratch] saved as ${promoted}`);
          } catch (e: any) {
            console.warn('[scratch] could not save under its new name:', e?.message);
          }
        }
      }
    };
  }, [name]);

  // Leaving the foreground can be the last code this screen ever runs — a
  // swiped-away app is killed moments later, and neither beforeRemove nor the
  // unmount cleanup fire for that. Write the pending edit now instead of
  // waiting out the 500ms autosave debounce.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') return;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      persist(contentRef.current);
    });
    return () => sub.remove();
  }, [name, isLockedSession]);

  function onChange(text: string) {
    setContent(text);
    contentRef.current = text;
    navigation.setOptions({ title: navTitleFromContent(text) });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      persist(text);
    }, 500);
  }

  function insertMarkdown(link: string) {
    const pos = cursorPos.current;
    const cur = contentRef.current;
    const before = cur.slice(0, pos);
    const after = cur.slice(pos);
    // Ensure one blank line (two newlines) above the attachment
    let prefix = '';
    if (before.length > 0) {
      if (before.endsWith('\n\n')) prefix = '';
      else if (before.endsWith('\n')) prefix = '\n';
      else prefix = '\n\n';
    }
    // Ensure one blank line (two newlines) below the attachment
    let suffix = '';
    if (after.startsWith('\n\n')) suffix = '';
    else if (after.startsWith('\n')) suffix = '\n';
    else suffix = '\n\n';
    const inserted = `${prefix}${link}${suffix}`;
    const newText = before + inserted + after;
    setContent(newText);
    contentRef.current = newText;
    cursorPos.current = pos + inserted.length;
    persist(newText);
  }

  async function pickFromLibrary() {
    setAttachMenuOpen(false);
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow photo library access in Settings.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'] as any,
      quality: 1,
      allowsMultipleSelection: false,
    });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    const ext = asset.type === 'video' ? 'mp4' : 'jpg';
    await handlePickedFile(asset.uri, asset.fileName ?? nowFileName(ext));
  }

  async function pickFromCamera() {
    setAttachMenuOpen(false);
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow camera access in Settings.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images', 'videos'] as any,
      quality: 1,
    });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    const ext = asset.type === 'video' ? 'mp4' : 'jpg';
    await handlePickedFile(asset.uri, asset.fileName ?? nowFileName(ext));
  }

  async function pickDocument() {
    setAttachMenuOpen(false);
    const result = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      copyToCacheDirectory: false,
    });
    if (result.canceled || !result.assets[0]) return;
    await handlePickedFile(result.assets[0].uri, result.assets[0].name);
  }

  async function handlePickedFile(uri: string, filename: string) {
    setAttachBusy(true);
    try {
      const { markdownLink } = await copyAttachmentToStorage(uri, filename);
      insertMarkdown(markdownLink);
      hasNewAttachmentRef.current = true;
    } catch (e: any) {
      Alert.alert('Could not add attachment', e.message ?? String(e));
    } finally {
      setAttachBusy(false);
    }
  }

  if (!loaded) return <View style={[styles.container, { backgroundColor: t.bgBase }]} />;

  return (
    <View style={{ flex: 1 }}>
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: t.bgBase }]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {searchVisible && (
          <View style={[styles.searchBar, { backgroundColor: t.bgSurface, borderBottomColor: t.border }]}>
            <Feather name="search" size={16} color={t.textMuted} style={{ marginRight: 8 }} />
            <TextInput
              ref={searchRef}
              style={[styles.searchInput, { color: t.textPrimary }]}
              placeholder="Search in note…"
              placeholderTextColor={t.textMuted}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="none"
              returnKeyType="search"
              onSubmitEditing={() => jumpToMatch(matchIndex + 1)}
            />
            {searchQuery.trim() ? (
              <Text style={[styles.searchCount, { color: t.textMuted }]}>
                {matches.length ? `${matchIndex + 1}/${matches.length}` : 'none'}
              </Text>
            ) : null}
            <Pressable onPress={() => jumpToMatch(matchIndex - 1)} hitSlop={8} style={{ padding: 6 }}>
              <Feather name="chevron-up" size={16} color={matches.length ? t.textPrimary : t.textMuted} />
            </Pressable>
            <Pressable onPress={() => jumpToMatch(matchIndex + 1)} hitSlop={8} style={{ padding: 6 }}>
              <Feather name="chevron-down" size={16} color={matches.length ? t.textPrimary : t.textMuted} />
            </Pressable>
            <Pressable
              onPress={() => { setSearchVisible(false); setSearchQuery(''); Keyboard.dismiss(); }}
              hitSlop={8}
              style={{ padding: 6 }}
            >
              <Feather name="x" size={16} color={t.textMuted} />
            </Pressable>
          </View>
        )}
        <TextInput
          ref={inputRef}
          style={[styles.input, { color: t.textPrimary, paddingBottom: Math.max(insets.bottom + 60, 80) }]}
          multiline
          autoCorrect
          scrollEnabled
          value={content}
          onChangeText={onChange}
          onSelectionChange={(e) => { cursorPos.current = e.nativeEvent.selection.start; }}
          placeholder="Start writing…"
          placeholderTextColor={t.textMuted}
          textAlignVertical="top"
        />
      </KeyboardAvoidingView>

      {syncBlocking && (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-only">
          <View style={styles.syncOverlay}>
            <View style={[styles.syncBox, { backgroundColor: t.bgRaised, borderColor: t.border }]}>
              <ActivityIndicator color={t.accent} style={{ marginBottom: 12 }} />
              <Text style={[styles.syncTitle, { color: t.textPrimary }]}>Syncing changes…</Text>
              <Text style={[styles.syncSub, { color: t.textMuted }]}>
                myNote is syncing your changes. Please wait until it finishes.
              </Text>
              <Pressable
                style={[styles.syncBtn, { backgroundColor: t.bgSurface }]}
                onPress={() => {
                  setSyncBlocking(false);
                  if (pendingNavAction.current) {
                    navigation.dispatch(pendingNavAction.current);
                    pendingNavAction.current = null;
                  }
                }}
              >
                <Text style={{ color: t.textMuted, fontWeight: '600' }}>OK</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}

      {attachMenuOpen && (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <Pressable
            style={[StyleSheet.absoluteFill, styles.backdrop]}
            onPress={() => setAttachMenuOpen(false)}
          />
          <View style={[
            styles.attachSheet,
            { backgroundColor: t.bgRaised, borderColor: t.border, paddingBottom: Math.max(insets.bottom, 12) }
          ]}>
            <View style={[styles.sheetHandle, { backgroundColor: t.border }]} />
            <Text style={[styles.sheetTitle, { color: t.textMuted }]}>Add Attachment</Text>

            <Pressable
              style={[styles.sheetOption, { borderBottomColor: t.border }]}
              onPress={pickFromLibrary}
              disabled={attachBusy}
            >
              <Feather name="image" size={22} color={t.accent} />
              <View style={styles.sheetOptionText}>
                <Text style={[styles.sheetOptionLabel, { color: t.textPrimary }]}>Photo / Video Library</Text>
                <Text style={[styles.sheetOptionSub, { color: t.textMuted }]}>From camera roll → images/ or videos/</Text>
              </View>
            </Pressable>

            <Pressable
              style={[styles.sheetOption, { borderBottomColor: t.border }]}
              onPress={pickFromCamera}
              disabled={attachBusy}
            >
              <Feather name="camera" size={22} color={t.accent} />
              <View style={styles.sheetOptionText}>
                <Text style={[styles.sheetOptionLabel, { color: t.textPrimary }]}>Camera</Text>
                <Text style={[styles.sheetOptionSub, { color: t.textMuted }]}>Take a photo or video now</Text>
              </View>
            </Pressable>

            <Pressable
              style={[styles.sheetOption, { borderBottomWidth: 0 }]}
              onPress={pickDocument}
              disabled={attachBusy}
            >
              <Feather name="file" size={22} color={t.accent} />
              <View style={styles.sheetOptionText}>
                <Text style={[styles.sheetOptionLabel, { color: t.textPrimary }]}>File</Text>
                <Text style={[styles.sheetOptionSub, { color: t.textMuted }]}>Audio, document, archive — any file type</Text>
              </View>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 14 },
  input: { flex: 1, fontSize: 16, lineHeight: 22 },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: 1, marginHorizontal: -14, marginTop: -14, marginBottom: 8,
  },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 4 },
  searchCount: { fontSize: 12, marginRight: 4 },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.45)' },
  syncOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 32 },
  syncBox: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, padding: 24, alignItems: 'center' },
  syncTitle: { fontSize: 16, fontWeight: '700', marginBottom: 8 },
  syncSub: { fontSize: 13, lineHeight: 19, textAlign: 'center', marginBottom: 20 },
  syncBtn: { borderRadius: 10, paddingVertical: 10, paddingHorizontal: 32 },
  attachSheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    borderTopWidth: 1,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 10,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 10,
  },
  sheetTitle: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginHorizontal: 20,
    marginBottom: 4,
  },
  sheetOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    gap: 14,
  },
  sheetOptionText: { flex: 1 },
  sheetOptionLabel: { fontSize: 16, fontWeight: '500' },
  sheetOptionSub: { fontSize: 12, marginTop: 2 },
});
