import { diffArrays } from 'diff';

type Opcode = { tag: 'delete' | 'insert' | 'replace'; i1: number; i2: number; j1: number; j2: number };

/** Convert jsdiff's diffArrays output into difflib-style opcodes (only non-equal ranges). */
function changeOpcodes(base: string[], target: string[]): Opcode[] {
  const chunks = diffArrays(base, target);
  const ops: Opcode[] = [];
  let i = 0;
  let j = 0;
  let k = 0;
  while (k < chunks.length) {
    const c = chunks[k];
    if (!c.added && !c.removed) {
      i += c.count!;
      j += c.count!;
      k += 1;
      continue;
    }
    // Combine an adjacent removed+added (in either order) into one replace opcode.
    let removedCount = 0;
    let addedCount = 0;
    if (c.removed) removedCount = c.count!;
    if (c.added) addedCount = c.count!;
    const next = chunks[k + 1];
    let consumed = 1;
    if (next && ((c.removed && next.added) || (c.added && next.removed))) {
      if (next.removed) removedCount = next.count!;
      if (next.added) addedCount = next.count!;
      consumed = 2;
    }
    const i1 = i;
    const i2 = i + removedCount;
    const j1 = j;
    const j2 = j + addedCount;
    if (removedCount > 0 && addedCount > 0) {
      ops.push({ tag: 'replace', i1, i2, j1, j2 });
    } else if (removedCount > 0) {
      ops.push({ tag: 'delete', i1, i2, j1, j2 });
    } else {
      ops.push({ tag: 'insert', i1, i2, j1, j2 });
    }
    i = i2;
    j = j2;
    k += consumed;
  }
  return ops;
}

const stripEnd = (ln: string): string => ln.replace(/\s+$/, '');
const isBlankLine = (ln: string): boolean => ln.trim() === '';

function dropTrailingBlanks(lines: string[]): string[] {
  let b = lines.length;
  while (b > 0 && isBlankLine(lines[b - 1])) b -= 1;
  return lines.slice(0, b);
}

function dropLeadingBlanks(lines: string[]): string[] {
  let a = 0;
  while (a < lines.length && isBlankLine(lines[a])) a += 1;
  return lines.slice(a);
}

/**
 * Two blocks back to back with exactly one blank line between them. Only the
 * seam is normalised — blank lines the author put at the start of the first
 * block or the end of the second are theirs and are left alone, so merging
 * doesn't reflow the surrounding text.
 */
function joinBlocks(first: string[], second: string[]): string[] {
  if (!first.length) return second;
  if (!second.length) return first;
  const a = dropTrailingBlanks(first);
  const b = dropLeadingBlanks(second);
  if (!a.length) return b;
  if (!b.length) return a;
  const out = [...a];
  const last = out[out.length - 1];
  if (!last.endsWith('\n')) out[out.length - 1] = `${last}\n`;
  out.push('\n');
  return [...out, ...b];
}

/**
 * Append a block, ending it on a line boundary. A conflict marker written after
 * an unterminated line would otherwise be glued to the end of that text —
 * "...last words=======" — which no longer reads as a marker at all.
 */
function pushTerminated(out: string[], block: string[]): void {
  if (!block.length) return;
  out.push(...block.slice(0, -1));
  const last = block[block.length - 1];
  out.push(last.endsWith('\n') ? last : `${last}\n`);
}

/** When each side was last edited, in epoch seconds. Null when unknown. */
export type MergeTimes = { localAt?: number | null; remoteAt?: number | null };

/**
 * 3-way line merge, ported from myNote.py's _merge_texts.
 * Returns [mergedText, hadConflicts].
 *
 * `times` orders the case where both sides added text at the same place: the
 * older addition goes above the newer one, so a note reads as a timeline. With
 * no timestamps it falls back to the historical remote-then-local order.
 */
