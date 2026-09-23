import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { useThemeCtx } from '../../themeContext';

const EMAIL_KEY = 'mynote_user_email';
const PASS_KEY = 'mynote_email_password';

export default function EmailScreen() {
  const { theme: t } = useThemeCtx();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(EMAIL_KEY).then((v) => setEmail(v ?? ''));
    SecureStore.getItemAsync(PASS_KEY).then((v) => setPassword(v ?? ''));
  }, []);

  async function onSave() {
    await AsyncStorage.setItem(EMAIL_KEY, email.trim());
    await SecureStore.setItemAsync(PASS_KEY, password);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <View style={[styles.container, { backgroundColor: t.bgBase }]}>
      <Text style={[styles.label, { color: t.textMuted }]}>Email address</Text>
      <TextInput
        style={[styles.input, { backgroundColor: t.bgSurface, borderColor: t.border, color: t.textPrimary }]}
        placeholder="user@example.com"
        placeholderTextColor={t.textMuted}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
      />

      <Text style={[styles.label, { color: t.textMuted }]}>Password</Text>
      <TextInput
        style={[styles.input, { backgroundColor: t.bgSurface, borderColor: t.border, color: t.textPrimary }]}
        placeholder="Email password"
        placeholderTextColor={t.textMuted}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Pressable style={[styles.btn, { backgroundColor: t.accent }]} onPress={onSave}>
        <Text style={styles.btnText}>{saved ? 'Saved' : 'Save'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  label: { fontSize: 13, marginTop: 12, marginBottom: 4 },
  input: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8 },
  btn: { borderRadius: 6, paddingVertical: 12, marginTop: 16, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
});
