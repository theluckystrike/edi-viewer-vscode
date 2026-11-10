'use strict';
// Hostile input: no terminators, cut headers, colliding separators, binary garbage, huge counts, 1M segments in the
// worker, every prefix of a file, mutated files, HTML in values. Everything is built in memory; nothing large on disk.
const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/core/edi');
const T = require('../src/core/tools');
const F = require('./fixtures');
const { runJob } = require('../src/runner');

const safeParse = (t) => { try { return E.parse(t); } catch (e) { if (!(e instanceof E.EdiError)) throw e; return e; } };

test('not EDI: text, binary garbage, empty', () => {
  for (const t of ['hello world\n', '', '\x00\x01\x02\xff'.repeat(100), '{"a":1}', 'ISX*00']) {
    const r = safeParse(t);
    assert.ok(r instanceof E.EdiError && r.code === 'NOT_EDI', JSON.stringify(t.slice(0, 10)));
  }
  assert.match(safeParse('\x00\x01binary').message, /binary data/);
});

test('cut and broken headers give a message', () => {
  const full = F.x12(['850']);
  for (const n of [3, 4, 20, 60, 104]) {
    const r = safeParse(full.slice(0, n));
    assert.ok(r instanceof E.EdiError, `cut at ${n}`);
    assert.ok(['BAD_HEADER', 'NOT_EDI'].includes(r.code));
  }
  assert.match(safeParse('UNA:+.').message, /UNA service string advice is cut short/);
  assert.match(safeParse('ISA\n00').message, /no element separator/);
});

test('separators that collide are refused', () => {
  const isa = F.x12(['850']);
  const sameCompEl = isa.replace(/\*:~\n/, '**~\n');
  assert.strictEqual(safeParse(sameCompEl).code, 'BAD_SEPARATORS');
  const sameTerm = isa.slice(0, 105) + '*' + isa.slice(106);
  assert.strictEqual(safeParse(sameTerm).code, 'BAD_SEPARATORS');
  assert.strictEqual(safeParse("UNA:+.? +UNB+UNOC:3'").code, 'BAD_SEPARATORS');
  assert.strictEqual(safeParse("UNA:+.:  'UNB").code, 'BAD_SEPARATORS');
  assert.match(safeParse(sameCompEl).message, /Each separator must be a different character/);
});

test('no segment terminator after the ISA: one long segment and a warning, no hang', () => {
  const t = F.x12(['850']).replace(/~/g, '').replace(/\n/g, '');
  const head = t.slice(0, 105) + '~' + t.slice(105);
  const m = safeParse(head);
  assert.ok(!(m instanceof Error));
  assert.ok(m.problems.some((p) => /no segment terminator|not a segment ID|outside/.test(p.msg)));
});

test('huge counts and lengths: 2 billion segments claimed, BIN of 2 GB, IEA 4 billion', () => {
  const t = F.x12(['850']).replace(/SE\*\d+\*0001/, 'SE*2000000000*0001').replace('IEA*1*', 'IEA*4294967295*');
  const t0 = Date.now();
  const m = E.parse(t);
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(m.problems.some((p) => /SE01 says 2000000000/.test(p.msg)));
  assert.ok(m.problems.some((p) => /IEA01 says 4294967295/.test(p.msg)));
  // a BIN segment that claims 2 GB takes the rest of the file, with a note, and the missing trailers are reported
  const b = E.parse(F.x12(['850']).replace('CUR*BY*USD~', 'BIN*2000000000*xyz~'));
  assert.ok(b.notes.some((n) => /BIN segment says it holds 2,000,000,000 bytes/.test(n)));
  assert.ok(b.problems.some((p) => /has no SE trailer/.test(p.msg)));
  const u = F.edifact(['ORDERS']).replace(/UNT\+\d+\+1'/, "UNT+999999999999+1'");
  assert.ok(E.parse(u).problems.some((p) => /UNT01 says 999999999999/.test(p.msg)));
});

test('every prefix of an X12 and an EDIFACT file parses or gives a message', () => {
  for (const full of [F.x12(['856']), F.edifact(['DESADV'])]) {
    for (let n = 0; n <= full.length; n += 3) {
      const r = safeParse(full.slice(0, n));
      if (!(r instanceof Error)) assert.ok(Array.isArray(r.segs));
    }
  }
});

test('2,000 mutated files: each parses or gives a message, quickly', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const bases = [F.x12(['850', '837P', '835'], { nl: '' }), F.edifact(['INVOIC', 'DESADV'], { nl: '' })];
  const junk = '*~:^+\'?|\n\r\x00ISAUNB';
  const t0 = Date.now();
  for (let k = 0; k < 2000; k++) {
    const b = bases[k % 2].split('');
    const edits = 1 + rnd(12);
    for (let e = 0; e < edits; e++) {
      const at = rnd(b.length);
      const op = rnd(3);
      if (op === 0) b[at] = junk[rnd(junk.length)]; else if (op === 1) b.splice(at, 1 + rnd(20)); else b.splice(at, 0, junk[rnd(junk.length)]);
    }
    const r = safeParse(b.join(''));
    if (!(r instanceof Error)) { T.toJson(r, 'x'); T.toCsv(r); }
  }
  assert.ok(Date.now() - t0 < 20000, `took ${Date.now() - t0} ms`);
});

test('HTML in element values stays a value (no markup is made from it)', () => {
  const t = F.x12(['850']).replace('Zovo Stores', '<img src=x onerror=alert(1)>').replace('Blue mug, 300 ml', '<script>alert(2)</script>');
  const m = E.parse(t);
  const n1 = m.segs.find((s) => s.t === 'N1');
  assert.strictEqual(E.val(n1, 2, 0, m.sep), '<img src=x onerror=alert(1)>');
  const md = T.compareMarkdown(T.compareModels(E.parse(F.x12(['850'])), m), 'a', 'b');
  assert.ok(!/<img|<script/.test(md), 'markdown report escapes < and >');
});

test('1 million segments: the worker stops at 500,000 with a note and the host keeps going', { timeout: 120000 }, async () => {
  const text = F.bigX12(500000); // 1,000,006 segments, about 21 MB of text, in memory only
  const t0 = Date.now();
  const r = await runJob({ op: 'parse', text }, { idleMs: 60000 });
  assert.strictEqual(r.segs.t.length, 500000);
  assert.ok(r.notes.some((n) => /more than 500,000 segments/.test(n)));
  assert.ok(Date.now() - t0 < 60000, `took ${Date.now() - t0} ms`);
});

test('the watchdog stops a job that takes too long', async () => {
  const text = F.bigX12(200000);
  await assert.rejects(runJob({ op: 'parse', text }, { idleMs: 5 }), (e) => e.code === 'TIMEOUT');
});
