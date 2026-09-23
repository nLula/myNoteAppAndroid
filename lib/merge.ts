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

/**
 * 3-way line merge, ported from myNote.py's _merge_texts.
 * Returns [mergedText, hadConflicts].
 */
export function mergeTexts(base: string, local: string, remote: string): [string, boolean] {
  const splitKeep = (s: string): string[] => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];

  // Normalise line endings before diffing: the PC historically saved CRLF while
  // this app saves LF, making otherwise-identical lines compare as different and
  // defeating both the diff and the insertion dedupe. Merged output is always LF.
  const norm = (s: string): string => s.replace(/\r\n?/g, '\n');

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
        // Dedupe ignoring trailing whitespace so a CRLF/trailing-space variant
        // of the same line doesn't get inserted twice.
        const mergedIns = [...rc];
        const stripped = new Set(rc.map(ln => ln.replace(/\s+$/, '')));
        for (const line of lc) {
          const key = line.replace(/\s+$/, '');
          if (!stripped.has(key)) {
            mergedIns.push(line);
            stripped.add(key);
          }
        }
        out.push(...mergedIns);
        li += 1;
        ri += 1;
      } else {
        const conflictEnd = Math.max(lHere.i2, rHere.i2);
        hadConflicts = true;
        out.push('<<<<<<< local\n');
        out.push(...lc);
        out.push('=======\n');
        out.push(...rc);
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
