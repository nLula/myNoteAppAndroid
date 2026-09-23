import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Keyboard, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCallback } from 'react';
import { Feather } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import FitImage from 'react-native-fit-image';
import MarkdownIt from 'markdown-it';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';
import { readNoteBody, isNoteEncrypted, isSessionActive, readActiveSessionBody, resolveAttachmentUri, getNoteDates, getNoteHistory, HistoryEntry } from '../notes';
import { useThemeCtx } from '../themeContext';
import { Theme } from '../theme';
import { VideoAttachment, AudioAttachment, MediaUnavailableCard, mediaKind } from './MediaPlayers';

/** A fenced code block with selectable text and a copy button, matching the PC's code-copy-btn. */
function CodeBlock({ content, t }: { content: string; t: Theme }) {
  const [copied, setCopied] = useState(false);
  async function onCopy() {
    await Clipboard.setStringAsync(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <View style={[codeStyles.wrap, { backgroundColor: t.bgSurface, borderColor: t.border }]}>
      <Pressable onPress={onCopy} style={[codeStyles.copyBtn, { backgroundColor: t.bgRaised, borderColor: t.border }]} hitSlop={6}>
        <Feather name={copied ? 'check' : 'copy'} size={13} color={copied ? t.accent : t.textMuted} />
      </Pressable>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable style={[codeStyles.code, { color: t.textPrimary }]}>
          {content}
        </Text>
      </ScrollView>
    </View>
  );
}

const ACT_LABEL: Record<string, string> = {
  created: 'Created',
  added: 'Added',
  removed: 'Removed',
  changed: 'Edited',
  edited: 'Edited',
};

type HistoryRow = { label: string; date: string; via: string; last?: boolean };

/** Build the rows shown in the history popup, mirroring the PC app's note-title tooltip. */
function buildHistoryRows(entries: HistoryEntry[]): HistoryRow[] {
  const rows: HistoryRow[] = entries
    .filter((e) => !isNaN(Date.parse(e.at)))
    .map((e) => ({
      label: ACT_LABEL[e.act] ?? 'Edited',
      date: formatDate(Date.parse(e.at)),
      via: e.act === 'created' && (e.via === 'myNote' || e.via === 'mobile') ? '' : e.via,
    }));
  const nonCreated = entries.filter((e) => e.act !== 'created' && !isNaN(Date.parse(e.at)));
  if (nonCreated.length) {
    const last = nonCreated.reduce((a, b) => (Date.parse(a.at) >= Date.parse(b.at) ? a : b));
    rows.push({ label: 'Last change', date: formatDate(Date.parse(last.at)), via: last.via, last: true });
  }
  return rows;
}

// markdown-it blocks "file:" links/images by default (XSS hardening for untrusted web content).
// Our content is local-only, so allow it — otherwise image markdown is emitted as literal text.
const markdownIt = MarkdownIt({ typographer: true });
markdownIt.validateLink = () => true;

function trimTrailingNewline(s: string): string {
  return typeof s === 'string' && s.endsWith('\n') ? s.slice(0, -1) : s;
}

/** Markdown render rules. Theme-aware so fenced code blocks get a themed copy button. */
/** True if the AST node or any descendant is an image token. */
function hasImageNode(node: any): boolean {
  if (node.type === 'image') return true;
  return (node.children ?? []).some(hasImageNode);
}

function makeRules(t: Theme) {
  return {
    text: (node: any, children: any, parent: any, styles: any, inheritedStyles = {}) => (
      <Text key={node.key} style={[inheritedStyles, styles.text]} selectable>
        {node.content}
      </Text>
    ),
    textgroup: (node: any, children: any, parent: any, styles: any) => (
      <Text key={node.key} style={styles.textgroup} selectable>
        {children}
      </Text>
    ),
    paragraph: (node: any, children: any, parent: any, styles: any) => {
      // On Android, View (FitImage) inside Text silently disappears.
      // When a paragraph contains an image, wrap with View instead of Text.
      if ((node.children ?? []).some(hasImageNode)) {
        return <View key={node.key} style={{ paddingVertical: 4 }}>{children}</View>;
      }
      return (
        <Text key={node.key} style={styles.paragraph} selectable>
          {children}
        </Text>
      );
    },
    image: (node: any, children: any, parent: any, styles: any) => {
      const { src, alt } = node.attributes;
      return (
        <FitImage
          key={node.key}
          indicator={false}
          style={styles._VIEW_SAFE_image}
          source={{ uri: src }}
          accessible={!!alt}
          accessibilityLabel={alt}
        />
      );
    },
    fence: (node: any) => <CodeBlock key={node.key} content={trimTrailingNewline(node.content)} t={t} />,
    code_block: (node: any) => <CodeBlock key={node.key} content={trimTrailingNewline(node.content)} t={t} />,
  };
}

function formatDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()} ${months[d.getMonth()]} ${d.getDate()} at ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Matches a markdown image/link whose target is an /attachments/... path. The path portion
// allows one level of nested parentheses ("([^)]*(?:\([^)]*\)[^)]*)*)") because attachment
// filenames frequently contain them — e.g. "Moto Guide (SamBelony) (720p, h264).mp4". A plain
// "[^)]+" stopped at the first ")" and silently mangled any such link (the audio file, having no
// parens, happened to work, which masked the bug).
const ATTACHMENT_LINK_RE = /(!?)\[([^\]]*)\]\(\/?attachments\/([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
const ATTACHMENT_LINE_RE = /^!?\[[^\]]*\]\([^()]*(?:\([^()]*\)[^()]*)*\)$/;

/**
 * Rewrites "![alt](/attachments/images/foo.jpg)" and "[label](/attachments/audio/foo.mp3)" to
 * local file:// URIs so they actually open. Markdown encodes the path (e.g. "%20" for spaces)
 * but the file on disk isn't encoded, so it must be decoded before the local lookup.
 *
 * If an attachment can't be resolved locally it hasn't synced down to this device — large files
 * (e.g. videos) can lag well behind notes, and GitHub's blob API rejects anything above ~50MB
 * outright. The link is left intact (in case it arrives on a later sync) with an explanatory line
 * appended underneath, rather than a dead link that spins forever trying to load.
 */
function resolveAttachmentLinks(md: string): string {
  const resolved = md.replace(ATTACHMENT_LINK_RE, (whole, bang, label, relPath) => {
    const decoded = decodeURIComponent(relPath);
    const uri = resolveAttachmentUri(`attachments/${decoded}`);
    if (!uri) {
      // The link above already shows the filename, so don't repeat it here.
      return `${whole}\n\n*Not on this device yet — it may still be syncing, or it's too large to transfer (large files can't move via GitHub; use Google Drive or copy it manually).*`;
    }
    return `${bang}[${label}](${uri})`;
  });
  // A line that's only an image/attachment link is a soft-wrapped continuation of the previous
  // paragraph in CommonMark (single \n), so it renders tiny and inline like normal text. The PC
  // browser only looks block-level because of CSS — force the same look with real paragraph breaks.
  return resolved
    .split('\n')
    .map((line) => (ATTACHMENT_LINE_RE.test(line.trim()) ? `\n${line}\n` : line))
    .join('\n');
}

type BodySegment = { start: number; end: number } & (
  | { type: 'md'; text: string }
  | { type: 'video'; uri: string; label: string }
  | { type: 'audio'; uri: string; label: string }
  | { type: 'media-missing'; kind: 'video' | 'audio'; label: string }
);

/**
 * Break a run of markdown into blocks, giving standalone image lines a block of
 * their own. Each block carries its source offsets, so a scroll position can be
 * translated back to a character offset in the note. Images are split out
 * because they occupy a lot of rendered height for very little source text —
 * without that, the mapping drifts badly on image-heavy notes.
 */
function splitMdRun(text: string, base: number): BodySegment[] {
  const out: BodySegment[] = [];
  let buf = '';
  let bufStart = base;
  let pos = base;
  const flush = () => {
    if (buf.trim()) out.push({ type: 'md', text: buf, start: bufStart, end: pos });
    buf = '';
  };
  for (const line of text.split('\n')) {
    const lineEnd = pos + line.length + 1;
    if (ATTACHMENT_LINE_RE.test(line.trim())) {
      flush();
      out.push({ type: 'md', text: line, start: pos, end: lineEnd });
      bufStart = lineEnd;
    } else {
      if (!buf) bufStart = pos;
      buf += (buf ? '\n' : '') + line;
    }
    pos = lineEnd;
  }
  flush();
  return out;
}

/**
 * Splits the note body into markdown chunks and inline media (audio/video) chunks. Audio/video
 * attachment links that resolve to a local file are pulled out and rendered as native players
 * (mirroring the PC app's embedded <audio>/<video controls>); everything else — text, images,
 * not-yet-synced links — stays as markdown.
 */
function segmentBody(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let lastIndex = 0;
  const re = new RegExp(ATTACHMENT_LINK_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const [whole, bang, , relPath] = m;
    if (bang) continue; // images (![...]) stay inline in markdown
    const decoded = decodeURIComponent(relPath);
    const fileName = decoded.split('/').pop() ?? decoded;
    const kind = mediaKind(fileName);
    if (!kind) continue;
    const uri = resolveAttachmentUri(`attachments/${decoded}`);
    if (m.index > lastIndex) {
      segments.push(...splitMdRun(body.slice(lastIndex, m.index), lastIndex));
    }
    const end = m.index + whole.length;
    segments.push(uri
      ? { type: kind, uri, label: fileName, start: m.index, end }
      : { type: 'media-missing', kind, label: fileName, start: m.index, end }
    );
    lastIndex = end;
  }
  if (lastIndex < body.length) {
    segments.push(...splitMdRun(body.slice(lastIndex), lastIndex));
  }
  return segments.length ? segments : [{ type: 'md', text: body, start: 0, end: body.length }];
}

export default function ViewScreen({ route, navigation }: any) {
  const { theme: t } = useThemeCtx();
  const insets = useSafeAreaInsets();
  const { name } = route.params as { name: string };
  const [body, setBody] = useState('');
  const [encrypted, setEncrypted] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<TextInput>(null);
  const lastTapRef = useRef(0);
  const scrollYRef = useRef(0);
  const layoutsRef = useRef<Map<number, { y: number; h: number }>>(new Map());
  const segmentsRef = useRef<BodySegment[]>([]);
  // Read through a ref, never the state: the header button's closure is built by
  // an effect that only re-runs on [name, t], so it would otherwise capture the
  // empty body from mount and clamp every offset to 0.
  const bodyRef = useRef('');
  bodyRef.current = body;

  /**
   * Character offset in the note source corresponding to the top of the
   * viewport, so the editor can open where reading left off. Finds the block
   * straddling the scroll position and interpolates within it.
   */
  function currentSourceOffset(): number {
    const y = scrollYRef.current;
    // Block ends are computed per line and can run one past the final line,
    // which has no trailing newline — clamp so the caller always gets a real
    // index into the note.
    const clamp = (n: number) => Math.max(0, Math.min(n, bodyRef.current.length));
    if (y <= 0) return 0;
    let passed = 0;
    let hit = -1;
    let result = 0;
    for (const [i, l] of layoutsRef.current) {
      const seg = segmentsRef.current[i];
      if (!seg) continue;
      if (y >= l.y && y < l.y + l.h) {
        const frac = l.h > 0 ? (y - l.y) / l.h : 0;
        hit = i;
        result = clamp(Math.round(seg.start + frac * (seg.end - seg.start)));
        break;
      }
      if (l.y + l.h <= y) passed = Math.max(passed, seg.end);
    }
    if (hit < 0) result = clamp(passed);
    console.log(`[editpos] scrollY=${Math.round(y)} blocks=${segmentsRef.current.length} ` +
                `layouts=${layoutsRef.current.size} hitBlock=${hit} bodyLen=${bodyRef.current.length} ` +
                `→ offset=${result}`);
    return result;
  }

  useEffect(() => {
    const { created, changed } = getNoteDates(name);
    navigation.setOptions({
      headerStyle: { backgroundColor: t.bgSurface },
      headerTintColor: t.textPrimary,
      // The note's own title is already shown in the body, so the header only carries the
      // created/changed dates — tapping them opens the full edit history (like the PC note-title).
      headerTitle: () => (
        <Pressable onPress={() => setHistoryOpen(true)} hitSlop={8}>
          <Text style={{ color: t.textMuted, fontSize: 11 }} numberOfLines={1}>
            {created ? `Created: ${formatDate(created)}` : ''}
          </Text>
          {!!changed && changed !== created && (
            <Text style={{ color: t.textMuted, fontSize: 11 }} numberOfLines={1}>
              Last change: {formatDate(changed)}
            </Text>
          )}
        </Pressable>
      ),
      headerRight: () => (
        <View style={{ flexDirection: 'row', marginRight: 4 }}>
          <Pressable
            hitSlop={8}
            style={{ padding: 6 }}
            onPress={() => {
              const startOffset = currentSourceOffset();
              if (isNoteEncrypted(name)) {
                if (isSessionActive(name)) {
                  navigation.navigate('Editor', { name, isLockedSession: true, startOffset });
                } else {
                  Alert.alert('Locked', 'Unlock the note first to edit it.');
                }
              } else {
                navigation.navigate('Editor', { name, startOffset });
              }
            }}
          >
            <Feather name="edit-2" size={19} color={t.textMuted} />
          </Pressable>
          <Pressable
            hitSlop={8}
            style={{ padding: 6 }}
            onPress={() => navigation.navigate('Tags', { name })}
          >
            <Feather name="tag" size={19} color={t.textMuted} />
          </Pressable>
        </View>
      ),
    });
  }, [name, t]);

  useFocusEffect(
    useCallback(() => {
      Keyboard.dismiss();
      const isEnc = isNoteEncrypted(name);
      if (!isEnc) {
        setEncrypted(false);
        readNoteBody(name).then((text) => {
          setBody(text);
          setLoaded(true);
        });
      } else if (isSessionActive(name)) {
        // Session was just unlocked — show decrypted content in read-only view
        try {
          const text = readActiveSessionBody(name);
          setBody(text);
          setEncrypted(false);
        } catch {
          setEncrypted(true);
        }
        setLoaded(true);
      } else {
        setEncrypted(true);
        setLoaded(true);
      }
    }, [name])
  );

  // Layouts are deliberately not cleared when the body changes: the effect could
  // run after onLayout had already measured the new blocks and wipe them, and a
  // stale entry is harmless anyway — lookups go through segmentsRef and skip any
  // index the current note doesn't have.

  function onLinkPress(url: string): boolean {
    if (url.startsWith('file://')) {
      (async () => {
        try {
          if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(url);
          } else {
            await Linking.openURL(url);
          }
        } catch (e: any) {
          Alert.alert('Could not open attachment', e.message ?? String(e));
        }
      })();
      return false; // we handled it — don't let the library also try Linking.openURL
    }
    return true;
  }

  // Rendered as an in-window absolute overlay instead of a Modal so the Android system
  // navigation bar colour never changes (Modals open a separate Dialog window that resets it).
  const historyOverlay = historyOpen ? (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Pressable style={[StyleSheet.absoluteFill, styles.overlayBackdrop]} onPress={() => setHistoryOpen(false)} />
      <View style={styles.overlayCenter} pointerEvents="box-none">
        <View style={[styles.modalBox, { backgroundColor: t.bgRaised, borderColor: t.border }]}>
          <Text style={[styles.modalTitle, { color: t.textPrimary }]}>History</Text>
          <ScrollView bounces={false} showsVerticalScrollIndicator>
            {(() => {
              const rows = buildHistoryRows(getNoteHistory(name));
              if (!rows.length) return <Text style={{ color: t.textMuted }}>No history recorded.</Text>;
              return rows.map((r, i) => (
                <View key={i} style={[styles.histRow, r.last && { borderTopColor: t.border, borderTopWidth: 1, marginTop: 6, paddingTop: 8 }]}>
                  <Text selectable style={[styles.histLabel, { color: r.last ? t.accent : t.textMuted }]}>{r.label}:</Text>
                  <Text selectable style={[styles.histDate, { color: t.textPrimary }]}>{r.date}</Text>
                  {!!r.via && <Text selectable style={[styles.histVia, { color: t.textMuted }]}>via {r.via}</Text>}
                </View>
              ));
            })()}
          </ScrollView>
        </View>
      </View>
    </View>
  ) : null;

  let content: ReactNode;
  if (!loaded) {
    content = <View style={[styles.container, { backgroundColor: t.bgBase }]} />;
  } else if (encrypted) {
    content = (
      <View style={[styles.container, styles.lockedWrap, { backgroundColor: t.bgBase }]}>
        <Feather name="lock" size={40} color={t.textMuted} />
        <Text style={[styles.lockedText, { color: t.textMuted }]}>
          This note is locked.{'\n'}Tap the Lock button to unlock it.
        </Text>
      </View>
    );
  } else {
    const mdStyle = {
      body: { color: t.textPrimary, fontSize: 16 },
      heading1: { color: t.textPrimary },
      heading2: { color: t.textPrimary },
      link: { color: t.accent },
      image: { marginVertical: 8 },
      code_inline: { backgroundColor: t.bgSurface, color: t.textPrimary },
      blockquote: { backgroundColor: t.bgSurface, borderLeftColor: t.accent },
      hr: { backgroundColor: t.border },
    };
    const segments = segmentBody(body);
    segmentsRef.current = segments;
    const q = searchQuery.trim().toLowerCase();
    const matchCount = q
      ? (body.toLowerCase().match(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length
      : 0;

    function handleDoubleTap() {
      const now = Date.now();
      if (now - lastTapRef.current < 350) {
        setSearchVisible(true);
      }
      lastTapRef.current = now;
    }

    content = (
      <View style={{ flex: 1 }}>
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
            />
            {q ? (
              <Text style={[styles.searchCount, { color: t.textMuted }]}>{matchCount} match{matchCount !== 1 ? 'es' : ''}</Text>
            ) : null}
            <Pressable onPress={() => { setSearchVisible(false); setSearchQuery(''); Keyboard.dismiss(); }} hitSlop={8} style={{ padding: 6 }}>
              <Feather name="x" size={16} color={t.textMuted} />
            </Pressable>
          </View>
        )}
      <ScrollView
        style={[styles.container, { backgroundColor: t.bgBase }]}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(insets.bottom, 24) + 24 }]}
        onTouchEnd={handleDoubleTap}
        onScroll={(e) => { scrollYRef.current = e.nativeEvent.contentOffset.y; }}
        scrollEventThrottle={64}
      >
        {segments.map((seg, i) => {
          let inner: ReactNode;
          if (seg.type === 'video') {
            inner = <VideoAttachment uri={seg.uri} label={seg.label} t={t} />;
          } else if (seg.type === 'audio') {
            inner = <AudioAttachment uri={seg.uri} label={seg.label} t={t} />;
          } else if (seg.type === 'media-missing') {
            inner = <MediaUnavailableCard kind={seg.kind} label={seg.label} t={t} />;
          } else {
            let text = resolveAttachmentLinks(seg.text).trim();
            if (!text) return null;
            // When searching, filter to lines containing the query and wrap matches in bold
            if (q) {
              const lines = text.split('\n');
              const matched = lines.filter((l) => l.toLowerCase().includes(q));
              if (!matched.length) return null;
              const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              text = matched
                .map((l) => l.replace(new RegExp(`(${escaped})`, 'gi'), '**$1**'))
                .join('\n\n');
            }
            inner = (
              <Markdown markdownit={markdownIt} rules={makeRules(t)} onLinkPress={onLinkPress} style={mdStyle}>
                {text}
              </Markdown>
            );
          }
          return (
            <View
              key={`b${i}`}
              onLayout={(e) => {
                const { y, height } = e.nativeEvent.layout;
                layoutsRef.current.set(i, { y, h: height });
              }}
            >
              {inner}
            </View>
          );
        })}
      </ScrollView>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {content}
      {historyOverlay}
    </View>
  );
}

