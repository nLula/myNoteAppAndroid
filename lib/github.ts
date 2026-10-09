import * as SecureStore from 'expo-secure-store';
import { sha1 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Directory, File, Paths } from 'expo-file-system';
import { listAllNoteFiles, readNote, writeNote, deleteNote, lastEditEpoch, notesDir, attachmentsDir, ATTACHMENT_CATEGORIES } from '../notes';
import { mergeTexts } from './merge';

const PAT_KEY = 'mynote_github_pat';
const CONFIG_KEY = 'mynote_github_config';

type DeletionEntry = { path: string; type: 'note' | 'attachment'; deleted_at: number };
type DeletionsDoc = { settings?: Record<string, unknown>; deletions: DeletionEntry[] };

function mergeHistoryContent(localContent: string, remoteContent: string): string {
  try {
    type HEntry = { at: string; via: string; act: string };
    const local: HEntry[] = JSON.parse(localContent);
    const remote: HEntry[] = JSON.parse(remoteContent);
    const byAt = new Map<string, HEntry>();
    for (const e of [...remote, ...local]) {
      if (!byAt.has(e.at)) byAt.set(e.at, e);
    }
    return JSON.stringify([...byAt.values()].sort((a, b) => a.at.localeCompare(b.at)));
  } catch {
    return localContent;
  }
}

/**
 * The unnamed placeholder note is a permanent fixture, not a real note: it gets
 * emptied and reused rather than created and destroyed. Recording it as deleted
 * makes every device refuse it, so typing into it on the phone appears to save
 * while the note never actually syncs. Entries for it are dropped on every
 * merge, which also heals logs that already carry one — the merged document is
 * what gets written locally and pushed, so the entry leaves the shared copy too.
 */
const PLACEHOLDER_NOTE_BASE = 'no_name';

function isPlaceholderDeletion(e: DeletionEntry): boolean {
  if (e.type !== 'note') return false;
  const stem = String(e.path).replace(/\.md$/i, '');
  return stem.replace(/_[A-Za-z0-9]{8}$/, '').toLowerCase() === PLACEHOLDER_NOTE_BASE;
}

function mergeDeletionsContent(localContent: string, remoteContent: string): string {
  try {
    const local = JSON.parse(localContent) as DeletionsDoc;
    const remote = JSON.parse(remoteContent) as DeletionsDoc;
    const byPath = new Map<string, DeletionEntry>();
    for (const e of [...(remote.deletions ?? []), ...(local.deletions ?? [])]) {
      if (isPlaceholderDeletion(e)) continue;
      const prev = byPath.get(e.path);
      if (!prev || e.deleted_at > prev.deleted_at) byPath.set(e.path, e);
    }
    const result: DeletionsDoc = {
      settings: remote.settings ?? local.settings,
      deletions: [...byPath.values()].sort((a, b) => a.deleted_at - b.deleted_at),
    };
    if (result.settings) (result.settings as any).lastchanged = Date.now() / 1000;
    return JSON.stringify(result, null, 2);
  } catch {
    return localContent;
  }
}
const stateFile = new File(Paths.document, 'github_state.json');

export type GithubConfig = {
  repoUrl: string;
  connected: boolean;
  lastSync: number;
  syncInterval: number; // seconds; 0 = never (manual only)
};

type StateEntry = { sha: string | null; at: number };
type SyncState = Record<string, StateEntry>;

export async function savePat(pat: string): Promise<void> {
  await SecureStore.setItemAsync(PAT_KEY, pat);
}

export async function getPat(): Promise<string> {
  return (await SecureStore.getItemAsync(PAT_KEY)) ?? '';
}

export async function getConfig(): Promise<GithubConfig> {
  const raw = await SecureStore.getItemAsync(CONFIG_KEY);
  if (!raw) return { repoUrl: '', connected: false, lastSync: 0, syncInterval: 300 };
  const cfg = JSON.parse(raw);
  return { syncInterval: 300, ...cfg };
}

