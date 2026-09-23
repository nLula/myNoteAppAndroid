import { useCallback, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Feather } from '@expo/vector-icons';
import { listLockedNotes, LockedNoteMeta, unlockNoteForever } from '../../notes';
import { useThemeCtx } from '../../themeContext';

export default function LockScreen() {
  const { theme: t } = useThemeCtx();
  const [items, setItems] = useState<LockedNoteMeta[]>([]);
  const [target, setTarget] = useState<LockedNoteMeta | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    listLockedNotes().then(setItems);
  }, []);

  useFocusEffect(refresh);

  function openUnlock(item: LockedNoteMeta) {
    setTarget(item);
    setPassword('');
    setError('');
  }

  async function confirmUnlock() {
    if (!target) return;
    setBusy(true);
    setError('');
    try {
      await unlockNoteForever(target.name, password);
      setTarget(null);
      refresh();
    } catch {
      setError('Wrong password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: t.bgBase }]}>
      <Text style={[styles.hint, { color: t.textMuted }]}>
        Tap × to permanently decrypt a note. You will be asked for its password.
      </Text>

      <FlatList
        data={items}
        keyExtractor={(item) => item.name}
        contentContainerStyle={{ paddingBottom: 24 }}
        renderItem={({ item }) => (
          <View style={[styles.card, { backgroundColor: t.bgSurface }]}>
            <Feather name="lock" size={15} color={t.textMuted} style={{ marginRight: 10 }} />
            <Text style={[styles.cardText, { color: t.textPrimary }]} numberOfLines={1}>
              {item.title}
            </Text>
            <Pressable onPress={() => openUnlock(item)} style={styles.unlockBtn} hitSlop={8}>
              <Text style={{ color: t.textMuted, fontSize: 20, lineHeight: 22 }}>×</Text>
            </Pressable>
          </View>
        )}
        ListEmptyComponent={<Text style={[styles.empty, { color: t.textMuted }]}>No locked notes.</Text>}
      />

      <Modal visible={!!target} transparent animationType="fade" onRequestClose={() => setTarget(null)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, { backgroundColor: t.bgRaised, borderColor: t.border }]}>
            <Text style={[styles.modalTitle, { color: t.textPrimary }]}>
              Unlock "{target?.title}"
            </Text>
            <TextInput
              style={[styles.input, { backgroundColor: t.bgBase, borderColor: t.border, color: t.textPrimary }]}
              placeholder="Password"
              placeholderTextColor={t.textMuted}
              secureTextEntry
              autoFocus
              value={password}
              onChangeText={setPassword}
              onSubmitEditing={confirmUnlock}
            />
            {!!error && <Text style={styles.errorText}>{error}</Text>}
            <View style={styles.modalActions}>
              <Pressable style={[styles.modalBtn, { backgroundColor: t.bgSurface }]} onPress={() => setTarget(null)}>
                <Text style={{ color: t.textMuted, fontWeight: '600' }}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalBtn, { backgroundColor: t.accent, opacity: busy ? 0.5 : 1 }]}
                onPress={confirmUnlock}
                disabled={busy}
              >
                <Text style={{ color: '#fff', fontWeight: '700' }}>{busy ? 'Unlocking…' : 'Unlock'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  hint: { fontSize: 12, marginBottom: 14, lineHeight: 17 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    marginBottom: 8,
  },
  cardText: { flex: 1, fontSize: 15 },
  unlockBtn: { padding: 6 },
  empty: { textAlign: 'center', marginTop: 40 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 24 },
  modalBox: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, padding: 22 },
  modalTitle: { fontSize: 16, fontWeight: '600', marginBottom: 14 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  errorText: { color: '#e5484d', marginTop: 8, fontSize: 13 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 18, gap: 10 },
  modalBtn: { borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20 },
});
