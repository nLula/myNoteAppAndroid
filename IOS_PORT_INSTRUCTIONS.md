# myNote — iOS Port Instructions

This document is a complete briefing for Claude Code on macOS to port the existing
**myNoteAppAndroid** React Native / Expo app to iOS. Read every section before
touching any file.

---

## 1. What Is This App

**myNote** is a personal Markdown notes app. It is a companion mobile client to a
desktop PC app (also called myNote) that stores notes as `.md` files and syncs them
via a GitHub repository. The mobile app must be fully compatible with the PC app's
file/format conventions so notes can be created on either device and round-trip
correctly.

Key capabilities:
- Create / edit / delete Markdown notes stored as `.md` files
- Tag notes with YAML frontmatter tags
- Lock notes with AES-256-GCM encryption (PBKDF2-SHA256, 100k iterations)
- Sync notes and binary attachments bidirectionally with a GitHub repo
- View notes rendered as Markdown, with inline audio/video players
- Export notes to PDF or HTML
- Dark / light theme (toggleable, persisted)
- Note edit history tracked in `.history.json` sidecars

---

## 2. Repository Layout

```
myNoteAppAndroid/          ← root (this is the iOS project root too)
├── App.tsx                ← root component, navigation container, auto-sync
├── index.ts               ← Expo entry point
├── app.json               ← Expo config (EAS project ID, icons, permissions)
├── eas.json               ← EAS Build profiles
├── package.json
├── theme.ts               ← light / dark colour tokens
├── themeContext.tsx        ← React context + toggle + AsyncStorage persistence
├── notes.ts               ← ALL local file I/O (create/read/write/delete/history/crypto)
├── lib/
│   ├── crypto.ts          ← AES-256-GCM encrypt/decrypt via @noble/* (pure JS, no native)
│   ├── github.ts          ← GitHub REST sync engine (notes + attachments + history merge)
│   ├── merge.ts           ← 3-way text merge for concurrent edits
│   ├── syncStatus.ts      ← global sync state broadcaster (listeners pattern)
│   ├── syncProvider.ts    ← active provider flag ('none' | 'github') in AsyncStorage
│   └── export.ts          ← PDF / HTML export via expo-print
├── screens/
│   ├── NoteListScreen.tsx ← main screen: toolbar, search, sort, pull-to-sync
│   ├── ViewScreen.tsx     ← Markdown renderer + inline media + history overlay
│   ├── EditorScreen.tsx   ← plain-text editor, auto-save, history on close
│   ├── TagsScreen.tsx     ← tag editor per note
│   ├── MediaPlayers.tsx   ← VideoAttachment, AudioAttachment, MediaUnavailableCard
│   └── settings/
│       ├── EmailScreen.tsx   ← email/password store (AsyncStorage + SecureStore)
│       ├── GithubScreen.tsx  ← GitHub URL + PAT + auto-sync interval slider
│       ├── LockScreen.tsx    ← list locked notes, permanently unlock
│       ├── SyncScreen.tsx    ← thin wrapper re-exporting GithubScreen
│       ├── TrashScreen.tsx   ← view trashed notes, restore, empty trash
│       └── SpaceScreen.tsx   ← storage usage bar chart, file list, delete attachments
└── assets/
    ├── icon.png           ← app icon (also adaptive icon foreground for Android)
    ├── favicon.png
    └── mynote_logo_small.png  ← 24×24 logo used in toolbar (spins during sync)
```

---

## 3. Tech Stack

| Concern | Package |
|---|---|
| Framework | Expo SDK 56 / React Native 0.85.3 |
| Language | TypeScript (strict) |
| Navigation | @react-navigation/native-stack (main) + @react-navigation/bottom-tabs (Settings) |
| File system | expo-file-system (new API: `File`, `Directory`, `Paths`) |
| Secure storage | expo-secure-store (GitHub PAT, email password) |
| Async KV store | @react-native-async-storage/async-storage (theme, sync config, provider) |
| Encryption | @noble/ciphers (AES-256-GCM), @noble/hashes (pbkdf2Async fallback + SHA-1 for git blob SHA), react-native-quick-crypto (native PBKDF2, fast) |
| File picker (images/video) | expo-image-picker ~56.0.18 |
| File picker (documents) | expo-document-picker ~56.0.4 |
| Markdown render | react-native-markdown-display + markdown-it |
| Images in markdown | react-native-fit-image (verify present in node_modules) |
| Media players | expo-video, expo-audio |
| Sharing | expo-sharing |
| PDF export | expo-print |
| Clipboard | expo-clipboard |
| Icons | @expo/vector-icons (Feather set) |
| Slider | @react-native-community/slider |
| Safe area | react-native-safe-area-context |
| Diff/merge | diff (npm package, pure JS) |

