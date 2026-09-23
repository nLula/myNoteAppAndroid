import { doSync, SyncResult } from './github';
import { getActiveProvider } from './syncProvider';
import { cleanOrphanedAttachments } from '../notes';

type Listener = (syncing: boolean, result?: SyncResult) => void;

const listeners = new Set<Listener>();
let syncing = false;

export function onSyncStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isSyncing(): boolean {
  return syncing;
}

/** Wraps the active provider's sync so every caller (manual tap, background timer) drives the same UI feedback. */
export async function runSync(): Promise<SyncResult> {
  if (syncing) return { ok: true, toRemote: 0, toLocal: 0, skipped: 0 };
  syncing = true;
  listeners.forEach((l) => l(true));
  try {
    const provider = await getActiveProvider();
    const result: SyncResult =
      provider === 'github' ? await doSync() : { ok: false, error: 'No sync provider connected' };
    if (result.ok) cleanOrphanedAttachments();
    syncing = false;
    listeners.forEach((l) => l(false, result));
    return result;
  } catch (e) {
    syncing = false;
    listeners.forEach((l) => l(false));
    throw e;
  }
}
