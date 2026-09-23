import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { getConfig, getPat, saveConfig, savePat, testConnection } from '../../lib/github';
import { runSync } from '../../lib/syncStatus';
import { setActiveProvider } from '../../lib/syncProvider';
import { useThemeCtx } from '../../themeContext';

const STEPS = [0, 30, 60, 300, 900, 1800, 3600];
const LABELS = ['Never', '30 s', '1 m', '5 m', '15 m', '30 m', '1 h'];

export default function GithubScreen() {
  const { theme: t } = useThemeCtx();
  const [repoUrl, setRepoUrl] = useState('');
  const [pat, setPat] = useState('');
  const [connected, setConnected] = useState(false);
  const [lastSync, setLastSync] = useState(0);
  const [stepIdx, setStepIdx] = useState(3);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    (async () => {
      const cfg = await getConfig();
      setRepoUrl(cfg.repoUrl);
      setConnected(cfg.connected);
      setLastSync(cfg.lastSync);
      const idx = STEPS.indexOf(cfg.syncInterval);
      setStepIdx(idx === -1 ? 3 : idx);
      setPat(await getPat());
    })();
  }, []);

  async function onConnect() {
    if (!repoUrl.trim() || !pat.trim()) {
      Alert.alert('Missing info', 'Repo URL and Personal Access Token are both required.');
      return;
    }
    setBusy(true);
    setStatus('Testing connection…');
    try {
      await testConnection(repoUrl, pat);
      await savePat(pat);
      await saveConfig({ repoUrl, connected: true, lastSync: 0, syncInterval: STEPS[stepIdx] });
      await setActiveProvider('github');
      setConnected(true);
      setStatus('Connected successfully.');
    } catch (e: any) {
      setStatus(`Connection failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function onIntervalChange(idx: number) {
    setStepIdx(idx);
    const cfg = await getConfig();
    await saveConfig({ ...cfg, syncInterval: STEPS[idx] });
  }

  async function onSyncNow() {
    setBusy(true);
    setStatus('Syncing…');
    try {
      const r = await runSync();
      if (!r.ok) { setStatus(`Sync error: ${r.error}`); return; }
      setLastSync(Date.now() / 1000);
      let msg = `Synced — ↑${r.toRemote ?? 0} to GitHub, ↓${r.toLocal ?? 0} to device`;
      if (r.conflicts?.length) msg += `\nConflicts: ${r.conflicts.join(', ')}`;
      setStatus(msg);
    } catch (e: any) {
      setStatus(`Sync error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bgBase }} contentContainerStyle={styles.scroll}>

      <Text style={[styles.sectionLabel, { color: t.textMuted }]}>Connection</Text>
      <View style={[styles.card, { backgroundColor: t.bgSurface }]}>
        <Text style={[styles.fieldLabel, { color: t.textMuted }]}>GitHub Repository URL</Text>
        <TextInput
          style={[styles.input, { backgroundColor: t.bgBase, borderColor: t.border, color: t.textPrimary }]}
          placeholder="https://github.com/owner/repo"
          placeholderTextColor={t.textMuted}
          value={repoUrl}
          onChangeText={setRepoUrl}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={[styles.fieldLabel, { color: t.textMuted, marginTop: 12 }]}>Personal Access Token</Text>
        <TextInput
          style={[styles.input, { backgroundColor: t.bgBase, borderColor: t.border, color: t.textPrimary }]}
          placeholder="ghp_…"
          placeholderTextColor={t.textMuted}
          value={pat}
          onChangeText={setPat}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable
          style={[styles.btn, { backgroundColor: t.accent, marginTop: 14, opacity: busy ? 0.5 : 1 }]}
          onPress={onConnect}
          disabled={busy}
        >
          <Text style={styles.btnText}>{connected ? 'Reconnect' : 'Connect'}</Text>
        </Pressable>
      </View>

      <Text style={[styles.sectionLabel, { color: t.textMuted }]}>Status</Text>
      <View style={[styles.card, { backgroundColor: t.bgSurface }]}>
        <View style={[styles.statusRow, { borderBottomColor: t.border }]}>
          <Text style={[styles.statusKey, { color: t.textMuted }]}>Connected</Text>
          <Text style={[styles.statusVal, { color: connected ? t.accent : t.textMuted }]}>
            {connected ? 'Yes' : 'No'}
          </Text>
        </View>
        <View style={styles.statusRow}>
          <Text style={[styles.statusKey, { color: t.textMuted }]}>Last sync</Text>
          <Text style={[styles.statusVal, { color: t.textPrimary }]}>
            {lastSync ? new Date(lastSync * 1000).toLocaleString() : '—'}
          </Text>
        </View>
      </View>

      <Text style={[styles.sectionLabel, { color: t.textMuted }]}>Auto-sync</Text>
      <View style={[styles.card, { backgroundColor: t.bgSurface }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={[styles.fieldLabel, { color: t.textMuted, marginBottom: 0 }]}>Interval</Text>
          <Text style={[styles.intervalValue, { color: t.textPrimary }]}>{LABELS[stepIdx]}</Text>
        </View>
        <Slider
          style={{ width: '100%', height: 36, marginTop: 4 }}
          minimumValue={0}
          maximumValue={STEPS.length - 1}
          step={1}
          value={stepIdx}
          onSlidingComplete={onIntervalChange}
          minimumTrackTintColor={t.accent}
          maximumTrackTintColor={t.border}
          thumbTintColor={t.accent}
        />
        <View style={styles.tickRow}>
          {LABELS.map((l) => (
            <Text key={l} style={[styles.tick, { color: t.textMuted }]}>{l}</Text>
          ))}
        </View>
      </View>

      <Pressable
        style={[styles.btn, { backgroundColor: t.accent, opacity: busy || !connected ? 0.45 : 1 }]}
        onPress={onSyncNow}
        disabled={busy || !connected}
      >
        <Text style={styles.btnText}>Sync Now</Text>
      </Pressable>

      {connected && (
        <Pressable
          style={[styles.btn, { backgroundColor: t.bgSurface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, marginTop: 10 }]}
          onPress={async () => {
            const cfg = await getConfig();
            await saveConfig({ ...cfg, connected: false });
            await setActiveProvider('none');
            setConnected(false);
          }}
        >
          <Text style={{ color: t.textMuted, fontWeight: '600' }}>Disconnect</Text>
        </Pressable>
      )}

      {!!status && (
        <View style={[styles.statusBubble, { backgroundColor: t.bgSurface }]}>
          <Text style={{ color: t.textPrimary, fontSize: 13, lineHeight: 19 }}>{status}</Text>
        </View>
      )}

      <Text style={[styles.disclaimer, { color: t.textMuted }]}>
        Files larger than 47 MB cannot be synchronized.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 40 },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8, marginTop: 20, marginLeft: 4 },
  card: { borderRadius: 14, padding: 16, marginBottom: 4 },
  fieldLabel: { fontSize: 12, fontWeight: '500', marginBottom: 6 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  btn: { borderRadius: 11, paddingVertical: 13, alignItems: 'center', marginTop: 16 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  statusKey: { fontSize: 14 },
  statusVal: { fontSize: 14, fontWeight: '600' },
  intervalValue: { fontSize: 15, fontWeight: '600' },
  tickRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 0 },
  tick: { fontSize: 9 },
  statusBubble: { borderRadius: 10, padding: 12, marginTop: 16 },
  disclaimer: { fontSize: 12, marginTop: 20, textAlign: 'center', lineHeight: 18 },
});
