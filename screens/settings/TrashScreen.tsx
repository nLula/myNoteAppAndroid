import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Feather } from '@expo/vector-icons';
import { listTrash, NoteMeta, restoreFromTrash, emptyTrash } from '../../notes';
import { useThemeCtx } from '../../themeContext';

export default function TrashScreen() {
  const { theme: t } = useThemeCtx();
  const [items, setItems] = useState<NoteMeta[]>([]);
  const [emptying, setEmptying] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const refresh = useCallback(() => {
    listTrash().then(setItems);
  }, []);

  useFocusEffect(refresh);

  async function onRestore(name: string) {
    await restoreFromTrash(name);
    refresh();
  }

  async function doEmptyTrash() {
    setConfirmOpen(false);
    setEmptying(true);
    try {
      await emptyTrash();
      refresh();
    } finally {
      setEmptying(false);
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: t.bgBase }]}>
      <View style={styles.topBar}>
        <Text style={[styles.hint, { color: t.textMuted }]}>
          Notes here can be restored or permanently deleted.
        </Text>
        {items.length > 0 && (
          <Pressable
            onPress={() => setConfirmOpen(true)}
            disabled={emptying}
            style={[styles.emptyBtn, { borderColor: '#ff453a', borderWidth: StyleSheet.hairlineWidth }]}
          >
            <Feather name="trash-2" size={13} color="#ff453a" />
            <Text style={styles.emptyBtnText}>{emptying ? 'Deleting…' : 'Empty Trash'}</Text>
          </Pressable>
        )}
      </View>

      <FlatList
        data={items}
        keyExtractor={(item) => item.name}
        contentContainerStyle={{ paddingBottom: 24 }}
        renderItem={({ item }) => (
          <View style={[styles.card, { backgroundColor: t.bgSurface }]}>
            <Text style={[styles.cardTitle, { color: t.textPrimary }]} numberOfLines={1}>
              {item.title}
            </Text>
            <Pressable onPress={() => onRestore(item.name)} style={styles.restoreBtn}>
              <Feather name="rotate-ccw" size={14} color={t.accent} />
              <Text style={[styles.restoreText, { color: t.accent }]}>Restore</Text>
            </Pressable>
          </View>
        )}
        ListEmptyComponent={<Text style={[styles.empty, { color: t.textMuted }]}>Trash is empty.</Text>}
      />

      {confirmOpen && (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <Pressable style={[StyleSheet.absoluteFill, styles.backdrop]} onPress={() => setConfirmOpen(false)} />
          <View style={styles.overlayCenter} pointerEvents="box-none">
            <View style={[styles.modalBox, { backgroundColor: t.bgRaised, borderColor: t.border }]}>
              <Feather name="trash-2" size={28} color="#ff453a" style={{ alignSelf: 'center', marginBottom: 12 }} />
              <Text style={[styles.modalMsg, { color: t.textPrimary }]}>
                Permanently delete {items.length} note{items.length !== 1 ? 's' : ''} and their attachments?
              </Text>
              <Text style={[styles.modalSub, { color: t.textMuted }]}>This cannot be undone.</Text>
              <View style={styles.modalActions}>
                <Pressable
                  style={[styles.modalBtn, { backgroundColor: t.bgSurface }]}
                  onPress={() => setConfirmOpen(false)}
                >
                  <Text style={{ color: t.textMuted, fontWeight: '600' }}>Cancel</Text>
                </Pressable>
                <Pressable style={[styles.modalBtn, { backgroundColor: '#ff453a' }]} onPress={doEmptyTrash}>
                  <Text style={{ color: '#fff', fontWeight: '700' }}>Delete All</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  hint: { fontSize: 12, lineHeight: 17, flex: 1, marginRight: 12 },
  emptyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    gap: 5,
  },
  emptyBtnText: { color: '#ff453a', fontSize: 13, fontWeight: '600' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    marginBottom: 8,
  },
  cardTitle: { flex: 1, fontSize: 15 },
  restoreBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, padding: 4 },
  restoreText: { fontSize: 13, fontWeight: '600' },
  empty: { textAlign: 'center', marginTop: 40 },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.55)' },
  overlayCenter: { flex: 1, justifyContent: 'center', padding: 28 },
  modalBox: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, padding: 24 },
  modalMsg: { fontSize: 15, textAlign: 'center', fontWeight: '600', lineHeight: 22 },
  modalSub: { fontSize: 13, textAlign: 'center', marginTop: 6, marginBottom: 20 },
  modalActions: { flexDirection: 'row', justifyContent: 'center', gap: 12 },
  modalBtn: { paddingVertical: 11, paddingHorizontal: 26, borderRadius: 11 },
});