const codeStyles = StyleSheet.create({
  // marginVertical gives breathing room between consecutive code blocks so they don't visually collide.
  wrap: { borderWidth: 1, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, marginVertical: 10 },
  copyBtn: { position: 'absolute', top: 6, right: 6, zIndex: 1, borderWidth: 1, borderRadius: 6, padding: 6 },
  code: { fontFamily: 'monospace', fontSize: 13, lineHeight: 19, paddingRight: 28 },
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { padding: 16 },
  searchBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1 },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 4 },
  searchCount: { fontSize: 12, marginRight: 4 },
  lockedWrap: { justifyContent: 'center', alignItems: 'center', gap: 16 },
  lockedText: { textAlign: 'center', fontSize: 14, lineHeight: 20 },
  overlayBackdrop: { backgroundColor: 'rgba(0,0,0,0.5)' },
  overlayCenter: { flex: 1, justifyContent: 'center', padding: 24 },
  modalBox: { borderRadius: 10, borderWidth: 1, padding: 18, maxHeight: '80%' },
  modalTitle: { fontSize: 16, fontWeight: '700', marginBottom: 12 },
  histRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', paddingVertical: 3 },
  histLabel: { fontSize: 12, fontWeight: '600', width: 86 },
  histDate: { fontSize: 12, flexShrink: 1 },
  histVia: { fontSize: 11, marginLeft: 6, fontStyle: 'italic' },
});