**Native modules required for fast crypto:**
- `react-native-quick-crypto` — native PBKDF2-SHA256 (~200ms vs ~13s pure JS)
- `react-native-quick-base64` — required peer dependency of quick-crypto
- `react-native-nitro-modules` — TurboModules foundation for quick-crypto

In Expo Go (development), these native modules are not bundled, so the code
falls back automatically to `@noble/hashes/pbkdf2Async` (pure JS, ~13s, non-blocking).
In the production build (APK/IPA), the native modules are linked and PBKDF2 is fast.

---

## 4. Data Storage Model

### Notes directory
All notes live in **`<App Documents>/notes/`**:
```
notes/
├── my-note.md              ← note file
├── my-note.history.json    ← history sidecar (same stem, .history.json)
├── another.md
├── .deletions.json         ← log of permanently deleted notes/attachments
└── github_state.json       ← sync state (SHA + timestamp per file)
```

`github_state.json` is actually at `Paths.document` root (one level above `notes/`),
not inside the `notes/` subdirectory.

### Note file format
Plain `.md` files. Optional YAML frontmatter block:
```
---
tags: [work, important]
encrypted: true
trashed_at: 1700000000.5
---
<body content here>
```

- `encrypted: true` → body is a base64 blob: `salt(16B) | iv(12B) | ciphertext+tag`
- `trashed_at` → Unix epoch seconds, set when note is moved to trash
- `tags` → bracket or list YAML format, both parsed

### Attachments directory
Binary attachments live in **`<App Documents>/attachments/<category>/<filename>`**:
```
attachments/
├── images/
├── documents/
├── videos/
├── audio/
└── archives/
```

Markdown links to attachments use relative paths: `![alt](/attachments/images/foo.jpg)`
or `[label](/attachments/audio/clip.mp3)`. The app resolves them to `file://` URIs at
render time.

### History sidecar format
JSON array, oldest-first:
```json
[{"at":"2024-01-15T10:30:00.000Z","via":"mobile","act":"created"},
 {"at":"2024-01-15T11:45:22.000Z","via":"mobile","act":"edited"}]
```
- `at` — full ISO 8601 UTC timestamp (PC writes local time without Z, mobile writes UTC with Z; both parse correctly via `Date.parse`)
- `via` — `"mobile"` (this app) or `"myNote"` (PC app)
- `act` — `"created"` | `"edited"`

### Deletions log (.deletions.json)
Tracks permanent deletions so sync can remove them from GitHub:
```json
{
  "settings": {"lastchanged": 1700000000},
  "deletions": [
    {"path":"audio/clip.mp3","type":"attachment","deleted_at":1700000000},
    {"path":"old-note.md","type":"note","deleted_at":1700000100}
  ]
}
```
Attachment paths are relative to `attachments/` (e.g. `"audio/clip.mp3"`).
Note paths are just the filename (e.g. `"old-note.md"`).

---

## 5. Encryption

**File:** `lib/crypto.ts`

All encryption is AES-256-GCM. Key derivation: PBKDF2-SHA256, 100,000 iterations,
32-byte output. This is the same scheme used by the PC app, so notes are
interoperable.

Binary layout of an encrypted body (base64-encoded):
```
[salt: 16 bytes][iv: 12 bytes][ciphertext + 16-byte GCM tag]
```

Public API (all exported):
- `decryptNoteBody(b64, password)` → Promise<string> — full decrypt from scratch
- `encryptNoteBody(text, password)` → Promise<string> — full encrypt from scratch
- `deriveKey(password, salt)` → Promise<Uint8Array> — expensive key derivation only
- `extractSalt(b64)` → Uint8Array — cheap, reads first 16 bytes
- `decryptWithKey(b64, key)` → string — fast decrypt using cached key
- `encryptWithKey(text, key, salt)` → string — fast encrypt using cached key

