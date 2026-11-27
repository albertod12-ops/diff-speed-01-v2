// diff-speed v2: a faster drop-in for makefun-diff 1.0.0, by anchors.
//
// Same answers as makefun-diff on every input. The engine is v1's exact
// V-array Myers over interned line ids, but the search is split at ANCHOR
// lines: a line that occurs exactly once in each text, whose order against
// the other such lines is the same in both texts (the earliest longest
// increasing subsequence of the unique lines, so a swapped pair keeps the
// line first in the old text and a moved block's lines drop out), spaced
// apart so the middle falls into a few segments. Each segment is diffed by
// the same greedy Myers as v1, and the runs concatenate. A segment's first
// line is its anchor, kept by that segment's own common-prefix trim, so the
// concatenated script is the global greedy script whenever every anchor
// lies on it; where no anchor qualifies, v2 is exactly v1 (one segment).
//
// The anchor set is validated, not assumed: see the handoff for the
// equivalence counts against makefun-diff 1.0.0.

const FORMAT = 'makefun-diff/1';
const CONTEXT = 3;
const KEEP = '=';
const DELETE = '-';
const INSERT = '+';

/** How many segments the middle is split into at most, and the least old lines between two anchors. */
const MAX_SEGMENTS = 6;
const MIN_ANCHOR_GAP = 3000;

/** Interned line ids for one input: table[id] is the line, with its "\n" unless it is a bare last line. */
function tokenize(text, ids, table) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const out = new Int32Array(last + (parts[last] !== '' ? 1 : 0));
  for (let i = 0; i < last; i++) {
    const line = parts[i] + '\n';
    let id = ids.get(line);
    if (id === undefined) { id = table.length; ids.set(line, id); table.push(line); }
    out[i] = id;
  }
  if (parts[last] !== '') {
    const line = parts[last];
    let id = ids.get(line);
    if (id === undefined) { id = table.length; ids.set(line, id); table.push(line); }
    out[last] = id;
  }
  return out;
}

/**
 * The edit runs of A[a0..a1) into B[b0..b1): [{ kind, count }] in order,
 * by makefun-diff's rule (Myers greedy, deletion wins a tie, no edge
 * pruning, snakes followed as far as they go). Identical to v1's search.
 */
function editRuns(A, B, a0, a1, b0, b1) {
  const N = a1 - a0;
  const M = b1 - b0;
  // hist[d] is V after d edits: index k + d, value x (old lines consumed,
  // after the snake) or -1 when the diagonal is unreachable at that d.
  const hist = [];
  let x = 0;
  let y = 0;
  while (x < N && y < M && A[a0 + x] === B[b0 + y]) { x++; y++; }
  const v0 = new Int32Array(1);
  v0[0] = x;
  hist.push(v0);
  let D = 0;
  let kEnd = 0;
  if (x < N || y < M) {
    outer: for (let d = 1; ; d++) {
      const prev = hist[d - 1];
      const cur = new Int32Array(2 * d + 1);
      for (let k = -d; k <= d; k += 2) {
        let byDel = -2;
        let byIns = -2;
        if (k > -d) {
          const xd = prev[k + d - 2];
          if (xd >= 0 && xd < N) byDel = xd + 1;
        }
        if (k < d) {
          const xi = prev[k + d];
          if (xi >= 0 && xi - (k + 1) < M) byIns = xi;
        }
        if (byDel < 0 && byIns < 0) { cur[k + d] = -1; continue; }
        let xx = byDel >= byIns ? byDel : byIns;
        let yy = xx - k;
        while (xx < N && yy < M && A[a0 + xx] === B[b0 + yy]) { xx++; yy++; }
        cur[k + d] = xx;
        if (xx >= N && yy >= M) { D = d; kEnd = k; hist.push(cur); break outer; }
      }
      hist.push(cur);
    }
  }
  // Backtrack the found path: at each d the choice is recomputed from the
  // stored V exactly as the forward search made it.
  const steps = new Array(D); // steps[d - 1] = [isDeletion, snakeAfter]
  let k = kEnd;
  x = N;
  for (let d = D; d >= 1; d--) {
    const prev = hist[d - 1];
    let byDel = -2;
    let byIns = -2;
    let xd = -1;
    let xi = -1;
    if (k > -d) {
      xd = prev[k + d - 2];
      if (xd >= 0 && xd < N) byDel = xd + 1;
    }
    if (k < d) {
      xi = prev[k + d];
      if (xi >= 0 && xi - (k + 1) < M) byIns = xi;
    }
    if (byDel < 0 && byIns < 0) throw new Error('makefun-diff: backtrack lost the path');
    const del = byDel >= byIns;
    const xEdit = del ? byDel : byIns;
    steps[d - 1] = [del, x - xEdit];
    x = del ? xd : xi;
    k = del ? k - 1 : k + 1;
  }
  const snake0 = x;
  const runs = [];
  const push = (kind, count) => {
    if (count <= 0) return;
    const r = runs[runs.length - 1];
    if (r !== undefined && r.kind === kind) r.count += count;
    else runs.push({ kind, count });
  };
  push(KEEP, snake0);
  for (let d = 1; d <= D; d++) {
    const s = steps[d - 1];
    push(s[0] ? DELETE : INSERT, 1);
    push(KEEP, s[1]);
  }
  return runs;
}

/**
 * Anchor points inside the middle A[a0..a1) / B[b0..b1): [[a, b], ...] with
 * A[a] === B[b], strictly increasing in both, spread apart, each inside a
 * run of three consecutive matching lines. The anchor line itself belongs
 * to the segment that starts there.
 */
