import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Feather } from '@expo/vector-icons';
import { storageCategories, listCategoryFiles, deleteAttachmentFile, StorageCategory, FileEntry } from '../../notes';
import { useThemeCtx } from '../../themeContext';

function formatBytes(n: number): string {
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  const v = n / Math.pow(1024, i);
  return (i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
}

type DetailState = { key: string; label: string; color: string; files: FileEntry[] };
type DeleteConfirm = { categoryKey: string; fileName: string };

export default function SpaceScreen() {
  const { theme: t } = useThemeCtx();
  const [cats, setCats] = useState<StorageCategory[]>([]);
  const [total, setTotal] = useState(0);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm | null>(null);
  const lastTap = useRef<{ key: string; at: number } | null>(null);

  function refreshTotals() {
    storageCategories().then((r) => {
      setCats(r.categories);
      setTotal(r.total);
    });
  }

  useFocusEffect(useCallback(() => { refreshTotals(); }, []));

  function onCategoryPress(c: StorageCategory) {
    const now = Date.now();
    if (lastTap.current?.key === c.key && now - lastTap.current.at < 400) {
      lastTap.current = null;
      setDetail({ key: c.key, label: c.label, color: c.color, files: listCategoryFiles(c.key) });
    } else {
      lastTap.current = { key: c.key, at: now };
    }
  }

  function doDelete() {
    if (!deleteConfirm) return;
    const { categoryKey, fileName } = deleteConfirm;
    setDeleteConfirm(null);
    deleteAttachmentFile(categoryKey, fileName);
    setDetail((prev) => prev ? { ...prev, files: prev.files.filter((f) => f.name !== fileName) } : null);
    refreshTotals();
  }

  const nonZero = cats.filter((c) => c.size > 0).sort((a, b) => b.size - a.size);
  const sortedAll = [...cats].sort((a, b) => b.size - a.size);

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1, backgroundColor: t.bgBase }} contentContainerStyle={styles.scroll}>

        {/* Storage bar */}
        <View style={[styles.barTrack, { backgroundColor: t.border }]}>
          {nonZero.map((c) => {
            const pct = total > 0 ? (c.size / total) * 100 : 0;
            return (
              <View
                key={c.key}
                style={{ width: `${Math.max(pct, 0.4)}%`, backgroundColor: c.color, height: '100%' }}
              />
            );
          })}
        </View>

        {/* Legend */}
        <View style={styles.legend}>
          {nonZero.map((c) => (
            <View key={c.key} style={styles.legendItem}>
              <View style={[styles.dot, { backgroundColor: c.color }]} />
              <Text style={{ color: t.textMuted, fontSize: 12 }}>{c.label}</Text>
            </View>
          ))}
        </View>

        {/* Total */}
        <View style={[styles.totalCard, { backgroundColor: t.bgSurface }]}>
          <Text style={{ color: t.textMuted, fontSize: 14 }}>Total used</Text>
          <Text style={{ color: t.textPrimary, fontWeight: '700', fontSize: 16 }}>{formatBytes(total)}</Text>
        </View>

        {/* Category rows */}
        <Text style={[styles.sectionLabel, { color: t.textMuted }]}>Categories</Text>
        {sortedAll.map((c) => {
          const pct = total > 0 ? (c.size / total) * 100 : 0;
          return (
            <Pressable
              key={c.key}
              onPress={() => onCategoryPress(c)}
              style={[styles.catCard, { backgroundColor: t.bgSurface }]}
            >
              <View style={styles.catTop}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={[styles.dot, { backgroundColor: c.color }]} />
                  <Text style={{ color: t.textPrimary, fontSize: 14, fontWeight: '500' }}>{c.label}</Text>
                  <Text style={{ color: t.textMuted, fontSize: 12 }}>
                    {c.count} file{c.count !== 1 ? 's' : ''}
                  </Text>
                </View>
                <Text style={{ color: t.textPrimary, fontSize: 13, fontWeight: '600' }}>{formatBytes(c.size)}</Text>
              </View>
              <View style={[styles.miniBarTrack, { backgroundColor: t.border }]}>
                <View style={[styles.miniBarFill, { width: `${Math.max(pct, 0)}%`, backgroundColor: c.color }]} />
              </View>
            </Pressable>
          );
        })}

        <Text style={[styles.hint, { color: t.textMuted }]}>
          Double-tap a category to browse its files.
        </Text>
      </ScrollView>

      {/* Detail panel */}
      {detail && (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <Pressable style={[StyleSheet.absoluteFill, styles.backdrop]} onPress={() => setDetail(null)} />
          <View style={styles.overlayCenter} pointerEvents="box-none">
            <View style={[styles.detailBox, { backgroundColor: t.bgRaised, borderColor: t.border }]}>
              <View style={styles.detailHeader}>
                <View style={[styles.dot, { backgroundColor: detail.color, width: 10, height: 10, borderRadius: 5 }]} />
                <Text style={[styles.detailTitle, { color: t.textPrimary }]}>{detail.label}</Text>
                <Pressable onPress={() => setDetail(null)} style={{ marginLeft: 'auto' }} hitSlop={8}>
                  <Feather name="x" size={18} color={t.textMuted} />
                </Pressable>
              </View>
              {detail.files.length === 0 ? (
                <Text style={{ color: t.textMuted, fontSize: 13, textAlign: 'center', marginVertical: 12 }}>No files.</Text>
              ) : (
                <ScrollView showsVerticalScrollIndicator style={styles.detailScroll}>
                  {detail.files.map((f, i) => (
                    <View
                      key={i}
                      style={[styles.fileRow, { borderBottomColor: t.border }]}
                    >
                      <Text style={[styles.fileName, { color: t.textPrimary }]} numberOfLines={1}>{f.name}</Text>
                      <Text style={[styles.fileSize, { color: t.textMuted }]}>{formatBytes(f.size)}</Text>
                      {detail.key !== 'notes' && (
                        <Pressable
                          onPress={() => setDeleteConfirm({ categoryKey: detail.key, fileName: f.name })}
                          hitSlop={8}
                        >
                          <Feather name="trash-2" size={15} color="#ff453a" />
                        </Pressable>
                      )}
                    </View>
                  ))}
                </ScrollView>
              )}
              {detail.key !== 'notes' && (
                <Text style={styles.attachWarning}>
                  Removing an attachment is irreversible — the note will no longer be able to display it.
                </Text>
              )}
            </View>
          </View>
        </View>
      )}

      {/* Delete confirm */}
      {deleteConfirm && (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <Pressable style={[StyleSheet.absoluteFill, styles.backdrop]} onPress={() => setDeleteConfirm(null)} />
          <View style={styles.overlayCenter} pointerEvents="box-none">
            <View style={[styles.detailBox, { backgroundColor: t.bgRaised, borderColor: t.border }]}>
              <Feather name="trash-2" size={26} color="#ff453a" style={{ alignSelf: 'center', marginBottom: 10 }} />
              <Text style={[styles.detailTitle, { color: t.textPrimary, textAlign: 'center', marginBottom: 6 }]}>
                Delete attachment?
              </Text>
              <Text style={{ color: t.textMuted, fontSize: 13, textAlign: 'center', marginBottom: 6 }} numberOfLines={2}>
                {deleteConfirm.fileName}
              </Text>
              <Text style={[styles.attachWarning, { marginBottom: 20 }]}>
                This is irreversible. The note that referenced this file will no longer be able to show it.
              </Text>
              <View style={styles.modalActions}>
                <Pressable
                  style={[styles.modalBtn, { backgroundColor: t.bgSurface }]}
                  onPress={() => setDeleteConfirm(null)}
                >
                  <Text style={{ color: t.textMuted, fontWeight: '600' }}>Cancel</Text>
                </Pressable>
                <Pressable style={[styles.modalBtn, { backgroundColor: '#ff453a' }]} onPress={doDelete}>
                  <Text style={{ color: '#fff', fontWeight: '700' }}>Delete</Text>
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
  scroll: { padding: 16, paddingBottom: 36 },
  barTrack: { flexDirection: 'row', height: 18, borderRadius: 9, overflow: 'hidden' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 10, gap: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  totalCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginTop: 16,
    marginBottom: 4,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: 20,
    marginBottom: 8,
    marginLeft: 4,
  },
  catCard: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  catTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  miniBarTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  miniBarFill: { height: '100%' },
  hint: { fontSize: 11, marginTop: 16, lineHeight: 16 },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.55)' },
  overlayCenter: { flex: 1, justifyContent: 'center', padding: 24 },
  detailBox: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, padding: 18, maxHeight: '75%' },
  detailHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  detailTitle: { fontSize: 15, fontWeight: '700' },
  detailScroll: { flexGrow: 0 },
  fileRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
  fileName: { fontSize: 13, flex: 1 },
  fileSize: { fontSize: 12, flexShrink: 0 },
  attachWarning: { color: '#ff453a', fontSize: 11, lineHeight: 16, marginTop: 12, textAlign: 'center' },
  modalActions: { flexDirection: 'row', justifyContent: 'center', gap: 12 },
  modalBtn: { paddingVertical: 11, paddingHorizontal: 26, borderRadius: 11 },
});