The "session" unlock flow (open-for-5-minutes without re-typing password):
1. User enters password → `openLockedSession(name, password)` in `notes.ts`
2. This calls `deriveKey` once, caches `{key, salt, expiresAt}` in a `Map` keyed by note name
3. Subsequent saves call `encryptWithKey` / `decryptWithKey` (no PBKDF2)
4. On unmount or timer expiry, `closeLockedSession` evicts the cache entry

**PBKDF2 performance:** `lib/crypto.ts` tries `require('react-native-quick-crypto')` at
runtime inside try/catch. In production builds (native modules linked), this gives ~200ms
key derivation. In Expo Go (native module not found), the error is caught and it falls
back to `pbkdf2Async` (~13s but non-blocking — UI shows a spinner). No code changes
needed on iOS; the same try/catch pattern applies.

---

## 6. GitHub Sync Engine

**File:** `lib/github.ts`

Syncs everything in the `notes/` directory plus `attachments/` to a GitHub repo.
Uses GitHub Contents API for small files (<900KB) and Git Data API for large files.

### State tracking
`github_state.json` stores `{sha, at}` per relative path:
- `sha` — the git blob SHA of the last-known-synced version
- `at` — epoch seconds when this file was last synced

### Sync loop (notes + history + deletions)
For each file in the union of local and remote:

1. **Both local and remote, identical SHA** → skip
2. **`.deletions.json`** → always merge both sides (union by path, keep latest `deleted_at`)
3. **`.history.json` files** → always merge both sides (union by `at` timestamp, sorted)
4. **Only local changed** → push to GitHub
5. **Only remote changed** → pull to local
6. **Both changed** → 3-way merge (base = last-synced SHA). If no base: last-write-wins
   by comparing `localMtime` (from history, not filesystem) vs commit timestamp
7. **Local only, never synced** → push as new
8. **Remote only, never synced** → pull as new
9. **Was synced, now missing from remote** → delete locally (remote deleted it)
10. **Was synced, now missing from local** → delete from GitHub

### Attachment sync
Binary files, no merge logic:
- Local only → push
- Remote only:
  - If in `.deletions.json` → DELETE from GitHub (stops it coming back)
  - Otherwise → pull to local
- 47MB practical limit (GitHub API hard limit for Content API ~100MB, but large
  files also slow sync significantly; the app warns users in the UI)

### History merge detail
The `mergeHistoryContent(local, remote)` function deduplicates by `at` key:
```typescript
const byAt = new Map<string, HEntry>();
for (const e of [...remote, ...local]) {
  if (!byAt.has(e.at)) byAt.set(e.at, e);
}
return JSON.stringify([...byAt.values()].sort((a, b) => a.at.localeCompare(b.at)));
```

### Key exported functions
- `doSync()` → SyncResult — full sync
- `testConnection(repoUrl, pat)` — throws if unreachable
- `getConfig()` / `saveConfig(cfg)` — stored in SecureStore
- `getPat()` / `savePat(pat)` — stored in SecureStore
- `gitBlobSha(content)` — computes `sha1("blob <len>\0<content>")` in pure JS

---

## 7. Theme System

**Files:** `theme.ts`, `themeContext.tsx`

Two themes: `darkTheme` and `lightTheme`. Both expose the same token set:

```typescript
type Theme = {
  bgBase: string;       // main background
  bgSurface: string;    // cards, headers, inputs
  bgRaised: string;     // elevated cards (modals, overlays)
  border: string;       // dividers, input borders
  textPrimary: string;  // main text
  textMuted: string;    // secondary text, icons, placeholders
  accent: string;       // interactive elements, highlights
  accentSubtle: string; // active-state button backgrounds
  dark: boolean;
};
```

Dark theme colours (warm dark, not cold blue-black):
- bgBase: `#1a1917`, bgSurface: `#242220`, bgRaised: `#2e2c29`
- border: `#3a3835`, textPrimary: `#e8e5e1`, textMuted: `#9e9b97`
- accent: `#c96442` (terracotta orange)

