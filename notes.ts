import { Directory, File, Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import { decryptNoteBody, encryptNoteBody, deriveKey, extractSalt, decryptWithKey, encryptWithKey } from './lib/crypto';

const SESSION_MS = 5 * 60 * 1000;
const sessionKeys = new Map<string, { key: Uint8Array; salt: Uint8Array; expiresAt: number }>();

export type NoteMeta = {
  name: string;       // filename, e.g. "todo.md"
  title: string;      // display title from H1 heading, or filename without .md
  modifiedAt: number; // ms epoch
  createdAt: number;  // ms epoch
};

export type LockedNoteMeta = {
  name: string;
  title: string;
};

const TRASH_TAG = 'trash';
const notesDirInstance = new Directory(Paths.document, 'notes');
const attachmentsDirInstance = new Directory(Paths.document, 'attachments');
export const ATTACHMENT_CATEGORIES = ['images', 'documents', 'videos', 'audio', 'archives'] as const;

export function attachmentsDir(): Directory {
  return attachmentsDirInstance;
}

/** Resolves a note's "/attachments/<cat>/<file>" reference to a local file:// URI, if it exists. */
export function resolveAttachmentUri(relPath: string): string | null {
  const clean = relPath.replace(/^\/?attachments\//, '');
  const parts = clean.split('/');
  const file = parts.length === 2
    ? new File(new Directory(attachmentsDirInstance, parts[0]), parts[1])
    : new File(attachmentsDirInstance, clean);
  if (file.exists) return file.uri;
  console.warn(`[attachment] NOT FOUND: "${relPath}" → uri="${file.uri}"`);
  return null;
}

const SYNC_SIZE_LIMIT = 47 * 1024 * 1024;

/** Returns true if any attachment referenced in the content exceeds the 47 MB GitHub sync limit. */
export function contentHasOversizedAttachment(content: string): boolean {
  const re = /!?\[[^\]]*\]\(\/?attachments\/([^()\n]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const clean = m[1].replace(/^\/?attachments\//, '');
    const parts = clean.split('/');
    const file = parts.length === 2
      ? new File(new Directory(attachmentsDirInstance, parts[0]), parts[1])
      : new File(attachmentsDirInstance, clean);
    if (file.exists && file.size > SYNC_SIZE_LIMIT) return true;
  }
  return false;
}

/** Lists all attachment files currently on-disk — call from Metro console to debug missing images. */
export function debugListAttachments(): void {
  console.log('[attachments] base:', attachmentsDirInstance.uri, 'exists:', attachmentsDirInstance.exists);
  for (const cat of ATTACHMENT_CATEGORIES) {
    const catDir = new Directory(attachmentsDirInstance, cat);
    if (!catDir.exists) { console.log(`  ${cat}/ — not found`); continue; }
    const files = catDir.list().filter((e): e is File => e instanceof File);
    console.log(`  ${cat}/: ${files.length} file(s) — ${files.map((f) => f.name).join(', ') || '(empty)'}`);
  }
}

// ─── Deletions log (.deletions.json) ────────────────────────────────────────

type DeletionEntry = { path: string; type: 'note' | 'attachment'; deleted_at: number };
type DeletionsDoc = { settings?: Record<string, unknown>; deletions: DeletionEntry[] };

function readDeletions(): DeletionsDoc {
  const f = new File(notesDirInstance, '.deletions.json');
  if (!f.exists) return { deletions: [] };
  try {
    const doc = JSON.parse(f.textSync()) as DeletionsDoc;
    return { settings: doc.settings, deletions: Array.isArray(doc.deletions) ? doc.deletions : [] };
  } catch {
    return { deletions: [] };
  }
}

function writeDeletions(doc: DeletionsDoc): void {
  ensureDir(notesDirInstance);
  const f = new File(notesDirInstance, '.deletions.json');
  try {
    if (!f.exists) f.create();
    f.write(JSON.stringify(doc, null, 2));
    console.log(`[deletions] wrote ${doc.deletions.length} entries, exists=${f.exists}`);
  } catch (err: any) {
    console.error('[deletions] writeDeletions FAILED:', err?.message ?? err);
  }
}

/** Returns the set of note/attachment paths that have been permanently deleted. */
export function getDeletedPaths(): Set<string> {
  const f = new File(notesDirInstance, '.deletions.json');
  if (!f.exists) return new Set();
  try {
    const doc = JSON.parse(f.textSync()) as DeletionsDoc;
    return new Set((Array.isArray(doc.deletions) ? doc.deletions : []).map((d) => d.path));
  } catch {
    return new Set();
  }
}

// Matches "[label](/attachments/<cat>/<file>)" links in note body.
const ATTACH_LINK_RE = /!?\[[^\]]*\]\(\/?attachments\/([^()\n]+(?:\([^()\n]*\)[^()\n]*)*)\)/g;

/**
 * Permanently deletes all trashed notes (and their locally-stored attachments),
 * appends entries to .deletions.json, and returns the count of deleted notes.
 */
export async function emptyTrash(): Promise<number> {
  ensureDir(notesDirInstance);
  const now = Date.now() / 1000;
  const newEntries: DeletionEntry[] = [];

  for (const e of notesDirInstance.list()) {
    if (!(e instanceof File) || !e.name.endsWith('.md')) continue;
    let content: string;
    try { content = e.textSync(); } catch { continue; }
    const parsed = parseFrontmatter(content);
    if (!parsed || !isTrashedFm(parsed.fm)) continue;

    // Delete locally-stored attachments referenced by this note.
    const body = parsed.body;
    ATTACH_LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ATTACH_LINK_RE.exec(body)) !== null) {
      const relPath = decodeURIComponent(m[1]); // e.g. "videos/filename.mp4"
      const parts = relPath.split('/');
      if (parts.length !== 2) continue;
      const localFile = new File(new Directory(attachmentsDirInstance, parts[0]), parts[1]);
      if (!localFile.exists) continue;
      localFile.delete();
      newEntries.push({ path: relPath, type: 'attachment', deleted_at: now });
    }

    // Delete the note and its history sidecar.
    newEntries.push({ path: e.name, type: 'note', deleted_at: now });
    e.delete();
    const hist = new File(notesDirInstance, historyName(e.name));
    if (hist.exists) hist.delete();
  }

  console.log(`[emptyTrash] found ${newEntries.length} entries to delete`);
  if (newEntries.length) {
    const doc = readDeletions();
    doc.deletions.push(...newEntries);
    if (doc.settings) (doc.settings as any).lastchanged = now;
    writeDeletions(doc);
  }

  return newEntries.filter((e) => e.type === 'note').length;
}

