import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { getTags, setTags } from '../notes';
import { useThemeCtx } from '../themeContext';

export default function TagsScreen({ route, navigation }: any) {
  const { theme: t } = useThemeCtx();
  const { name } = route.params as { name: string };
  const [tags, setTagsState] = useState<string[]>([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    navigation.setOptions({
      title: 'Tags',
      headerStyle: { backgroundColor: t.bgSurface },
      headerTintColor: t.textPrimary,
      headerBackTitle: 'Back',
    });
    setTagsState(getTags(name));
  }, [name]);

  function persist(next: string[]) {
    setTagsState(next);
    setTags(name, next);
  }

  function removeTag(tag: string) {
    persist(tags.filter((x) => x !== tag));
  }

  function addTag() {
    const v = input.trim();
    if (!v || tags.includes(v)) {
      setInput('');
      return;
    }
    persist([...tags, v]);
    setInput('');
  }

  return (
    <View style={[styles.container, { backgroundColor: t.bgBase }]}>
      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: t.textMuted }]}>Tags on this note</Text>
        <ScrollView contentContainerStyle={styles.chipWrap}>
          {tags.length === 0 ? (
            <Text style={{ color: t.textMuted }}>No tags yet.</Text>
          ) : (
            tags.map((tag) => (
              <View key={tag} style={[styles.chip, { backgroundColor: t.bgSurface, borderColor: t.border }]}>
                <Text style={{ color: t.textPrimary, marginRight: 8 }}>{tag}</Text>
                <Pressable onPress={() => removeTag(tag)}>
                  <Text style={{ color: t.textMuted, fontSize: 16 }}>×</Text>
                </Pressable>
              </View>
            ))
          )}
        </ScrollView>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: t.textMuted }]}>Add a tag</Text>
        <View style={[styles.inputRow, { borderColor: t.border, backgroundColor: t.bgSurface }]}>
          <TextInput
            style={[styles.input, { color: t.textPrimary }]}
            placeholder="New tag"
            placeholderTextColor={t.textMuted}
            value={input}
            onChangeText={setInput}
            onSubmitEditing={addTag}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable onPress={addTag} style={styles.addBtn}>
            <Text style={{ color: t.accent, fontWeight: '600' }}>Add</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  section: { marginBottom: 24 },
  sectionLabel: { fontSize: 12, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  inputRow: { flexDirection: 'row', borderWidth: 1, borderRadius: 8, alignItems: 'center', paddingHorizontal: 4 },
  input: { flex: 1, paddingHorizontal: 10, paddingVertical: 10 },
  addBtn: { padding: 10 },
});