Light theme colours:
- bgBase: `#faf9f7`, bgSurface: `#f0ede9`, bgRaised: `#ffffff`
- border: `#e2ded9`, textPrimary: `#1a1917`, textMuted: `#706d69`
- accent: `#7A9E78` (sage green)

Theme is toggled via the moon/sun icon in the Settings header. Persisted in
AsyncStorage under key `'mynote_theme_override'`. Falls back to system scheme
on first launch.

All screens consume theme via `useThemeCtx()` hook — never import `useTheme()` directly.

---

## 8. Navigation Structure

```
Stack.Navigator
├── "Notes"    → NoteListScreen    (headerShown: false, custom toolbar)
├── "View"     → ViewScreen
├── "Editor"   → EditorScreen      (params: name, isLockedSession?)
├── "Tags"     → TagsScreen        (params: name)
└── "Settings" → SettingsScreen    (bottom-tab navigator)
    ├── "Email"  → EmailScreen
    ├── "Sync"   → SyncScreen (= GithubScreen)
    ├── "Lock"   → LockScreen
    ├── "Trash"  → TrashScreen
    └── "Space"  → SpaceScreen
```

---

## 9. Screen-by-Screen Description

### NoteListScreen
The main screen. Has no native header (`headerShown: false`). Custom toolbar at top:
- Animated spinning logo (24×24 `mynote_logo_small.png`) — spins while syncing
- Buttons: `+` (new note), edit pencil, tag, file-text (PDF export), share, lock
- Settings gear → navigates to Settings

Below toolbar: sliding bar with 3 slots (animated `translateX`):
1. Search input (always visible at rest)
2. New note name input (slides in when `+` pressed)
3. Password input (slides in for lock/unlock)

Sort bar: "Created / Alphabetic / Changed" buttons. Tap same sort = toggle asc/desc.

Notes list: `SectionList`. Sections: alphabetic letter groups (when alpha sort) or single
unlabelled section, plus a "Locked" section at bottom for encrypted notes.

**Pull-to-sync**: Custom `PanResponder` (NOT `RefreshControl`) so the list physically
slides down. The whole list `Animated.View` translates Y. A "Release to sync" hint
appears behind it. Uses rubberband formula `(raw * MAX_PULL) / (raw + MAX_PULL)`.
Key implementation details:
- `onMoveShouldSetPanResponderCapture` fires BEFORE the SectionList scroll responder
- `onPanResponderGrant`: reset `pullDistance.current = 0` (gs.dy resets to 0 on grant)
- `onPanResponderTerminationRequest: () => false` prevents SectionList reclaiming touch
- Capture condition: `gs.dy > 2 && gs.vy > 0` (low threshold so pull activates easily)
- `MAX_PULL = 56` (visual max travel in dp)
- Threshold: **22dp** to trigger sync (intentionally low — easy to pull)

Long-press on a note → in-app "Send to trash?" dialog (uses `Modal` here — acceptable
on iOS; the Android nav bar colour issue that made us avoid Modal does NOT affect iOS).

### ViewScreen
Reads note body, renders Markdown with `react-native-markdown-display`.

Markdown rendering customisations:
- `image` rule → uses `FitImage` (auto-sizing images)
- `fence` / `code_block` → `CodeBlock` component (themed + copy button)
- `markdown-it` instance with `validateLink: () => true` (allows `file://` URIs)

Attachment links (`![alt](/attachments/images/foo.jpg)`) are resolved to
`file://` URIs via `resolveAttachmentUri()` before rendering. Audio/video
attachment links are extracted as `BodySegment` objects and rendered as native
players (`VideoAttachment`, `AudioAttachment`), not as markdown.

Header shows Created / Last change dates (from history). Tapping opens a history
overlay (in-window `View` with `StyleSheet.absoluteFill`, NOT a `Modal`).

Header buttons: edit pencil (→ EditorScreen) and tag icon (→ TagsScreen).