export async function saveConfig(cfg: GithubConfig): Promise<void> {
  await SecureStore.setItemAsync(CONFIG_KEY, JSON.stringify(cfg));
}

function apiBase(repoUrl: string): string {
  let url = repoUrl.trim().replace(/\/+$/, '');
  if (url.endsWith('.git')) url = url.slice(0, -4);
  const idx = url.indexOf('github.com/');
  if (idx === -1) throw new Error(`Cannot parse GitHub URL: ${repoUrl}`);
  const path = url.slice(idx + 'github.com/'.length).replace(/\/+$/, '');
  if (!path) throw new Error(`Cannot parse GitHub URL: ${repoUrl}`);
  return `https://api.github.com/repos/${path}`;
}

async function ghRequest(method: string, url: string, pat: string, body?: any): Promise<any> {
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'myNote-android-sync/1.0',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    let msg = '';
    try {
      const j = await resp.json();
      msg = j.message ?? '';
    } catch {}
    throw new Error(`GitHub ${method}: HTTP ${resp.status} ${msg}`);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : {};
}

/**
 * Computes the git blob SHA1 ("blob <len>\0<content>") over raw bytes.
 * Must NOT go through expo-crypto's digestStringAsync: that takes a JS string across
 * the native bridge, which truncates at the embedded NUL byte this format requires —
 * silently hashing only "blob <len>" and never the actual content. Hashing a Uint8Array
 * in pure JS (via @noble/hashes) avoids the native string bridge entirely.
 */