export function mergeTexts(
  base: string,
  local: string,
  remote: string,
  times: MergeTimes = {}
): [string, boolean] {
  const splitKeep = (s: string): string[] => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];

  // Normalise line endings before diffing: the PC historically saved CRLF while
  // this app saves LF, making otherwise-identical lines compare as different and
  // defeating both the diff and the insertion dedupe. Merged output is always LF.
  //
  // Also guarantee a trailing newline. The editor saves exactly what was typed,
  // so a note almost never ends with one — and then appending text *modifies*
  // the last line instead of inserting after it. Both sides end up replacing the
  // same line, so two independent appends collide as a conflict rather than
  // merging. Terminating every side first makes an append a true insertion.
  const norm = (s: string): string => {
    const lf = s.replace(/\r\n?/g, '\n');
    return lf.length > 0 && !lf.endsWith('\n') ? `${lf}\n` : lf;
  };

  const b = splitKeep(norm(base));
  const l = splitKeep(norm(local));
  const r = splitKeep(norm(remote));

  // Degenerate-base guard: when the base shares (almost) nothing with either
  // side — e.g. stale prevSha after a rename or repo wipe — both sides look
  // like one giant insertion and the merge below would concatenate the two
  // full documents into a doubled note. Refuse to merge in that case; the
  // caller's catch falls back to last-write-wins.
  const nonBlank = (arr: string[]) => new Set(arr.filter(ln => ln.trim()).map(ln => ln.replace(/\s+$/, '')));
  const bSet = nonBlank(b);
  const lSet = nonBlank(l);
  const rSet = nonBlank(r);
  if (bSet.size === 0 && lSet.size > 0 && rSet.size > 0) {
    throw new Error('merge base is empty');
  }
  if (bSet.size > 0 && lSet.size > 0 && rSet.size > 0) {
    const jaccard = (a: Set<string>, c: Set<string>) => {
      let inter = 0;
      for (const x of a) if (c.has(x)) inter += 1;
      return inter / (a.size + c.size - inter);
    };
    if (jaccard(bSet, lSet) < 0.2 && jaccard(bSet, rSet) < 0.2) {
      throw new Error('merge base unrelated to both sides');
    }
  }

  const lCh = changeOpcodes(b, l);
  const rCh = changeOpcodes(b, r);

  const out: string[] = [];
  let hadConflicts = false;
  let pos = 0;
  let li = 0;
  let ri = 0;

  while (true) {
    while (li < lCh.length && lCh[li].i2 <= pos) li += 1;
    while (ri < rCh.length && rCh[ri].i2 <= pos) ri += 1;

    const nextL = li < lCh.length ? lCh[li].i1 : null;
    const nextR = ri < rCh.length ? rCh[ri].i1 : null;

    if (nextL === null && nextR === null) {
      out.push(...b.slice(pos));
      break;
    }

    const candidates = [nextL, nextR].filter((x): x is number => x !== null);
    const nextEv = Math.min(...candidates);

    if (nextEv > pos) {
      out.push(...b.slice(pos, nextEv));
      pos = nextEv;
    }

    const lHere = li < lCh.length && lCh[li].i1 === pos ? lCh[li] : null;
    const rHere = ri < rCh.length && rCh[ri].i1 === pos ? rCh[ri] : null;

    if (lHere && rHere) {
      const lc = l.slice(lHere.j1, lHere.j2);
      const rc = r.slice(rHere.j1, rHere.j2);

      const sameArr = (a: string[], bArr: string[]) => a.length === bArr.length && a.every((v, idx) => v === bArr[idx]);

      if (sameArr(lc, rc) && lHere.i2 === rHere.i2) {
        out.push(...rc);
        pos = lHere.i2;
        li += 1;
        ri += 1;
      } else if (lHere.i1 === lHere.i2 && rHere.i1 === rHere.i2) {
        // Both sides added text at the same point, so neither overwrote the
        // other — keep both, oldest first, so the note reads chronologically.
        // Equal or unknown timestamps keep the original remote-then-local order.
        const { localAt, remoteAt } = times;
        const remoteFirst =
          typeof localAt === 'number' && typeof remoteAt === 'number'
            ? remoteAt <= localAt
            : true;
        const firstBlock = remoteFirst ? rc : lc;
        const secondBlock = remoteFirst ? lc : rc;

        // Drop lines the other side already contributed, comparing without
        // trailing whitespace so a CRLF variant isn't treated as different.
        // Blank lines are never deduped — they carry the paragraph structure,
        // and removing them would run separate paragraphs together.
        const seen = new Set(firstBlock.filter(ln => !isBlankLine(ln)).map(stripEnd));
        const extra = secondBlock.filter(ln => {
          if (isBlankLine(ln)) return true;
          const key = stripEnd(ln);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        out.push(...joinBlocks(firstBlock, extra));
        li += 1;
        ri += 1;
      } else {
        const conflictEnd = Math.max(lHere.i2, rHere.i2);
        hadConflicts = true;
        out.push('<<<<<<< local\n');
        pushTerminated(out, lc);
        out.push('=======\n');
        pushTerminated(out, rc);
        out.push('>>>>>>> github\n');
        pos = conflictEnd;
        while (li < lCh.length && lCh[li].i1 < conflictEnd) li += 1;
        while (ri < rCh.length && rCh[ri].i1 < conflictEnd) ri += 1;
      }
    } else if (lHere) {
      out.push(...l.slice(lHere.j1, lHere.j2));
      pos = lHere.i2;
      li += 1;
    } else if (rHere) {
      out.push(...r.slice(rHere.j1, rHere.j2));
      pos = rHere.i2;
      ri += 1;
    }
  }

  return [out.join(''), hadConflicts];
}