### EditorScreen
Plain `TextInput` (multiline, scrollEnabled) inside `KeyboardAvoidingView`.
- Behavior: `'padding'` on iOS, `'height'` on Android (already in code)
- Bottom padding: `Math.max(insets.bottom + 60, 80)` — ensures last line clears iOS
  home indicator (34px) and Android nav buttons

**Header:** Only a paperclip (attachment) icon — no trash/delete button in the editor.
Deleting notes is done by long-press on the note list, not from the editor.

**New note pre-fill:** When a new note is created, its body is pre-populated with
`# <Note Title>\n`. The title is the filename stem (e.g. `My Note` → body starts with
`# My Note`). This is written by `NoteListScreen` when creating the note, before
navigating to the editor.

**Cursor position tracking:** `onSelectionChange` updates a `cursorPos` ref so that
`insertMarkdown(link)` can insert attachment links at the exact cursor position,
wrapping with newlines if the surrounding text isn't already on new lines.

Save logic:
- `onChange` → debounce 500ms → `autoSaveNoteBody` (saves without history entry)
- Unmount cleanup → `recordNoteHistory(name, initialBodyRef.current, contentRef.current)`
  — ONE history entry per editing session, only if body actually changed

For locked notes (`isLockedSession: true`):
- Reads via `readActiveSessionBody` (uses cached AES key, no PBKDF2)
- Saves via `saveLockedSession` (re-encrypts with cached key + random IV)
- Auto-relocks after 5 min via `sessionRemainingMs` + `setTimeout`

**Attachment (+File) feature:**
The paperclip icon opens a bottom sheet (StyleSheet.absoluteFill overlay, NOT Modal)
with three options:
1. **Photo / Video Library** → `expo-image-picker` `launchImageLibraryAsync`
2. **Camera** → `expo-image-picker` `launchCameraAsync`
3. **File** → `expo-document-picker` `getDocumentAsync({ type: '*/*', copyToCacheDirectory: false })`

All three call `handlePickedFile(uri, filename)` → `copyAttachmentToStorage(uri, filename)`
in `notes.ts` → inserts the markdown link at the cursor.

`copyAttachmentToStorage` in `notes.ts`:
- Determines the attachment category from the file extension (images/videos/audio/archives/documents)
- Normalises `content:/authority` (single-slash Android URI) to `content://authority`
- Uses `FileSystem.copyAsync({ from: normalizedUri, to: destUri })` — the legacy copyAsync
  handles both `file://` (from image picker) and `content://` (from document picker via ContentResolver)
- Avoids filename collisions by appending a timestamp suffix if the file already exists
- Returns the markdown link string:
  - Images: `![filename](/attachments/images/filename)`
  - All others: `[filename](/attachments/category/filename)`

**iOS note on file picker:** On iOS, `expo-document-picker` always returns `file://` URIs
(no `content://` scheme on iOS). The URI normalisation code is a no-op on iOS. The
`FileSystem.copyAsync` call works identically on iOS for `file://` URIs.

### TagsScreen
Fetches tags for the note, displays them as toggleable chips. Uses the app's own
`AsyncStorage`-backed tag vocabulary (reads all notes to build list). Saves via
`setTags(name, selectedTags)`.

### SettingsScreen
A `@react-navigation/bottom-tabs` navigator with 5 tabs: Email, Sync, Lock, Trash, Space.

### Settings / EmailScreen
Stores email (AsyncStorage) and password (SecureStore) for a mail account. Currently
just saves values — not yet connected to actual mail sending.

### Settings / SyncScreen / GithubScreen
GitHub sync configuration:
- Repo URL + Personal Access Token (PAT) text inputs
- "Connect" button → `testConnection` → saves to SecureStore / `getConfig`
- Auto-sync interval slider (0, 30s, 1m, 5m, 15m, 30m, 1h) — stored in SecureStore
- "Sync Now" button
- Disconnect button
- Red disclaimer: "Any files larger than 47 MB will not be synchronized."

### Settings / LockScreen
Lists all encrypted notes. Tap × → modal asks for password → `unlockNoteForever`
permanently decrypts the note in place (removes `encrypted: true` from frontmatter).
This screen still uses a `Modal` (acceptable on iOS).

