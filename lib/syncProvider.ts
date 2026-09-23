import AsyncStorage from '@react-native-async-storage/async-storage';

export type SyncProvider = 'none' | 'github';

const KEY = 'mynote_sync_provider';
let cached: SyncProvider | null = null;

export async function getActiveProvider(): Promise<SyncProvider> {
  if (cached) return cached;
  const v = await AsyncStorage.getItem(KEY);
  cached = (v as SyncProvider) ?? 'none';
  return cached;
}

export async function setActiveProvider(p: SyncProvider): Promise<void> {
  cached = p;
  await AsyncStorage.setItem(KEY, p);
}