function parseFrontmatter(content: string): { fm: string; body: string } | null {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return null;
  return { fm: m[1], body: content.slice(m[0].length) };
}

function isEncrypted(fm: string): boolean {
  return /^encrypted:\s*true/m.test(fm);
}

function isTrashedFm(fm: string): boolean {
  return parseTagsFromFm(fm).includes(TRASH_TAG);
}

function extractTitle(content: string, fallbackName: string): string {
  const parsed = parseFrontmatter(content);
  const body = parsed ? parsed.body : content;
  const m = body.match(/^#\s+(.+)/m);
  if (m) return m[1].trim();
  // Strip the _XXXXXXXX random suffix added by generateNoteFilename
  const base = fallbackName.replace(/\.md$/, '');
  const sm = base.match(/^(.+)_[A-Za-z0-9]{8}$/);
  return sm ? sm[1] : base;
}

const SUFFIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomAlphaNum(len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += SUFFIX_CHARS[Math.floor(Math.random() * SUFFIX_CHARS.length)];
  }
  return s;
}

/**
 * Generates a unique filename for a new note: "Title_XXXXXXXX.md"
 * Retries until the suffix is not already used by an existing file or a deletions entry,
 * preventing .deletions.json from silently deleting a recreated note with the same name.
 */
export function generateNoteFilename(title: string): string {
  ensureDir(notesDirInstance);
  const deleted = getDeletedPaths();
  for (let attempt = 0; attempt < 20; attempt++) {
    const name = `${title}_${randomAlphaNum(8)}.md`;
    if (!new File(notesDirInstance, name).exists && !deleted.has(name)) return name;
  }
  return `${title}_${Date.now().toString(36)}.md`;
}

function ensureDir(dir: Directory) {
  if (!dir.exists) {
    dir.create({ intermediates: true });
  }
}

// ---------------------------------------------------------------------------
// Note history (sidecar *.history.json) — mirrors the PC app's mechanism.
// Only real content changes append an entry, so the history's last timestamp
// is a reliable "last genuinely edited" signal for sync conflict resolution
// (unlike filesystem mtime, which can be bumped by no-op resaves).
// ---------------------------------------------------------------------------

function historyName(name: string): string {
  return name.replace(/\.md$/, '') + '.history.json';
}

export type HistoryEntry = { at: string; via: string; act: string };