### Settings / TrashScreen
Lists trashed notes (have `trash` tag in frontmatter). Per-row Restore button
(`restoreFromTrash`). "Empty Trash" button → in-app overlay confirmation → `emptyTrash`.
The overlay uses `StyleSheet.absoluteFill` (not Modal).

### Settings / SpaceScreen
Storage usage visualised as a coloured bar + per-category rows. Double-tap a
category to see its files in an in-window overlay. Attachment files (not notes) have
a red trash icon to delete them (calls `deleteAttachmentFile` which also writes to
`.deletions.json`). Has confirmation overlay before deleting.

---

## 10. Sync Auto-Start

`App.tsx` runs `useAutoSync()` on mount:
- Reads `getActiveProvider()` + `getConfig().syncInterval` every 15 seconds
  (to pick up changes made in Settings without needing a restart)
- Sets a `setInterval` at the configured interval to call `runSync()`
- `runSync()` in `lib/syncStatus.ts` is a singleton — concurrent calls are no-ops

All sync feedback (spinning logo, post-sync list refresh) is driven by
`onSyncStatus(listener)` pub/sub in `syncStatus.ts`.

---

## 11. iOS-Specific Changes Required

This is the actionable list. The Android code is 95% cross-platform already;
the changes below are all that's needed.

### 11.1 Remove Android-only expo-navigation-bar from App.tsx

`expo-navigation-bar` is Android-only. The current `App.tsx` calls:
```typescript
import * as NavigationBar from 'expo-navigation-bar';
// ...
NavigationBar.setStyle(t.dark ? 'light' : 'dark');
```

Wrap it with a platform guard:
```typescript
import { Platform } from 'react-native';
// in the useEffect:
if (Platform.OS === 'android') {
  try {
    const NavBar = require('expo-navigation-bar');
    NavBar.setStyle(t.dark ? 'light' : 'dark');
  } catch {}
}
```
Or simply delete the `expo-navigation-bar` import and the `useEffect` entirely —
iOS status bar is already handled by `<StatusBar style={...} />` from expo-status-bar.

### 11.2 Add iOS bundle identifier and permissions to app.json

The current `app.json` iOS section is minimal:
```json
"ios": {
  "supportsTablet": true
}
```

Expand it:
```json
"ios": {
  "supportsTablet": true,
  "bundleIdentifier": "com.nlula.myNoteApp",
  "infoPlist": {
    "NSMicrophoneUsageDescription": "myNote uses the microphone to record audio attachments.",
    "NSPhotoLibraryUsageDescription": "myNote needs access to your photo library to attach images.",
    "NSPhotoLibraryAddUsageDescription": "myNote needs to save exported files to your photo library."
  }
}
```

Bundle identifier should match what you register in App Store Connect. Using
`com.nlula.myNoteApp` mirrors the Android package name.

### 11.3 Add iOS EAS build profile to eas.json

Current `eas.json`:
```json
{
  "cli": { "version": ">= 20.0.0" },
  "build": {
    "preview": { "android": { "buildType": "apk" } },
    "production": { "android": { "buildType": "app-bundle" } }
  }
}
```

Add iOS profiles:
```json
{
  "cli": { "version": ">= 20.0.0" },
  "build": {
    "preview": {
      "android": { "buildType": "apk" },
      "ios": { "simulator": true }
    },
    "production": {
      "android": { "buildType": "app-bundle" },
      "ios": {}
    }
  }
}
```

`"simulator": true` builds an `.app` bundle for the iOS Simulator (no Apple
Developer account needed). For a real device / App Store, use `"ios": {}` with a
paid Apple Developer account and signing configured.

### 11.4 Add iOS camera / photo library permissions to app.json

The `expo-image-picker` plugin is already in `app.json` with permissions text:
```json
["expo-image-picker", {
  "photosPermission": "myNote needs access to your photo library to attach images and videos.",
  "cameraPermission": "myNote uses the camera to take photos and videos for note attachments."
}]
```
This generates the correct `NSPhotoLibraryUsageDescription` and `NSCameraUsageDescription`
entries in the iOS `Info.plist`. No additional changes needed.

### 11.5 Verify react-native-fit-image is installed