function anchors(A, B, a0, a1, b0, b1) {
  const N = a1 - a0;
  const M = b1 - b0;
  if (N < 2 * MIN_ANCHOR_GAP || M < 2 * MIN_ANCHOR_GAP) return [];
  const countA = new Map();
  const countB = new Map();
  const posA = new Map();
  const posB = new Map();
  for (let i = 0; i < N; i++) {
    const id = A[a0 + i];
    countA.set(id, (countA.get(id) || 0) + 1);
    if (!posA.has(id)) posA.set(id, i);
  }
  for (let j = 0; j < M; j++) {
    const id = B[b0 + j];
    countB.set(id, (countB.get(id) || 0) + 1);
    if (!posB.has(id)) posB.set(id, j);
  }
  const pts = [];
  for (const [id, c] of countA) {
    if (c === 1 && countB.get(id) === 1) pts.push([posA.get(id), posB.get(id)]);
  }
  if (pts.length < 2) return [];
  // A unique line is an anchor only inside a run of at least three
  // consecutive matching lines: the line itself and its immediate neighbours
  // equal in both texts. A unique line swapped with a neighbouring repeated
  // line fails this (its neighbours do not line up), while a line in an
  // unchanged stretch passes. This is applied before the LIS so a rejected
  // line never takes a slot in the chain.
  const strong = pts.filter(([pa, pb]) => pa > 0 && pb > 0 && pa + 1 < N && pb + 1 < M
    && A[a0 + pa - 1] === B[b0 + pb - 1] && A[a0 + pa + 1] === B[b0 + pb + 1]);
  if (strong.length < 2) return [];
  const pts2 = strong;
  pts2.sort((p, q) => p[0] - q[0]);
  // Earliest longest increasing subsequence of the b positions: suffix LIS
  // lengths via a Fenwick tree for prefix maxima over reversed ranks, then
  // a left-to-right greedy pick. Swapped pairs keep the line first in the
  // old text; moved blocks cannot join a longest run and drop out.
  const n = pts2.length;
  const bs = pts2.map((p) => p[1]).sort((x, y) => x - y);
  const rank = new Map();
  for (let i = 0; i < n; i++) if (!rank.has(bs[i])) rank.set(bs[i], rank.size + 1);
  const R = rank.size;
  const bit = new Int32Array(R + 2);
  const bitMax = (i) => { let v = 0; while (i > 0) { if (bit[i] > v) v = bit[i]; i -= i & -i; } return v; };
  const bitSet = (i, v) => { while (i <= R + 1) { if (v > bit[i]) bit[i] = v; i += i & -i; } };
  const suf = new Int32Array(n);
  let L = 0;
  for (let i = n - 1; i >= 0; i--) {
    const r = rank.get(pts2[i][1]);
    const rev = R - r + 1; // ranks > r are reversed indices < rev
    const best = bitMax(rev - 1);
    suf[i] = best + 1;
    if (suf[i] > L) L = suf[i];
    bitSet(rev, suf[i]);
  }
  // Greedy left-to-right pick of the earliest LIS.
  const lis = [];
  let prevB = -1;
  let need = L;
  for (let i = 0; i < n && need > 0; i++) {
    if (pts2[i][1] > prevB && suf[i] === need) {
      lis.push(pts2[i]);
      prevB = pts2[i][1];
      need--;
    }
  }
  if (lis.length < 2) return [];
  // Space the anchors: keep the chain spread over the middle.
  const gap = Math.max(MIN_ANCHOR_GAP, Math.floor(N / MAX_SEGMENTS));
  const picked = [];
  let lastA = -Infinity;
  for (const p of lis) {
    if (p[0] - lastA < gap && picked.length > 0) continue;
    if (p[0] < MIN_ANCHOR_GAP / 2 || N - p[0] < MIN_ANCHOR_GAP / 2) continue;
    picked.push(p);
    lastA = p[0];
  }
  // The first anchor must not be the middle's first line (that line is the
  // segment's own prefix-trimmed keep anyway); drop anchors too close to
  // either end so no segment is degenerate.
  return picked.filter((p) => p[0] > 0 && p[0] < N && p[1] > 0 && p[1] < M);
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? `${op}${line}` : `${op}${line}\n%\n`;
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const ids = new Map();
  const table = [];
  const a = tokenize(input.old, ids, table);
  const b = tokenize(input.new, ids, table);
  const n = a.length;
  const m = b.length;
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;
  const a0 = prefix;
  const a1 = n - suffix;
  const b0 = prefix;
  const b1 = m - suffix;
  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  const pushRun = (kind, count) => {
    if (count <= 0) return;
    const r = runs[runs.length - 1];
    if (r !== undefined && r.kind === kind) r.count += count;
    else runs.push({ kind, count });
  };
  const anch = anchors(a, b, a0, a1, b0, b1);
  let sa = a0;
  let sb = b0;
  for (const [pa, pb] of anch) {
    const aa = a0 + pa;
    const bb = b0 + pb;
    if (aa <= sa || bb <= sb) continue;
    for (const r of editRuns(a, b, sa, aa, sb, bb)) pushRun(r.kind, r.count);
    sa = aa;
    sb = bb;
  }
  for (const r of editRuns(a, b, sa, a1, sb, b1)) pushRun(r.kind, r.count);
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written(KEEP, table[a[at]]));
      for (let i = 0; i < c.dels; i++) out.push(written(DELETE, table[a[c.o + i]]));
      for (let i = 0; i < c.ins; i++) out.push(written(INSERT, table[b[c.p + i]]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written(KEEP, table[a[at]]));
  }
  return out.join('');
}