/** Public read of a note's edit history (sidecar *.history.json), oldest entry first. */
export function getNoteHistory(name: string): HistoryEntry[] {
  return readHistoryEntries(name);
}

function readHistoryEntries(name: string): HistoryEntry[] {
  const f = new File(notesDirInstance, historyName(name));
  if (!f.exists) return [];
  try {
    const data = JSON.parse(f.textSync());
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function appendHistory(name: string, act: 'created' | 'edited'): void {
  const entries = readHistoryEntries(name);
  // Keep full ISO8601 with the trailing 'Z' so Date.parse treats it as UTC, not local time.
  entries.push({ at: new Date().toISOString(), via: 'mobile', act });
  const f = new File(notesDirInstance, historyName(name));
  if (!f.exists) f.create();
  f.write(JSON.stringify(entries));
}

/** Appends a history entry only if the content actually changed. */
function touchHistoryIfChanged(name: string, oldContent: string | null, newContent: string): void {
  if (oldContent === newContent) return;
  appendHistory(name, oldContent === null ? 'created' : 'edited');
}

/**
 * Earliest ('first' = created) or latest ('last' = changed) timestamp across ALL history
 * entries, in epoch milliseconds, or null if no history exists yet. Uses min/max rather than
 * the array's first/last element so it's robust to out-of-order entries and to mixed date
 * formats (PC writes local-time ISO without a 'Z'; the phone writes UTC ISO with one — both
 * parse to a comparable absolute instant via Date.parse).
 */
function historyTimestampMs(name: string, which: 'first' | 'last'): number | null {
  const entries = readHistoryEntries(name);
  if (!entries.length) return null;
  let best: number | null = null;
  for (const e of entries) {
    const t = Date.parse(e.at);
    if (isNaN(t)) continue;
    if (best === null) best = t;
    else if (which === 'first') best = Math.min(best, t);
    else best = Math.max(best, t);
  }
  return best;
}

/**
 * The most reliable "last real edit" timestamp for this note, in epoch seconds.
 * Falls back to filesystem mtime when there's no history yet.
 */
export function lastEditEpoch(name: string): number {
  const ms = historyTimestampMs(name, 'last');
  if (ms !== null) return ms / 1000;
  const f = new File(notesDirInstance, name);
  // modificationTime is in milliseconds — convert to epoch seconds to match the rest of this function.
  return f.exists ? (f.modificationTime ?? 0) / 1000 : 0;
}

/** All .md files regardless of trash status — used by sync, which must still push/pull trashed notes. */
export async function listAllNoteFiles(): Promise<NoteMeta[]> {
  ensureDir(notesDirInstance);
  const entries = notesDirInstance.list();
  const metas: NoteMeta[] = entries
    .filter((e): e is File => e instanceof File && e.name.endsWith('.md'))
    .map((f) => ({
      name: f.name,
      title: f.name.replace(/\.md$/, ''),
      // History timestamps reflect the note's real creation/edit dates (e.g. from Notable/Telegram
      // import or a prior PC edit) — filesystem mtime/creationTime only reflect when this device
      // last downloaded the file, which is wrong for sorting by "Created"/"Changed".
      modifiedAt: historyTimestampMs(f.name, 'last') ?? f.modificationTime ?? 0,
      createdAt: historyTimestampMs(f.name, 'first') ?? f.creationTime ?? f.modificationTime ?? 0,
    }));
  metas.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return metas;
}

export async function listNotes(): Promise<NoteMeta[]> {
  const all = await listAllNoteFiles();
  const result: NoteMeta[] = [];
  for (const m of all) {
    const file = new File(notesDirInstance, m.name);
    const content = file.textSync();
    const parsed = parseFrontmatter(content);
    if (parsed && isTrashedFm(parsed.fm)) continue;
    result.push({ ...m, title: extractTitle(content, m.name) });
  }
  return result;
}

export async function readNote(name: string): Promise<string> {
  const file = new File(notesDirInstance, name);
  return file.text();
}

export async function writeNote(name: string, content: string): Promise<void> {
  ensureDir(notesDirInstance);
  const file = new File(notesDirInstance, name);
  if (!file.exists) {
    file.create();
  }
  file.write(content);
}

/** Body only, with any frontmatter block (tags, encrypted, id, ...) stripped — for editing. */
export async function readNoteBody(name: string): Promise<string> {
  const file = new File(notesDirInstance, name);
  if (!file.exists) return '';
  const content = file.textSync();
  const parsed = parseFrontmatter(content);
  return parsed ? parsed.body : content;
}

/** Writes the body while preserving any existing frontmatter block untouched. */
export function writeNoteBody(name: string, body: string): void {
  ensureDir(notesDirInstance);
  const file = new File(notesDirInstance, name);
  if (!file.exists) {
    file.create();
    file.write(body);
    touchHistoryIfChanged(name, null, body);
    return;
  }
  const content = file.textSync();
  const parsed = parseFrontmatter(content);
  const oldBody = parsed ? parsed.body : content;
  file.write(parsed ? `---\n${parsed.fm}\n---\n${body}` : body);
  touchHistoryIfChanged(name, oldBody, body);
}

/**
 * Like writeNoteBody but never appends a history entry.
 * Use for debounced auto-saves during active editing; call recordNoteHistory
 * once when the editing session ends to record a single history entry.
 */
export function autoSaveNoteBody(name: string, body: string): void {
  ensureDir(notesDirInstance);
  const file = new File(notesDirInstance, name);
  if (!file.exists) {
    file.create();
    file.write(body);
    return;
  }
  const content = file.textSync();
  const parsed = parseFrontmatter(content);
  file.write(parsed ? `---\n${parsed.fm}\n---\n${body}` : body);
}

/**
 * Records a history entry for a note if the body changed from what it was
 * when the editing session started. Call once on editor unmount.
 */
export function recordNoteHistory(name: string, bodyAtSessionStart: string | null, currentBody: string): void {
  touchHistoryIfChanged(name, bodyAtSessionStart, currentBody);
}

/** Sets or clears the trashed_at frontmatter field, mirroring the PC app's _set_trashed_at. */
function setTrashedAt(name: string, ts: number | null): void {
  const file = new File(notesDirInstance, name);
  const content = file.textSync();
  const parsed = parseFrontmatter(content);
  if (!parsed) {
    if (ts === null) return;
    file.write(`---\ntrashed_at: ${ts}\n---\n${content}`);
    return;
  }
  let fm = parsed.fm.replace(/^trashed_at:[ \t]*.*\n?/m, '');
  if (ts !== null) fm = `trashed_at: ${ts}\n${fm}`;
  fm = fm.replace(/^\n+/, '').replace(/\n+$/, '');
  file.write(`---\n${fm}\n---\n${parsed.body}`);
}

/** Send a note to Trash: adds the 'trash' tag and sets trashed_at — same scheme the PC app uses. */
export async function deleteNote(name: string): Promise<void> {
  const tags = getTags(name);
  if (!tags.includes(TRASH_TAG)) tags.push(TRASH_TAG);
  setTags(name, tags);
  setTrashedAt(name, Date.now() / 1000);
}

export async function renameNote(oldName: string, newName: string): Promise<void> {
  const file = new File(notesDirInstance, oldName);
  await file.move(new File(notesDirInstance, newName));
}

export async function listTrash(): Promise<NoteMeta[]> {
  ensureDir(notesDirInstance);
  const entries = notesDirInstance.list();
  const metas: NoteMeta[] = [];
  for (const e of entries) {
    if (!(e instanceof File) || !e.name.endsWith('.md')) continue;
    const content = e.textSync();
    const parsed = parseFrontmatter(content);
    if (!parsed || !isTrashedFm(parsed.fm)) continue;
    metas.push({
      name: e.name,
      title: extractTitle(content, e.name),
      modifiedAt: historyTimestampMs(e.name, 'last') ?? e.modificationTime ?? 0,
      createdAt: historyTimestampMs(e.name, 'first') ?? e.creationTime ?? e.modificationTime ?? 0,
    });
  }
  metas.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return metas;
}

export async function restoreFromTrash(name: string): Promise<void> {
  const tags = getTags(name).filter((t) => t !== TRASH_TAG);
  setTags(name, tags);
  setTrashedAt(name, null);
}

export async function listLockedNotes(): Promise<LockedNoteMeta[]> {
  ensureDir(notesDirInstance);
  const result: LockedNoteMeta[] = [];
  for (const e of notesDirInstance.list()) {
    if (!(e instanceof File) || !e.name.endsWith('.md')) continue;
    const content = e.textSync();
    const parsed = parseFrontmatter(content);
    if (parsed && isEncrypted(parsed.fm)) {
      result.push({ name: e.name, title: extractTitle(content, e.name) });
    }
  }
  return result;
}

/** Permanently decrypt a locked note in place. Throws if the password is wrong. */
export async function unlockNoteForever(name: string, password: string): Promise<void> {
  const file = new File(notesDirInstance, name);
  const content = file.textSync();
  const parsed = parseFrontmatter(content);
  if (!parsed || !isEncrypted(parsed.fm)) {
    throw new Error('Note is not locked');
  }
  const plaintext = await decryptNoteBody(parsed.body.trim(), password);

  let fm = parsed.fm.replace(/^encrypted:[ \t]*.*\n?/m, '').replace(/\n+$/, '');
  const newContent = fm ? `---\n${fm}\n---\n${plaintext}` : plaintext;
  file.write(newContent);
}

export function isNoteEncrypted(name: string): boolean {
  const file = new File(notesDirInstance, name);
  if (!file.exists) return false;
  const parsed = parseFrontmatter(file.textSync());
  return !!parsed && isEncrypted(parsed.fm);
}

export function getNoteTitle(name: string): string {
  const file = new File(notesDirInstance, name);
  return extractTitle(file.textSync(), name);
}

/** Created/changed timestamps (epoch ms) for display — same history-derived source as the sort bar. */
export function getNoteDates(name: string): { created: number; changed: number } {
  const f = new File(notesDirInstance, name);
  return {
    created: historyTimestampMs(name, 'first') ?? f.creationTime ?? f.modificationTime ?? 0,
    changed: historyTimestampMs(name, 'last') ?? f.modificationTime ?? 0,
  };
}

/**
 * Open a locked note for a temporary session: decrypts but does not modify the file.
 * Derives the AES key once and caches it (keyed by note name) so subsequent
 * autosaves during the session don't re-run the expensive PBKDF2 (100k iters).
 */
export async function openLockedSession(name: string, password: string): Promise<string> {
  const t0 = Date.now();
  const file = new File(notesDirInstance, name);
  const parsed = parseFrontmatter(file.textSync());
  console.log(`[unlock] read+parse: ${Date.now() - t0}ms`);
  if (!parsed || !isEncrypted(parsed.fm)) throw new Error('Note is not locked');
  const b64 = parsed.body.trim();
  const salt = extractSalt(b64);
  const t1 = Date.now();
  const key = await deriveKey(password, salt);
  console.log(`[unlock] deriveKey (PBKDF2): ${Date.now() - t1}ms`);
  sessionKeys.set(name, { key, salt, expiresAt: Date.now() + SESSION_MS });
  const t2 = Date.now();
  const result = decryptWithKey(b64, key);
  console.log(`[unlock] decryptWithKey: ${Date.now() - t2}ms`);
  console.log(`[unlock] TOTAL: ${Date.now() - t0}ms`);
  return result;
}

/** True if this note was unlocked recently and the session hasn't expired yet. */
export function isSessionActive(name: string): boolean {
  const s = sessionKeys.get(name);
  if (!s) return false;
  if (Date.now() > s.expiresAt) {
    sessionKeys.delete(name);
    return false;
  }
  return true;
}

/** Re-decrypts the current on-disk content using an already-active session (no password needed). */
export function readActiveSessionBody(name: string): string {
  const s = sessionKeys.get(name);
  if (!s) throw new Error('No active session');
  const file = new File(notesDirInstance, name);
  const parsed = parseFrontmatter(file.textSync());
  if (!parsed) throw new Error('Note is not locked');
  return decryptWithKey(parsed.body.trim(), s.key);
}

export function sessionRemainingMs(name: string): number {
  const s = sessionKeys.get(name);
  if (!s) return 0;
  return Math.max(0, s.expiresAt - Date.now());
}

/** Drops the cached session key — call on explicit re-lock or session timeout. */
export function closeLockedSession(name: string): void {
  sessionKeys.delete(name);
}

/** Re-encrypt a locked note's content using the cached session key (cheap, no PBKDF2). */
export async function saveLockedSession(name: string, plaintext: string, password?: string): Promise<void> {
  const file = new File(notesDirInstance, name);
  const parsed = parseFrontmatter(file.textSync());
  const fm = parsed ? parsed.fm.replace(/^encrypted:[ \t]*.*\n?/m, '').replace(/\n+$/, '') : '';

  const cached = sessionKeys.get(name);
  let cipher: string;
  let oldPlaintext: string | null = null;
  if (cached) {
    if (parsed) {
      try {
        oldPlaintext = decryptWithKey(parsed.body.trim(), cached.key);
      } catch {}
    }
    cipher = encryptWithKey(plaintext, cached.key, cached.salt);
  } else if (password) {
    cipher = await encryptNoteBody(plaintext, password);
  } else {
    throw new Error('No active session and no password provided');
  }
  const fmOut = (fm ? fm + '\n' : '') + 'encrypted: true';
  file.write(`---\n${fmOut}\n---\n${cipher}`);
  // Ciphertext always differs (random IV), so compare decrypted plaintext instead.
  if (oldPlaintext !== null) touchHistoryIfChanged(name, oldPlaintext, plaintext);
}

/** Encrypt a plaintext note in place for the first time. */
export async function lockNote(name: string, password: string): Promise<void> {
  const file = new File(notesDirInstance, name);
  const content = file.textSync();
  const parsed = parseFrontmatter(content);
  const fm = parsed ? parsed.fm.replace(/^encrypted:[ \t]*.*\n?/m, '').replace(/\n+$/, '') : '';
  const body = parsed ? parsed.body : content;
  const cipher = await encryptNoteBody(body, password);
  const fmOut = (fm ? fm + '\n' : '') + 'encrypted: true';
  file.write(`---\n${fmOut}\n---\n${cipher}`);
  appendHistory(name, 'edited');
}

function parseTagsFromFm(fm: string): string[] {
  const bracket = fm.match(/^tags:\s*\[([^\]]*)\]/m);
  if (bracket) {
    return bracket[1].split(',').map((t) => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  const listed = fm.match(/^tags:\s*\n((?:[ \t]+-[ \t]+.+\n?)+)/m);
  if (listed) {
    return listed[1].split('\n').map((l) => l.replace(/^[ \t]+-[ \t]+/, '').trim()).filter(Boolean);
  }
  return [];
}

export function getTags(name: string): string[] {
  const file = new File(notesDirInstance, name);
  if (!file.exists) return [];
  const parsed = parseFrontmatter(file.textSync());
  if (!parsed) return [];
  return parseTagsFromFm(parsed.fm);
}

export function setTags(name: string, tags: string[]): void {
  const oldTags = getTags(name);
  const tagsChanged = oldTags.length !== tags.length || oldTags.some((t, i) => t !== tags[i]);

  const file = new File(notesDirInstance, name);
  const content = file.textSync();
  const parsed = parseFrontmatter(content);
  const tagLine = `tags: [${tags.join(', ')}]`;

  if (parsed) {
    let fm = parsed.fm;
    const encrypted = isEncrypted(fm);
    fm = fm.replace(/^tags:\s*\[.*\]\n?/m, '');
    fm = fm.replace(/^tags:\s*\n(?:[ \t]+-[ \t]+.*\n)*/m, '');
    fm = fm.replace(/^encrypted:[ \t]*.*\n?/m, '');
    fm = fm.replace(/\n+$/, '');
    const parts = [];
    if (encrypted) parts.push('encrypted: true');
    if (tags.length) parts.push(tagLine);
    const newFm = (fm ? fm + '\n' : '') + parts.join('\n');
    const newContent = newFm ? `---\n${newFm}\n---\n${parsed.body}` : `---\n---\n${parsed.body}`;
    file.write(newContent);
  } else {
    const newContent = tags.length ? `---\n${tagLine}\n---\n${content}` : content;
    file.write(newContent);
  }
  if (tagsChanged) {
    appendHistory(name, 'edited');
  }
}

export type StorageCategory = {
  key: string;
  label: string;
  color: string;
  size: number;
  count: number;
};

const STORAGE_CATEGORIES: { key: string; label: string; color: string }[] = [
  { key: 'notes', label: 'Notes', color: '#ff9f0a' },
  { key: 'images', label: 'Images', color: '#30d158' },
  { key: 'documents', label: 'Documents', color: '#0a84ff' },
  { key: 'videos', label: 'Videos', color: '#ff375f' },
  { key: 'audio', label: 'Audio', color: '#bf5af2' },
  { key: 'archives', label: 'Archives', color: '#ffd60a' },
];

export async function storageCategories(): Promise<{ categories: StorageCategory[]; total: number }> {
  ensureDir(notesDirInstance);

  let notesSize = 0;
  let notesCount = 0;
  for (const e of notesDirInstance.list()) {
    if (e instanceof File && e.name.endsWith('.md')) {
      notesCount += 1;
      notesSize += e.size ?? 0;
    }
  }

  const attachmentSizes: Record<string, { size: number; count: number }> = {};
  for (const cat of ATTACHMENT_CATEGORIES) {
    const dir = new Directory(attachmentsDirInstance, cat);
    let size = 0;
    let count = 0;
    if (dir.exists) {
      for (const e of dir.list()) {
        if (e instanceof File) {
          size += e.size ?? 0;
          count += 1;
        }
      }
    }
    attachmentSizes[cat] = { size, count };
  }

  const categories: StorageCategory[] = STORAGE_CATEGORIES.map((c) => {
    if (c.key === 'notes') return { ...c, size: notesSize, count: notesCount };
    const a = attachmentSizes[c.key];
    return a ? { ...c, size: a.size, count: a.count } : { ...c, size: 0, count: 0 };
  });
  const total = categories.reduce((sum, c) => sum + c.size, 0);
  return { categories, total };
}

export function notesDir(): Directory {
  return notesDirInstance;
}

export type FileEntry = { name: string; size: number };

/**
 * Permanently deletes a single attachment file from local storage and records it in
 * .deletions.json so the deletion propagates to GitHub on the next sync.
 */
export function deleteAttachmentFile(categoryKey: string, fileName: string): void {
  if (categoryKey === 'notes') return; // notes are deleted via deleteNote, not here
  const dir = new Directory(attachmentsDirInstance, categoryKey);
  const file = new File(dir, fileName);
  if (file.exists) file.delete();

  const relPath = `${categoryKey}/${fileName}`;
  const now = Date.now() / 1000;
  const doc = readDeletions();
  if (!doc.deletions.some((d) => d.path === relPath)) {
    doc.deletions.push({ path: relPath, type: 'attachment', deleted_at: now });
    if (doc.settings) (doc.settings as any).lastchanged = now;
    writeDeletions(doc);
  }
}

/**
 * Extracts all `/attachments/<cat>/<file>` paths referenced in a note body.
 * Returns paths as `cat/file` strings (decoded, no leading slash).
 */
function extractAttachmentPaths(body: string): Set<string> {
  const paths = new Set<string>();
  const re = /!?\[[^\]]*\]\(\/?attachments\/([^()\n]+(?:\([^()\n]*\)[^()\n]*)*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    try { paths.add(decodeURIComponent(m[1].trim())); } catch { paths.add(m[1].trim()); }
  }
  return paths;
}

/**
 * Compares the note body before and after an edit session. Any attachment links
 * that were removed are deleted from local storage and recorded in .deletions.json,
 * unless the same path is still referenced by another note on this device.
 */
export function cleanUpRemovedAttachments(noteName: string, oldBody: string | null, newBody: string): void {
  if (!oldBody) return;
  const oldPaths = extractAttachmentPaths(oldBody);
  const newPaths = extractAttachmentPaths(newBody);
  const removed = [...oldPaths].filter((p) => !newPaths.has(p));
  if (!removed.length) return;

  // Check which removed paths are still referenced by other notes.
  const stillReferenced = new Set<string>();
  for (const e of notesDirInstance.list()) {
    if (!(e instanceof File) || !e.name.endsWith('.md') || e.name === noteName) continue;
    try {
      const otherPaths = extractAttachmentPaths(e.textSync());
      for (const p of removed) {
        if (otherPaths.has(p)) stillReferenced.add(p);
      }
    } catch {}
  }

  for (const relPath of removed) {
    if (stillReferenced.has(relPath)) continue;
    const slash = relPath.indexOf('/');
    if (slash < 0) continue;
    deleteAttachmentFile(relPath.slice(0, slash), relPath.slice(slash + 1));
    console.log(`[attachments] auto-deleted orphan: ${relPath}`);
  }
}

/**
 * After a sync, scans every attachment file on disk and deletes any that are no
 * longer referenced by any active (non-trashed) note. Also records each deletion
 * in .deletions.json so it propagates to GitHub on the next sync.
 */
export function cleanOrphanedAttachments(): void {
  // Build the set of attachment paths referenced by active notes.
  const referenced = new Set<string>();
  // Notes in .deletions.json were permanently deleted on another device — even if they
  // still exist locally in trash, their attachments are no longer needed.
  const permanentlyDeleted = getDeletedPaths();
  const attachRe = /!?\[[^\]]*\]\(\/?attachments\/([^()\n]+(?:\([^()\n]*\)[^()\n]*)*)\)/g;
  try {
    for (const entry of notesDirInstance.list()) {
      if (!(entry instanceof File) || !entry.name.endsWith('.md')) continue;
      // Skip notes recorded as permanently deleted on another device.
      if (permanentlyDeleted.has(entry.name)) continue;
      try {
        const content = entry.textSync();
        const parsed = parseFrontmatter(content);
        // Skip local trash (unless user later restores, but local-only trash still holds refs).
        if (parsed && isTrashedFm(parsed.fm)) continue;
        const body = parsed ? parsed.body : content;
        let m: RegExpExecArray | null;
        attachRe.lastIndex = 0;
        while ((m = attachRe.exec(body)) !== null) {
          referenced.add(decodeURIComponent(m[1].trim()));
        }
      } catch {}
    }
  } catch {}

  // Delete every attachment file that has no reference in any active note.
  for (const cat of ATTACHMENT_CATEGORIES) {
    const catDir = new Directory(attachmentsDirInstance, cat);
    if (!catDir.exists) continue;
    for (const entry of catDir.list()) {
      if (!(entry instanceof File)) continue;
      const relPath = `${cat}/${entry.name}`;
      if (!referenced.has(relPath)) {
        deleteAttachmentFile(cat, entry.name);
        console.log(`[cleanup] orphaned attachment removed: ${relPath}`);
      }
    }
  }
}

// ─── Attachment import ───────────────────────────────────────────────────────

const IMAGE_ATTACH_EXTS = new Set(['jpg','jpeg','png','gif','webp','svg','bmp','tiff','heic','heif','avif']);
const AUDIO_ATTACH_EXTS = new Set(['mp3','m4a','ogg','oga','wav','flac','aac','opus','weba','wma']);
const VIDEO_ATTACH_EXTS = new Set(['mp4','m4v','3gp','wmv','flv','mov','webm','avi','mkv','mpg','mpeg']);
const ARCHIVE_ATTACH_EXTS = new Set(['zip','rar','tar','gz','7z','bz2','xz']);

export type AttachmentCategory = 'images' | 'audio' | 'videos' | 'archives' | 'documents';

export function getAttachmentCategory(filename: string): AttachmentCategory {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_ATTACH_EXTS.has(ext)) return 'images';
  if (AUDIO_ATTACH_EXTS.has(ext)) return 'audio';
  if (VIDEO_ATTACH_EXTS.has(ext)) return 'videos';
  if (ARCHIVE_ATTACH_EXTS.has(ext)) return 'archives';
  return 'documents';
}

/**
 * Copies a file from `sourceUri` (file:// or content:// from a picker) into the
 * permanent attachments directory, determines its category from the extension, and
 * returns the Markdown link string ready to insert into a note.
 */
export async function copyAttachmentToStorage(
  sourceUri: string,
  originalName: string,
): Promise<{ markdownLink: string }> {
  // Sanitize: spaces and filesystem-unsafe chars → underscores
  const safeName = originalName.replace(/[\s<>:"/\\|?*\x00-\x1f]/g, '_');
  const category = getAttachmentCategory(safeName);

  const catDir = new Directory(attachmentsDirInstance, category);
  if (!catDir.exists) catDir.create({ intermediates: true });

  // Avoid collisions: append timestamp if file already exists
  let filename = safeName;
  if (new File(catDir, filename).exists) {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    const dot = filename.lastIndexOf('.');
    filename = dot > 0
      ? `${filename.slice(0, dot)}_${ts}${filename.slice(dot)}`
      : `${filename}_${ts}`;
  }

  const destUri = new File(catDir, filename).uri;

  // Normalize single-slash content URIs that some Android media providers emit
  // (content:/authority → content://authority)
  const normalizedUri = sourceUri.startsWith('content:/') && !sourceUri.startsWith('content://')
    ? 'content://' + sourceUri.slice(9)
    : sourceUri;

  // copyAsync uses a different native code path from readAsStringAsync:
  // for content:// URIs it goes through ContentResolver.openInputStream,
  // and for file:// URIs already in the experience cache it copies directly.
  await FileSystem.copyAsync({ from: normalizedUri, to: destUri });

  const mdLink = category === 'images'
    ? `![${filename}](/attachments/${category}/${filename})`
    : `[${filename}](/attachments/${category}/${filename})`;

  return { markdownLink: mdLink };
}

/** Returns all files in a storage category sorted largest-first. */
export function listCategoryFiles(categoryKey: string): FileEntry[] {
  const entries: FileEntry[] = [];
  if (categoryKey === 'notes') {
    for (const e of notesDirInstance.list()) {
      if (e instanceof File && e.name.endsWith('.md')) {
        entries.push({ name: e.name.replace(/\.md$/, ''), size: e.size ?? 0 });
      }
    }
  } else {
    const dir = new Directory(attachmentsDirInstance, categoryKey);
    if (dir.exists) {
      for (const e of dir.list()) {
        if (e instanceof File) entries.push({ name: e.name, size: e.size ?? 0 });
      }
    }
  }
  return entries.sort((a, b) => b.size - a.size);
}