`ViewScreen.tsx` imports `FitImage from 'react-native-fit-image'` but this package
may not be listed in `package.json`. Run:
```bash
ls node_modules/react-native-fit-image
```
If absent, install it:
```bash
npm install react-native-fit-image
```
This is a pure JS + React Native package; it works on iOS without any native linking.

### 11.6 No changes needed to the following (already cross-platform)

- `notes.ts` — `expo-file-system` new API (`File`, `Directory`, `Paths.document`) works
  identically on iOS; the `<App Documents>/` path is the correct sandboxed location.
  `FileSystem.copyAsync` for attachments works on iOS with `file://` URIs directly.
- `lib/crypto.ts` — `require('react-native-quick-crypto')` try/catch works identically
  on iOS. In an iOS simulator/device build, quick-crypto is linked → fast. In Expo Go
  iOS, it's not linked → falls back to `pbkdf2Async` (slow but functional).
- `lib/github.ts` — pure fetch/JS, no native code
- `lib/merge.ts` — pure JS
- `lib/syncStatus.ts` / `syncProvider.ts` / `export.ts` — pure JS + Expo APIs
- `EditorScreen.tsx` — `KeyboardAvoidingView behavior` already branches on Platform.OS
- `EditorScreen.tsx` — `paddingBottom: Math.max(insets.bottom + 60, 80)` handles
  iOS home indicator (34px) and Android nav buttons (48px)
- `ViewScreen.tsx` / `SpaceScreen.tsx` / `TrashScreen.tsx` — in-window overlays
  (`StyleSheet.absoluteFill`) work the same on iOS; the Android nav-bar-colour-reset
  issue was Android-Modal-specific and does not occur on iOS
- `NoteListScreen.tsx` pull-to-sync PanResponder — works on iOS; note that iOS has
  its own scroll bounce, so the capture-phase trick (`onMoveShouldSetPanResponderCapture`)
  is still needed. Test carefully.
- Theme, navigation, all settings screens — fully cross-platform

---

## 12. Step-by-Step Setup on macOS

### Prerequisites
```bash
# Node 20+ required
node --version

# Install EAS CLI globally
npm install -g eas-cli

# Install Expo CLI
npm install -g expo@latest

# Xcode must be installed from the App Store (for iOS Simulator)
xcode-select --install
```

### Clone / copy the project
The existing Android project IS the iOS project — same codebase, same files.
Copy or git-clone `myNoteAppAndroid` to the Mac. If transferring via USB or
network, copy the whole folder EXCEPT `node_modules` and `android/` (these
regenerate).

### Install dependencies
```bash
cd myNoteAppAndroid
npm install
```

### Apply the iOS changes (sections 11.1–11.5 above)
Make the edits to `App.tsx`, `app.json`, `eas.json`. Run `npm install react-native-fit-image` if needed.
The `expo-image-picker` plugin and permissions are already in `app.json`; no changes needed there.

### Run in iOS Simulator (development)
```bash
npx expo run:ios
```
This will:
1. Run `expo prebuild` to generate the `ios/` Xcode project
2. Compile the native code
3. Launch the iOS Simulator
4. Start Metro bundler

If you just want the JS bundle without rebuilding native code, use:
```bash
npx expo start
```
Then press `i` to open in iOS Simulator (requires the simulator app already installed
from a prior `expo run:ios`).

### Build a signed IPA for TestFlight / App Store
```bash
eas build --profile production --platform ios
```
Requires:
1. Apple Developer account ($99/year)
2. Log in: `eas login` → account `nlula` (same EAS account as Android)
3. EAS will prompt to create or use existing provisioning profile + certificate

### Build for Simulator only (no Apple Developer account needed)
```bash
eas build --profile preview --platform ios
```
Downloads a `.app` file you can drag into the Simulator.

---

## 13. Testing Checklist

After getting the app running in the iOS Simulator, verify:

- [ ] App launches, dark theme shown (or system default)
- [ ] Can create a new note (tap `+`, type name, press return)
- [ ] Can edit a note, text is not hidden under home indicator
- [ ] Keyboard avoidance works (text field stays above keyboard)
- [ ] Pull-to-sync gesture works (pull down on note list → list slides, "Release to sync" appears)
- [ ] GitHub sync connects (Settings → Sync, enter a repo URL + PAT, tap Connect)
- [ ] GitHub sync actually syncs notes in both directions
- [ ] Markdown rendered correctly in ViewScreen (headings, code blocks, bold, etc.)
- [ ] Image attachments render in ViewScreen
- [ ] Audio player shows and plays in ViewScreen
- [ ] Video player shows and plays in ViewScreen
- [ ] Note history overlay appears when tapping dates in ViewScreen header
- [ ] Tap paperclip in editor → attachment sheet slides up with 3 options
- [ ] Attach photo from library → image inserted as `![name](/attachments/images/name)` at cursor
- [ ] Attach photo from camera → same as above
- [ ] Attach a PDF document → inserted as `[name](/attachments/documents/name)` at cursor
- [ ] Attach an audio file → inserted as `[name](/attachments/audio/name)` at cursor
- [ ] Attached file actually exists in the attachments directory (not zero bytes)
- [ ] Lock a note (tap lock icon on NoteListScreen, select note, enter password)
- [ ] Unlock locked note (tap edit icon, enter password)
- [ ] Unlock is fast in production build (~200ms), slow in Expo Go (~13s) — both correct
- [ ] Trash a note (long-press → dialog → Yes) — note disappears from list
- [ ] Restore from trash (Settings → Trash)
- [ ] Empty trash (Settings → Trash → "Empty Trash" → confirm)
- [ ] Space screen shows storage breakdown
- [ ] Double-tap category in Space → file list overlay opens
- [ ] Dark/light theme toggle works (Settings header sun/moon icon)
- [ ] History file: edit a note, close it, reopen history in ViewScreen → ONE new entry
- [ ] History file: do NOT see an entry for every keystroke (only one per session)
- [ ] After sync: history changes from PC appear merged in ViewScreen history

---

## 14. Known Android-Only Code (Safe to Ignore on iOS)

- `expo-navigation-bar` — the `setStyle` call in `App.tsx` (already guarded or to be removed)
- `android.predictiveBackGestureEnabled: false` in `app.json` → iOS ignores this
- Android `adaptiveIcon` in `app.json` → iOS uses `icon` field only
- Android `permissions` array in `app.json` → iOS uses `infoPlist.NS*UsageDescription`
- The `StyleSheet.absoluteFill` overlay pattern was adopted to fix an Android `Modal`
  bug (Modals on Android reset nav bar colour); on iOS, regular `Modal` components
  would also work, but the current overlay approach is fine and should be kept as-is
- URI normalisation in `copyAttachmentToStorage` (`content:/` → `content://`) is
  Android-only. On iOS, document picker always returns `file://` URIs so the
  normalisation code path is never triggered (harmless no-op)

---

## 15. File Format Compatibility With PC App

The PC myNote app (desktop) creates and reads the same files. The mobile app must
preserve this exact contract:

| Item | Format |
|---|---|
| Note files | UTF-8 `.md`, optional YAML frontmatter between `---` lines |
| Tags | `tags: [tag1, tag2]` bracket format OR `tags:\n  - tag1\n  - tag2` list format |
| Encryption | AES-256-GCM, PBKDF2-SHA256 100k iters, 16B salt + 12B IV + ciphertext+tag, base64 |
| History | `*.history.json` beside the `.md`, JSON array of `{at, via, act}` |
| Trash | `trashed_at: <unix_epoch_seconds>` in frontmatter + `trash` in tags |
| Attachment links | `![alt](/attachments/<category>/<file>)` (with or without leading `/`) |
| Deletions | `.deletions.json` with `deletions` array and optional `settings` object |
| Sync state | `github_state.json` at app documents root (NOT inside `notes/`) |

**Do not change these formats.** If you change them, notes will become unreadable on
the PC or Android app.

---

## 16. EAS Account Details

- EAS account: `nlula`
- EAS project ID: `fcb315aa-5913-4011-b3eb-1c3a76a4fbfb`
- Android package: `com.nlula.myNoteApp`
- iOS bundle ID (to use): `com.nlula.myNoteApp`
- App display name: `myNote`
- Expo slug: `myNoteApp`

Log in with `eas login` using the `nlula` account before running any `eas build` commands.