export async function gitBlobSha(content: string): Promise<string> {
  const contentBytes = new TextEncoder().encode(content);
  const prefix = new TextEncoder().encode(`blob ${contentBytes.length}\0`);
  const full = new Uint8Array(prefix.length + contentBytes.length);
  full.set(prefix, 0);
  full.set(contentBytes, prefix.length);
  return bytesToHex(sha1(full));
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64DecodeUtf8(b64: string): string {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function b64EncodeUtf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function fetchCommitTime(base: string, pat: string, rel: string): Promise<number> {
  try {
    const resp = await ghRequest('GET', `${base}/commits?path=${encodeURIComponent(rel)}&per_page=1`, pat);
    if (resp && resp.length) {
      return new Date(resp[0].commit.committer.date).getTime() / 1000;
    }
  } catch {}
  return 0;
}

async function fetchBlob(base: string, pat: string, sha: string): Promise<string> {
  const resp = await ghRequest('GET', `${base}/git/blobs/${sha}`, pat);
  return b64DecodeUtf8(resp.content ?? '');
}

async function fetchBlobBase64(base: string, pat: string, sha: string): Promise<string> {
  const resp = await ghRequest('GET', `${base}/git/blobs/${sha}`, pat);
  return (resp.content ?? '').replace(/\n/g, '');
}

const LARGE_FILE_THRESHOLD = 900 * 1024; // 900 KB — GitHub's Contents API caps around 1MB

let cachedDefaultBranch: string | null = null;
async function getDefaultBranch(base: string, pat: string): Promise<string> {
  if (cachedDefaultBranch) return cachedDefaultBranch;
  const repo = await ghRequest('GET', base, pat);
  const branch: string = repo.default_branch ?? 'main';
  cachedDefaultBranch = branch;
  return branch;
}

/**
 * Pushes a large file (≥900KB) via the Git Data API instead of the Contents API, which
 * GitHub caps around 1MB. Creates a blob, grafts it into a new tree off the current commit,
 * commits it, and moves the branch ref forward — i.e. a manual single-file "git push".
 */
async function gitDataPushFile(base: string, pat: string, rel: string, base64Content: string): Promise<string> {
  const branch = await getDefaultBranch(base, pat);
  const blob = await ghRequest('POST', `${base}/git/blobs`, pat, { content: base64Content, encoding: 'base64' });
  const ref = await ghRequest('GET', `${base}/git/refs/heads/${branch}`, pat);
  const parentCommitSha = ref.object.sha;
  const parentCommit = await ghRequest('GET', `${base}/git/commits/${parentCommitSha}`, pat);
  const newTree = await ghRequest('POST', `${base}/git/trees`, pat, {
    base_tree: parentCommit.tree.sha,
    tree: [{ path: rel, mode: '100644', type: 'blob', sha: blob.sha }],
  });
  const newCommit = await ghRequest('POST', `${base}/git/commits`, pat, {
    message: `sync: add/update large file ${rel}`,
    tree: newTree.sha,
    parents: [parentCommitSha],
  });
  await ghRequest('PATCH', `${base}/git/refs/heads/${branch}`, pat, { sha: newCommit.sha });
  return blob.sha;
}

function loadState(): SyncState {
  try {
    if (!stateFile.exists) return {};
    return JSON.parse(stateFile.textSync());
  } catch {
    return {};
  }
}

function saveState(state: SyncState): void {
  if (!stateFile.exists) stateFile.create();
  stateFile.write(JSON.stringify(state));
}

export async function testConnection(repoUrl: string, pat: string): Promise<void> {
  await ghRequest('GET', apiBase(repoUrl), pat);
}

export type SyncResult = { ok: boolean; toRemote?: number; toLocal?: number; skipped?: number; error?: string; conflicts?: string[] };

export async function doSync(): Promise<SyncResult> {
  const tSyncStart = Date.now();
  const log = (msg: string) => console.log(`[sync +${Date.now() - tSyncStart}ms] ${msg}`);

  const cfg = await getConfig();
  if (!cfg.connected || !cfg.repoUrl) return { ok: false, error: 'Not configured' };
  const pat = await getPat();
  if (!pat) return { ok: false, error: 'Not configured' };

  let base: string;
  try {
    base = apiBase(cfg.repoUrl);
  } catch (e: any) {
    return { ok: false, error: e.message };
  }

  log('fetching remote tree…');
  let githubFiles: Record<string, string> = {};
  const githubFileSizes: Record<string, number> = {};
  let githubAttachments: Record<string, { sha: string; size: number }> = {};
  try {
    const tree = await ghRequest('GET', `${base}/git/trees/HEAD?recursive=1`, pat);
    for (const item of tree.tree ?? []) {
      if (item.type !== 'blob') continue;
      if (item.path.endsWith('.md') || item.path.endsWith('.history.json') || item.path === '.deletions.json') {
        githubFiles[item.path] = item.sha;
        githubFileSizes[item.path] = item.size ?? 0;
      } else if (/^attachments\/(images|documents|videos|audio|archives)\//.test(item.path)) {
        githubAttachments[item.path] = { sha: item.sha, size: item.size ?? 0 };
      }
    }
  } catch (e: any) {
    if (!/40[49]/.test(e.message)) return { ok: false, error: e.message };
  }
  log(`remote tree fetched: ${Object.keys(githubFiles).length} notes, ${Object.keys(githubAttachments).length} attachments`);

  // Sync includes trashed notes (so trash status itself propagates) and their .history.json sidecars.
  const localMetas = await listAllNoteFiles();
  const notesDirInstance = notesDir();
  const historyMtimeSecs = new Map<string, number>(); // epoch seconds
  for (const e of notesDirInstance.list()) {
    if (e instanceof File && e.name.endsWith('.history.json')) {
      // modificationTime is in milliseconds — convert to seconds to match ghTime/lastEditEpoch units.
      historyMtimeSecs.set(e.name, (e.modificationTime ?? 0) / 1000);
    }
  }
  const localFiles = new Set([...localMetas.map((m) => m.name), ...historyMtimeSecs.keys()]);
  // Include .deletions.json so permanent deletions propagate to the PC.
  if (new File(notesDirInstance, '.deletions.json').exists) localFiles.add('.deletions.json');
  const isHistoryFile = (rel: string) => rel.endsWith('.history.json');

  log(`local files: ${localFiles.size}`);
  const rawState = loadState();
  log(`loaded sync state: ${Object.keys(rawState).length} tracked entries`);
  const newState: SyncState = {};
  const syncNow = Date.now() / 1000;
  let toRemote = 0;
  let toLocal = 0;
  let skipped = 0;
  const conflicts: string[] = [];

  const stateEntry = (rel: string): StateEntry => rawState[rel] ?? { sha: null, at: 0 };

  async function pushFile(rel: string, content: string, localSha: string, ghSha: string | null) {
    const sizeBytes = new TextEncoder().encode(content).length;
    try {
      let storedSha: string;
      if (sizeBytes >= LARGE_FILE_THRESHOLD) {
        log(`${rel}: pushing large file (${(sizeBytes / 1024).toFixed(0)}KB) via Git Data API`);
        storedSha = await gitDataPushFile(base, pat, rel, b64EncodeUtf8(content));
      } else {
        const body: any = { message: `sync: ${ghSha ? 'update' : 'add'} ${rel}`, content: b64EncodeUtf8(content) };
        if (ghSha) body.sha = ghSha;
        const resp = await ghRequest('PUT', `${base}/contents/${encodeURIComponent(rel)}`, pat, body);
        // Trust the sha GitHub actually stored, not our locally-computed one — GitHub can
        // normalize content (e.g. line endings) on upload, which would otherwise make every
        // file look "changed" on every subsequent sync and force a needless re-push each time.
        storedSha = resp?.content?.sha ?? localSha;
      }
      if (storedSha !== localSha) {
        // GitHub stored different bytes than we sent — pull them back down so local and
        // remote are byte-identical going forward, instead of drifting on every sync.
        try {
          const canonical = await fetchBlob(base, pat, storedSha);
          await writeNote(rel, canonical);
        } catch {}
      }
      newState[rel] = { sha: storedSha, at: syncNow };
      toRemote += 1;
    } catch (e: any) {
      if (/409/.test(e.message)) {
        log(`${rel}: 409 SHA mismatch on push — fetching current sha for retry`);
        try {
          const existing = await ghRequest('GET', `${base}/contents/${encodeURIComponent(rel)}`, pat);
          const currentSha = existing.sha as string;
          const retryBody: any = { message: `sync: update ${rel}`, content: b64EncodeUtf8(content) };
          retryBody.sha = currentSha;
          const retryResp = await ghRequest('PUT', `${base}/contents/${encodeURIComponent(rel)}`, pat, retryBody);
          const storedSha: string = retryResp?.content?.sha ?? localSha;
          if (storedSha !== localSha) {
            try {
              const canonical = await fetchBlob(base, pat, storedSha);
              await writeNote(rel, canonical);
            } catch {}
          }
          newState[rel] = { sha: storedSha, at: syncNow };
          toRemote += 1;
          log(`${rel}: 409 retry succeeded (current sha was ${currentSha.slice(0, 7)})`);
        } catch {
          log(`${rel}: 409 retry also failed — will retry on next sync`);
          skipped += 1;
        }
      } else {
        throw e;
      }
    }
  }

  async function pullFile(rel: string, ghSha: string, sizeBytes?: number) {
    let content: string;
    if (sizeBytes !== undefined && sizeBytes >= LARGE_FILE_THRESHOLD) {
      log(`${rel}: pulling large file (${(sizeBytes / 1024).toFixed(0)}KB) via Git Data API`);
      content = await fetchBlob(base, pat, ghSha);
    } else {
      const resp = await ghRequest('GET', `${base}/contents/${encodeURIComponent(rel)}`, pat);
      content = b64DecodeUtf8(resp.content ?? '');
    }
    await writeNote(rel, content);
    newState[rel] = { sha: ghSha, at: syncNow };
    toLocal += 1;
  }

  const allRels = new Set([...Object.keys(githubFiles), ...localFiles]);

  for (const rel of allRels) {
    const inLocal = localFiles.has(rel);
    const inGithub = rel in githubFiles;

    let content: string | null = null;
    let localSha: string | null = null;
    let localMtime = 0;

    if (inLocal) {
      content = await readNote(rel);
      localSha = await gitBlobSha(content);
      // For .md files, use the history-based "last real edit" time instead of raw mtime —
      // mtime can be bumped by no-op resaves (e.g. opening/closing a note) and falsely
      // looks like a local change, which previously caused stale local copies to win sync.
      if (isHistoryFile(rel)) {
        localMtime = historyMtimeSecs.get(rel) ?? 0;
      } else {
        localMtime = lastEditEpoch(rel);
      }
    }

    const entry = stateEntry(rel);
    const prevSha = entry.sha;
    const syncAt = entry.at;

    if (inLocal && inGithub) {
      const ghSha = githubFiles[rel];

      if (localSha === ghSha) {
        log(`${rel}: identical content, skip`);
        newState[rel] = { sha: ghSha, at: syncAt };
        skipped += 1;
        continue;
      }

      if (rel === '.deletions.json') {
        // Always merge deletions from both sides instead of last-writer-wins.
        const remoteText = b64DecodeUtf8(
          (await ghRequest('GET', `${base}/contents/.deletions.json`, pat)).content ?? ''
        );
        const merged = mergeDeletionsContent(content!, remoteText);
        const mergedSha = await gitBlobSha(merged);
        if (mergedSha !== localSha) await writeNote(rel, merged);
        if (mergedSha !== ghSha) {
          await pushFile(rel, merged, mergedSha, ghSha);
          toRemote += 1;
        } else {
          newState[rel] = { sha: ghSha, at: syncAt };
          skipped += 1;
        }
        continue;
      }

      if (isHistoryFile(rel)) {
        // Always merge history entries from both sides — never last-write-wins, which would
        // discard entries written on whichever device synced last.
        const remoteText = await fetchBlob(base, pat, ghSha);
        const merged = mergeHistoryContent(content!, remoteText);
        const mergedSha = await gitBlobSha(merged);
        if (mergedSha !== localSha) await writeNote(rel, merged);
        if (mergedSha !== ghSha) {
          await pushFile(rel, merged, mergedSha, ghSha);
        } else {
          newState[rel] = { sha: ghSha, at: syncAt };
          skipped += 1;
        }
        continue;
      }

      // Guard with localSha !== prevSha: a remote history merge can bump localMtime without
      // the note content actually changing. Without this, the note looks locally-changed and
      // triggers a 3-way merge where local === base, always resolving to the remote version.
      const localChanged = localMtime > syncAt + 2 && localSha !== prevSha;
      const remoteChanged = ghSha !== prevSha;
      log(
        `${rel}: localChanged=${localChanged} remoteChanged=${remoteChanged} ` +
          `localMtime=${localMtime.toFixed(0)} syncAt=${syncAt.toFixed(0)} ` +
          `prevSha=${prevSha?.slice(0, 7) ?? 'null'} ghSha=${ghSha.slice(0, 7)} localSha=${localSha!.slice(0, 7)}`
      );

      if (localChanged && remoteChanged) {
        if (prevSha && !isHistoryFile(rel)) {
          try {
            log(`${rel}: both changed, attempting 3-way merge`);
            const baseText = await fetchBlob(base, pat, prevSha);
            const rResp = await ghRequest('GET', `${base}/contents/${encodeURIComponent(rel)}`, pat);
            const remoteText = b64DecodeUtf8(rResp.content ?? '');

            // When both sides added text, the merge keeps both and needs to know
            // which came first. localMtime is this device's last edit from the
            // note's history sidecar; the remote side uses its commit time — when
            // the other device pushed rather than typed, but monotonic with it
            // and already what last-write-wins trusts here.
            const remoteEditedAt = await fetchCommitTime(base, pat, rel);
            const [mergedText, hadConflict] = mergeTexts(baseText, content!, remoteText, {
              localAt: localMtime,
              remoteAt: remoteEditedAt,
            });
            const mergedSha = await gitBlobSha(mergedText);

            if (mergedSha === ghSha) {
              log(`${rel}: merge result == remote, pulling`);
              await pullFile(rel, ghSha, githubFileSizes[rel]);
            } else if (mergedSha === localSha) {
              log(`${rel}: merge result == local, pushing`);
              await pushFile(rel, content!, localSha!, ghSha);
            } else {
              log(`${rel}: merge produced new content, pushing merged${hadConflict ? ' (with conflict markers)' : ''}`);
              await pushFile(rel, mergedText, mergedSha, ghSha);
              await writeNote(rel, mergedText);
            }
            if (hadConflict) conflicts.push(rel);
            continue;
          } catch (e: any) {
            log(`${rel}: merge failed (${e.message}), falling back to last-write-wins`);
          }
        }
        const ghTime = await fetchCommitTime(base, pat, rel);
        log(`${rel}: last-write-wins — localMtime=${localMtime.toFixed(0)} ghTime=${ghTime.toFixed(0)}`);
        if (localMtime >= ghTime) {
          log(`${rel}: local wins, pushing`);
          await pushFile(rel, content!, localSha!, ghSha);
        } else {
          log(`${rel}: remote wins, pulling`);
          await pullFile(rel, ghSha, githubFileSizes[rel]);
        }
      } else if (localChanged) {
        log(`${rel}: only local changed, pushing`);
        await pushFile(rel, content!, localSha!, ghSha);
      } else if (remoteChanged) {
        log(`${rel}: only remote changed, pulling`);
        await pullFile(rel, ghSha, githubFileSizes[rel]);
      } else {
        log(`${rel}: neither flagged changed but shas differ (stale state), pushing`);
        await pushFile(rel, content!, localSha!, ghSha);
      }
    } else if (inLocal) {
      if (prevSha !== null) {
        // Was previously synced but now missing from remote — the remote side (e.g. PC) deleted it.
        // Move the note to trash (or remove history files) so it doesn't resurrect on next sync.
        try {
          if (rel.endsWith('.md')) {
            await deleteNote(rel);
          } else {
            const f = new File(notesDir(), rel);
            if (f.exists) f.delete();
          }
          log(`${rel}: deleted locally (was synced, now missing from remote)`);
        } catch (delErr: any) {
          log(`${rel}: local delete FAILED — ${(delErr as any)?.message ?? delErr}`);
        }
        continue; // don't add to newState — file is gone
      }
      log(`${rel}: local only, pushing as new`);
      await pushFile(rel, content!, localSha!, null);
    } else {
      const ghSha = githubFiles[rel];
      if (prevSha !== null) {
        log(`${rel}: removed locally, deleting on remote`);
        try {
          await ghRequest('DELETE', `${base}/contents/${encodeURIComponent(rel)}`, pat, {
            message: `sync: delete ${rel}`,
            sha: ghSha,
          });
        } catch {}
      } else {
        log(`${rel}: new on remote, pulling`);
        await pullFile(rel, ghSha, githubFileSizes[rel]);
      }
    }
  }
  log('sync loop complete');

  // ── Attachments: binary files, synced by existence only (no merge/conflict logic needed). ──
  // Files under 900KB use the simple Contents API; larger ones use the Git Data API instead,
  // since GitHub's Contents API rejects uploads above ~1MB.
  const attachDir = attachmentsDir();
  const localAttachmentSizes = new Map<string, number>();
  for (const cat of ATTACHMENT_CATEGORIES) {
    const catDir = new Directory(attachDir, cat);
    if (!catDir.exists) continue;
    for (const e of catDir.list()) {
      if (e instanceof File) localAttachmentSizes.set(`attachments/${cat}/${e.name}`, e.size ?? 0);
    }
  }
  const localAttachments = new Set(localAttachmentSizes.keys());

  // Apply .deletions.json: delete locally AND collect the GitHub paths that still need
  // to be removed from the remote so they don't get pulled back on every sync.
  const deletedAttachmentRels = new Set<string>();
  const deletionsFile = new File(notesDirInstance, '.deletions.json');
  if (deletionsFile.exists) {
    try {
      // Guard: collect all attachment paths still referenced by local notes so we never
      // delete a file that an active note on this device still points to.  This prevents
      // .deletions.json entries added on the PC (when it emptied its trash) from silently
      // removing files that the mobile re-added or that belong to a completely different note.
      const referencedLocally = new Set<string>();
      const attachRe = /\]\(\/?attachments\/([^)\n]+)\)/g;
      for (const e of notesDirInstance.list()) {
        if (!(e instanceof File) || !e.name.endsWith('.md')) continue;
        try {
          let m: RegExpExecArray | null;
          attachRe.lastIndex = 0;
          const body = e.textSync();
          while ((m = attachRe.exec(body)) !== null) {
            referencedLocally.add(decodeURIComponent(m[1].trim()));
          }
        } catch {}
      }
      log(`deletions: ${referencedLocally.size} attachment path(s) still referenced in local notes`);

      const doc = JSON.parse(deletionsFile.textSync()) as DeletionsDoc;
      const staleEntries = new Set<string>();
      for (const entry of doc.deletions ?? []) {
        if (entry.type !== 'attachment') continue;
        // entry.path is relative to the attachments dir, e.g. "audio/clip.m4a"

        // Check if a local note still references this attachment — do this FIRST,
        // independent of whether the file physically exists, because the File constructor
        // may fail to resolve paths with directory separators on some platforms.
        if (referencedLocally.has(entry.path)) {
          // File is still in use — leave it in localAttachments so the transfer loop
          // can push it to remote if needed. Mark entry as stale so it gets removed
          // from .deletions.json, preventing the same false-deletion on future syncs.
          log(`deletions: KEPT attachments/${entry.path} — still referenced by a local note`);
          staleEntries.add(entry.path);
          continue;
        }

        // Build the local File reference the safe way (category dir + filename)
        // to avoid path-separator issues with the File constructor.
        const slash = entry.path.indexOf('/');
        const localFile = slash >= 0
          ? new File(new Directory(attachDir, entry.path.slice(0, slash)), entry.path.slice(slash + 1))
          : new File(attachDir, entry.path);
        if (localFile.exists) {
          localFile.delete();
          log(`deletions: removed local attachments/${entry.path}`);
        }
        const relKey = `attachments/${entry.path}`;
        localAttachments.delete(relKey);
        localAttachmentSizes.delete(relKey);
        deletedAttachmentRels.add(relKey);
      }

      // Remove stale entries from .deletions.json so they don't cause false deletions on future syncs.
      // Placeholder-note entries go too: the merge strips them, but the merge only runs when the
      // two sides differ, so an entry sitting in an already-identical log would otherwise survive.
      const placeholderEntries = (doc.deletions ?? []).filter(isPlaceholderDeletion).length;
      if (staleEntries.size > 0 || placeholderEntries > 0) {
        try {
          const fresh = JSON.parse(deletionsFile.textSync()) as DeletionsDoc;
          fresh.deletions = fresh.deletions.filter(
            (d) => !(d.type === 'attachment' && staleEntries.has(d.path)) && !isPlaceholderDeletion(d)
          );
          deletionsFile.write(JSON.stringify(fresh, null, 2));
          if (staleEntries.size > 0)
            log(`deletions: removed ${staleEntries.size} stale attachment entr${staleEntries.size === 1 ? 'y' : 'ies'} from .deletions.json`);
          if (placeholderEntries > 0)
            log(`deletions: removed ${placeholderEntries} placeholder-note entr${placeholderEntries === 1 ? 'y' : 'ies'} from .deletions.json`);
        } catch {}
      }
    } catch (e: any) {
      log(`deletions apply failed: ${e.message}`);
    }
  }
  const allAttachmentRels = new Set([...Object.keys(githubAttachments), ...localAttachments]);
  log(`attachments: ${localAttachments.size} local, ${Object.keys(githubAttachments).length} remote`);
  for (const rel of localAttachments) log(`  local: ${rel}`);
  for (const rel of Object.keys(githubAttachments)) log(`  remote: ${rel}`);

  // Skip the whole pass cheaply when there's simply nothing new to transfer either way.
  const pendingAttachments = [...allAttachmentRels].filter(
    (rel) => localAttachments.has(rel) !== (rel in githubAttachments)
  );
  if (pendingAttachments.length === 0) {
    log('attachments: nothing new to push or pull, skipping');
  } else {
    log(`attachments: ${pendingAttachments.length} pending transfer`);
  }

  for (const rel of pendingAttachments) {
    const inLocal = localAttachments.has(rel);
    const file = new File(attachDir, rel.replace(/^attachments\//, ''));

    if (inLocal) {
      const size = localAttachmentSizes.get(rel) ?? 0;
      try {
        const b64 = file.base64Sync();
        if (size >= LARGE_FILE_THRESHOLD) {
          log(`${rel}: pushing large attachment (${(size / 1024).toFixed(0)}KB) via Git Data API`);
          await gitDataPushFile(base, pat, rel, b64);
        } else {
          try {
            await ghRequest('PUT', `${base}/contents/${encodeURIComponent(rel)}`, pat, {
              message: `sync: add ${rel}`,
              content: b64,
            });
          } catch (e: any) {
            if (!/422/.test(e.message)) throw e;
            // GitHub already has this file but our sync state doesn't know its SHA.
            // Fetch the current SHA and retry as an update.
            log(`${rel}: 422 on push — fetching existing SHA for update`);
            const existing = await ghRequest('GET', `${base}/contents/${encodeURIComponent(rel)}`, pat);
            await ghRequest('PUT', `${base}/contents/${encodeURIComponent(rel)}`, pat, {
              message: `sync: update ${rel}`,
              content: b64,
              sha: existing?.sha,
            });
          }
        }
        toRemote += 1;
        log(`${rel}: pushed new attachment`);
      } catch (e: any) {
        log(`${rel}: attachment push failed (${e.message})`);
      }
    } else {
      const { sha, size } = githubAttachments[rel];
      if (deletedAttachmentRels.has(rel)) {
        // Deleted on this device (or by the PC) — remove from GitHub so it stops coming back.
        try {
          await ghRequest('DELETE', `${base}/contents/${encodeURIComponent(rel)}`, pat, {
            message: `sync: remove deleted attachment ${rel}`,
            sha,
          });
          log(`${rel}: deleted from remote (listed in .deletions.json)`);
        } catch (e: any) {
          log(`${rel}: remote delete failed — ${e.message}`);
        }
      } else {
        try {
          let b64: string;
          if (size >= LARGE_FILE_THRESHOLD) {
            log(`${rel}: pulling large attachment (${(size / 1024).toFixed(0)}KB) via Git Data API`);
            b64 = await fetchBlobBase64(base, pat, sha);
          } else {
            const resp = await ghRequest('GET', `${base}/contents/${encodeURIComponent(rel)}`, pat);
            b64 = (resp.content ?? '').replace(/\n/g, '');
          }
          const bytes = base64ToBytes(b64);
          // Build path the same way resolveAttachmentUri does — category dir + filename —
          // so the downloaded file is found correctly when the note is rendered.
          const catAndFile = rel.replace(/^attachments\//, ''); // e.g. 'images/foo.jpg'
          const slashIdx = catAndFile.indexOf('/');
          const catKey = slashIdx >= 0 ? catAndFile.slice(0, slashIdx) : '';
          const fname = slashIdx >= 0 ? catAndFile.slice(slashIdx + 1) : catAndFile;
          const catDir = new Directory(attachDir, catKey);
          if (!catDir.exists) catDir.create({ intermediates: true });
          const destFile = new File(catDir, fname);
          if (!destFile.exists) destFile.create();
          destFile.write(bytes);
          toLocal += 1;
          log(`${rel}: pulled new attachment`);
        } catch (e: any) {
          log(`${rel}: attachment pull failed (${e.message})`);
        }
      }
    }
  }

  saveState(newState);

  const now = Date.now() / 1000;
  await saveConfig({ ...cfg, lastSync: now });

  return { ok: true, toRemote, toLocal, skipped, conflicts };
}
