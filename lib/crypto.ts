import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha2';
import * as Crypto from 'expo-crypto';

// In the production APK, react-native-quick-crypto's native PBKDF2 runs in ~200ms.
// In Expo Go, the native module isn't bundled → require() throws → caught → falls back
// to @noble/hashes pbkdf2Async (~13s but non-blocking so the UI stays responsive).
async function deriveKeyBytes(password: string, salt: Uint8Array): Promise<Uint8Array> {
  try {
    const qc = require('react-native-quick-crypto') as { pbkdf2Sync: Function };
    // password as string, salt as Uint8Array — both are BinaryLike in quick-crypto
    const buf: Buffer = qc.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch {
    // Expo Go or any other env where native module is unavailable
    return pbkdf2Async(sha256, password, salt, { c: 100000, dkLen: 32 });
  }
}

/**
 * Decrypt note bodies encrypted by myNote's web crypto (PBKDF2-SHA256 100k iters
 * → AES-256-GCM). Layout: [salt(16) | iv(12) | ciphertext+tag].
 * Wrong password / corrupt data throws.
 */
export async function decryptNoteBody(b64: string, password: string): Promise<string> {
  const bin = atobToBytes(b64);
  const salt = bin.slice(0, 16);
  const iv = bin.slice(16, 28);
  const ciphertext = bin.slice(28);

  const key = await deriveKeyBytes(password, salt);
  const plainBytes = gcm(key, iv).decrypt(ciphertext);
  return new TextDecoder().decode(plainBytes);
}

/** Encrypt note body the same way the PC app does, for parity. */
export async function encryptNoteBody(text: string, password: string): Promise<string> {
  const salt = Crypto.getRandomBytes(16);
  const key = await deriveKeyBytes(password, salt);
  return encryptWithKey(text, key, salt);
}

/** Derives the AES key for a given password/salt pair. */
export async function deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return deriveKeyBytes(password, salt);
}

/** Extracts the salt from an encrypted blob without doing any key derivation. */
export function extractSalt(b64: string): Uint8Array {
  return atobToBytes(b64).slice(0, 16);
}

/** Decrypts using an already-derived key (cheap — no PBKDF2). */
export function decryptWithKey(b64: string, key: Uint8Array): string {
  const bin = atobToBytes(b64);
  const iv = bin.slice(16, 28);
  const ciphertext = bin.slice(28);
  const plainBytes = gcm(key, iv).decrypt(ciphertext);
  return new TextDecoder().decode(plainBytes);
}

/** Encrypts using an already-derived key + the session's salt (cheap — no PBKDF2). */
export function encryptWithKey(text: string, key: Uint8Array, salt: Uint8Array): string {
  const iv = Crypto.getRandomBytes(12);
  const ct = gcm(key, iv).encrypt(new TextEncoder().encode(text));

  const out = new Uint8Array(28 + ct.length);
  out.set(salt, 0);
  out.set(iv, 16);
  out.set(ct, 28);
  return bytesToB64(out);
}

function atobToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
