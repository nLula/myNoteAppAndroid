import { marked } from 'marked';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat, type ImageRef as ManipulatedImage } from 'expo-image-manipulator';
import { readNoteBody, getNoteTitle, getTags, resolveAttachmentUri } from '../notes';

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  bmp: 'image/bmp', tiff: 'image/tiff',
};

// Images are held as references while the document is assembled and read one at
// a time, so the source cap only has to keep a single decode from blowing up.
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

// HTML is streamed to disk, so it embeds originals at full quality with no
// overall limit. PDF cannot: expo-print takes the whole document as one string,
// which crosses into a Java String at 2 bytes per character — a note with ~16 MB
// of photos became a 44 MB allocation and hit the heap ceiling. Downscaling to
// something appropriate for a 612pt-wide page keeps quality while cutting the
// payload by an order of magnitude.
const PDF_IMAGE_MAX_WIDTH = 1400;
const PDF_IMAGE_QUALITY = 0.8;
const PDF_RECOMPRESS_OVER = 300 * 1024; // smaller images aren't worth re-encoding
const PDF_MAX_BASE64_CHARS = 8 * 1024 * 1024;

// Stands in for an image dropped during PDF assembly; keeps the <img> tag valid.
const BLANK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

type ImageRef = { uri: string; mime: string; size: number; label: string };
type Segment = string | ImageRef;

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeFilename(name: string): string {
  return name.replace(/[/\\<>:"|?*]/g, '').trim().slice(0, 100) || 'Note';
}

/**
 * Render the note to a list of segments: literal HTML interleaved with image
 * references. Markdown is rendered with placeholder URLs so `marked` never has
 * to copy base64 payloads around; the data URIs are substituted afterwards.
 */
function buildSegments(
  title: string,
  bodyMd: string,
  tags: string[]
): { segments: Segment[]; skipped: string[] } {
  const skipped: string[] = [];
  const refs: ImageRef[] = [];

  const tokenized = bodyMd.replace(/!\[([^\]]*)\]\(\/?attachments\/([^)\n]+)\)/g, (whole, alt, relPath) => {
    const decoded = decodeURIComponent(relPath);
    const uri = resolveAttachmentUri(`attachments/${decoded}`);
    if (!uri) return whole;
    const label = decoded.split('/').pop() ?? decoded;
    try {
      const size = new File(uri).size;
      if (size > MAX_IMAGE_BYTES) {
        skipped.push(`${label} (${formatBytes(size)})`);
        return `*[image omitted — ${label}, ${formatBytes(size)}]*`;
      }
      const ext = decoded.split('.').pop()?.toLowerCase() ?? 'jpg';
      refs.push({ uri, mime: MIME[ext] ?? 'image/jpeg', size, label });
      return `![${alt}](x-embed-${refs.length - 1})`;
    } catch {
      return whole;
    }
  });

  const rendered = marked.parse(tokenized, { async: false }) as string;
  const tagsHtml = tags.length
    ? `<div class="tags">${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(' ')}</div>`
    : '';
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, system-ui, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; color: #1a1917; line-height: 1.6; }
  h1 { font-size: 26px; margin-bottom: 4px; }
  .tags { margin: 12px 0 24px; }
  .tag { display: inline-block; background: #edf5ed; color: #4a7a48; border-radius: 12px; padding: 3px 10px; font-size: 12px; margin-right: 6px; }
  pre { background: #f0ede9; padding: 12px; border-radius: 6px; overflow-x: auto; }
  code { background: #f0ede9; padding: 2px 5px; border-radius: 4px; }
  img { max-width: 100%; }
</style>
</head><body>
${tagsHtml}
${rendered}
</body></html>`;

  const segments: Segment[] = [];
  const token = /x-embed-(\d+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = token.exec(html)) !== null) {
    segments.push(html.slice(last, m.index));
    segments.push(refs[Number(m[1])]);
    last = m.index + m[0].length;
  }
  segments.push(html.slice(last));
  return { segments, skipped };
}

function dataUri(ref: ImageRef): string {
  return `data:${ref.mime};base64,${new File(ref.uri).base64Sync()}`;
}

/**
 * Data URI for the PDF path: anything sizeable is decoded, scaled down to page
 * width and re-encoded as JPEG, so the document stays small enough to hand to
 * expo-print. Falls back to the original bytes if the image can't be processed
 * (SVG, or any format the manipulator rejects).
 */
async function pdfDataUri(ref: ImageRef): Promise<string> {
  if (ref.size <= PDF_RECOMPRESS_OVER) return dataUri(ref);

  let rendered: ManipulatedImage | null = null;
  let scaled: ManipulatedImage | null = null;
  try {
    rendered = await ImageManipulator.manipulate(ref.uri).renderAsync();
    if (rendered.width > PDF_IMAGE_MAX_WIDTH) {
      scaled = await ImageManipulator.manipulate(rendered)
        .resize({ width: PDF_IMAGE_MAX_WIDTH })
        .renderAsync();
    }
    const { base64 } = await (scaled ?? rendered).saveAsync({
      compress: PDF_IMAGE_QUALITY,
      format: SaveFormat.JPEG,
      base64: true,
    });
    if (!base64) return dataUri(ref);
    return `data:image/jpeg;base64,${base64}`;
  } catch {
    return dataUri(ref);
  } finally {
    // Bitmaps sit on the Java heap — drop them now rather than waiting for GC,
    // otherwise processing many images in a row exhausts it.
    try { scaled?.release(); } catch {}
    try { rendered?.release(); } catch {}
  }
}

/** Write segments straight to disk so only one image is in memory at a time. */
function writeSegments(dest: File, segments: Segment[]): void {
  if (dest.exists) dest.delete();
  dest.create();
  const handle = dest.open(FileMode.WriteOnly);
  try {
    const enc = new TextEncoder();
    for (const seg of segments) {
      handle.writeBytes(enc.encode(typeof seg === 'string' ? seg : dataUri(seg)));
    }
  } finally {
    handle.close();
  }
}

/** Decode base64 in slices so the whole binary string never exists at once. */
function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s/g, '');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array(Math.floor(clean.length / 4) * 3 - pad);
  let o = 0;
  const CHUNK = 32768; // multiple of 4, so slices stay self-contained
  for (let i = 0; i < clean.length; i += CHUNK) {
    const bin = atob(clean.slice(i, i + CHUNK));
    for (let j = 0; j < bin.length; j++) out[o++] = bin.charCodeAt(j);
  }
  return o === out.length ? out : out.subarray(0, o);
}

// expo-print writes its PDF into its own cache folder, which sandboxed runtimes
// (Expo Go) do not grant this app read access to — moving that file then fails
// with "Missing 'READ' permission". Remember when that happens so subsequent
// exports ask for base64 up front instead of rendering the document twice.
let printOutputReadable: boolean | null = null;

export type ExportResult = { fileUri: string; filename: string; skipped: string[] };

export async function exportNoteAsPdf(name: string): Promise<ExportResult> {
  const content = await readNoteBody(name);
  const title = getNoteTitle(name);
  const { segments, skipped } = buildSegments(title, content, getTags(name));

  // expo-print needs the whole document as one string, so unlike the HTML export
  // this can't be streamed. Assemble in a single pass, downscaling as we go and
  // releasing each payload once appended, so peak memory is the document plus
  // one image rather than a second copy of every image.
  let html = '';
  let payload = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    segments[i] = '';
    if (typeof seg === 'string') {
      html += seg;
      continue;
    }
    const uri = await pdfDataUri(seg);
    if (payload + uri.length > PDF_MAX_BASE64_CHARS) {
      skipped.push(`${seg.label} (${formatBytes(seg.size)})`);
      html += BLANK_PNG;
      continue;
    }
    payload += uri.length;
    html += uri;
  }

  const filename = safeFilename(title) + '.pdf';
  const dest = new File(Paths.cache, filename);

  // Preferred path: printToFileAsync already wrote the PDF, so just move it into
  // place. Pulling it back as base64 would marshal the whole document across the
  // bridge and decode it in JS, which is what made large notes fail.
  if (printOutputReadable !== false) {
    const { uri } = await Print.printToFileAsync({ html });
    try {
      if (dest.exists) dest.delete();
      new File(uri).moveSync(dest);
      printOutputReadable = true;
      return { fileUri: dest.uri, filename, skipped };
    } catch {
      printOutputReadable = false;
    }
  }

  const { base64 } = await Print.printToFileAsync({ html, base64: true });
  if (dest.exists) dest.delete();
  dest.create();
  dest.write(base64ToBytes(base64!));
  return { fileUri: dest.uri, filename, skipped };
}

export async function exportNoteAsHtml(name: string): Promise<ExportResult> {
  const content = await readNoteBody(name);
  const title = getNoteTitle(name);
  const { segments, skipped } = buildSegments(title, content, getTags(name));

  const filename = safeFilename(title) + '.html';
  const dest = new File(Paths.cache, filename);
  writeSegments(dest, segments);
  return { fileUri: dest.uri, filename, skipped };
}

export async function shareExportedFile(fileUri: string): Promise<void> {
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(fileUri);
  }
}

/**
 * Copy an exported file into a folder the user picks (Downloads, Documents, …)
 * so it shows up in My Files. Returns the folder's display name, or null if the
 * picker was dismissed.
 */
export async function saveExportedFile(fileUri: string, filename: string): Promise<string | null> {
  const dir = await Directory.pickDirectoryAsync();
  if (!dir) return null;
  new File(fileUri).copySync(dir, { overwrite: true });
  return decodeURIComponent(dir.uri.split('/').pop() ?? dir.uri) + `/${filename}`;
}
