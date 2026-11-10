'use strict';
// The EDI reader: every listed X12 transaction set and EDIFACT message, separators, the tree, the checks, hover
// lookups and format/minify. Synthetic files only (test/fixtures.js).
const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/core/edi');
const F = require('./fixtures');

const kidsOf = (m, id) => m.nodes.filter((n) => n.parent === id);
const errs = (m) => m.problems.map((p) => `${p.sev}: ${p.msg}`);

test('every listed X12 transaction set parses with no problem and gets its name', () => {
  const names = { '850': 'Purchase order', '855': 'Purchase order acknowledgment', '810': 'Invoice', '856': 'Ship notice/manifest', '997': 'Functional acknowledgment', '999': 'Implementation acknowledgment', '820': 'Payment order/remittance advice', '837P': '837P (professional)', '837I': '837I (institutional)', '835': 'Health care claim payment/advice', '270': 'Eligibility, coverage or benefit inquiry', '271': 'Eligibility, coverage or benefit information', '276': 'Health care claim status request', '277': 'Health care claim status response', '204': 'Motor carrier load tender', '214': 'Transportation carrier shipment status message', '940': 'Warehouse shipping order', '945': 'Warehouse shipping advice' };
  for (const [k, name] of Object.entries(names)) {
    const m = E.parse(F.x12([k]));
    assert.deepStrictEqual(errs(m), [], k);
    assert.strictEqual(m.transactions.length, 1, k);
    assert.ok(m.transactions[0].label.endsWith(name), `${k}: ${m.transactions[0].label}`);
    assert.strictEqual(m.summary.standard, 'X12');
  }
});

test('every listed EDIFACT message parses with no problem', () => {
  for (const k of Object.keys(F.EDIFACT)) {
    const m = E.parse(F.edifact([k]));
    assert.deepStrictEqual(errs(m), [], k);
    assert.strictEqual(m.transactions[0].code, k);
    assert.strictEqual(m.summary.standard, 'EDIFACT');
  }
  // without UNA: the default separators
  const m = E.parse(F.edifact(['ORDERS'], { una: false }));
  assert.deepStrictEqual(errs(m), []);
  assert.strictEqual(m.sep.element, '+');
});

test('X12 separators: from the ISA, with or without line breaks, CRLF, new line as terminator, 4010 without repetition', () => {
  const variants = [
    { nl: '' }, { nl: '\r\n' }, { el: '|', comp: '>', term: '!' }, { el: '^', comp: '\\', rep: '{', term: '~' }, { term: '\n', nl: '' }, { version: '00401', rep: 'U' },
  ];
  for (const o of variants) {
    const m = E.parse(F.x12(['850', '810'], o));
    assert.deepStrictEqual(errs(m), [], JSON.stringify(o));
    assert.strictEqual(m.sep.element, o.el || '*');
    assert.strictEqual(m.sep.segment, o.term || '~');
    assert.strictEqual(m.transactions.length, 2);
    const po1 = m.segs.find((s) => s.t === 'PO1');
    assert.strictEqual(E.val(po1, 7, 0, m.sep), '012345678905');
  }
  assert.strictEqual(E.parse(F.x12(['850'], { version: '00401', rep: 'U' })).sep.repetition, '');
  assert.strictEqual(E.parse(F.x12(['850'])).sep.repetition, '^');
});

test('EDIFACT UNA separators and the release character', () => {
  const t = "UNA:+.? '\nUNB+UNOC:3+SENDER:14+RECEIVER:14+261110:1200+77'\nUNH+1+ORDERS:D:96A:UN'\nBGM+220+PO?+1?'A+9'\nFTX+AAI+++Price 5?:3 and 10??'\nUNT+4+1'\nUNZ+1+77'\n";
  const m = E.parse(t);
  assert.deepStrictEqual(errs(m), []);
  const bgm = m.segs.find((s) => s.t === 'BGM');
  assert.strictEqual(E.val(bgm, 2, 0, m.sep), "PO+1'A");
  const ftx = m.segs.find((s) => s.t === 'FTX');
  assert.strictEqual(E.val(ftx, 4, 0, m.sep), 'Price 5:3 and 10?');
  // custom separators in UNA
  const c = F.edifact(['INVOIC'], { sep: { component: '!', element: '*', segment: '~', release: '\\' } });
  const m2 = E.parse(c);
  assert.deepStrictEqual(errs(m2), []);
  assert.deepStrictEqual([m2.sep.component, m2.sep.element, m2.sep.segment, m2.sep.release], ['!', '*', '~', '\\']);
});

test('tree: 837P HL hierarchy, NM1 loops, claim and service lines', () => {
  const m = E.parse(F.x12(['837P']));
  const tx = m.nodes.find((n) => n.kind === 'transaction');
  const top = kidsOf(m, tx.id).map((n) => n.label);
  assert.deepStrictEqual(top, ['NM1 Submitter · Zovo Billing', 'NM1 Receiver · Payer Clearing', 'HL Information source (HL 1)']);
  const hl1 = kidsOf(m, tx.id)[2];
  const hl2 = kidsOf(m, hl1.id).find((n) => n.kind === 'hl');
  assert.strictEqual(hl2.label, 'HL Subscriber (HL 2 under 1)');
  const clm = kidsOf(m, hl2.id).find((n) => n.tag === 'CLM');
  assert.ok(clm, 'claim loop under the subscriber');
  assert.deepStrictEqual(kidsOf(m, clm.id).map((n) => n.label), ['LX line 1', 'LX line 2']);
  // every segment belongs to a node, and node ranges hold their segments
  for (let i = 0; i < m.segs.length; i++) { const n = m.nodes[m.owner[i]]; assert.ok(n.id === 0 || (i >= n.first && i <= n.last), `segment ${i}`); }
});

test('tree: 856 shipment, order, pack, item levels; 850 party and line loops; DESADV packing levels', () => {
  const m = E.parse(F.x12(['856']));
  const hls = m.nodes.filter((n) => n.kind === 'hl');
  assert.deepStrictEqual(hls.map((n) => [n.label, m.nodes[n.parent].kind]), [['HL Shipment (HL 1)', 'transaction'], ['HL Order (HL 2 under 1)', 'hl'], ['HL Pack (HL 3 under 2)', 'hl'], ['HL Item (HL 4 under 3)', 'hl'], ['HL Item (HL 5 under 2)', 'hl']]);
  const p = E.parse(F.x12(['850']));
  const loops = p.nodes.filter((n) => n.kind === 'loop').map((n) => n.label);
  assert.deepStrictEqual(loops, ['N9 Mutually defined NOTE', 'N1 Buying party (purchaser) · Zovo Stores', 'N1 Ship to · Zovo DC', 'PO1 line 1: 10 EA · U.P.C. consumer package code 012345678905', 'PO1 line 2: 5 CA · U.P.C. consumer package code 012345678912']);
  // CTT and AMT come after the lines, in the transaction itself
  const ctt = p.segs.findIndex((s) => s.t === 'CTT');
  assert.strictEqual(p.nodes[p.owner[ctt]].kind, 'transaction');
  const d = E.parse(F.edifact(['DESADV']));
  const cps = d.nodes.filter((n) => n.tag === 'CPS');
  assert.strictEqual(cps.length, 3);
  assert.ok(d.nodes.some((n) => n.tag === 'LIN' && m.nodes && d.nodes[n.parent].tag === 'CPS'));
});

test('checks: counts and control numbers in every X12 envelope', () => {
  const good = F.x12(['850']);
  const cases = [
    [good.replace(/SE\*\d+\*0001/, 'SE*99*0001'), /SE01 says 99 segments; the transaction set has 26 \(from ST to SE\)/],
    [good.replace(/SE\*(\d+)\*0001/, 'SE*$1*0009'), /SE02 control number 0009 does not match ST 0001/],
    [good.replace('GE*1*1', 'GE*3*1'), /GE01 says 3 transaction sets; the group has 1/],
    [good.replace('GE*1*1', 'GE*1*8'), /GE02 control number 8 does not match GS 1/],
    [good.replace('IEA*1*000000905', 'IEA*2*000000905'), /IEA01 says 2 functional groups; the interchange has 1/],
    [good.replace('IEA*1*000000905', 'IEA*1*000000906'), /IEA02 control number 000000906 does not match ISA 000000905/],
    [good.replace('ZOVOSENDER     ', 'ZOVOSENDER'), /ISA06 \(Sender ID\) is 10 characters long; it must be 15/],
    [good.replace(/SE\*\d+\*0001~\n/, ''), /Transaction 850 has no SE trailer/],
    [good.replace(/IEA\*.*\n$/, ''), /Interchange 000000905 has no IEA trailer/],
    [good.replace('CUR*BY*USD', 'CUR*BY*USD~ZZZ*1'), /Segment ZZZ is not part of an 850 Purchase order/],
    [good.replace('BEG*00*SA*PO-1001', 'BEG*00*SA*'), /BEG03 \(Purchase order number\) is empty; it is mandatory/],
  ];
  for (const [t, re] of cases) {
    const m = E.parse(t);
    assert.ok(m.problems.some((p) => re.test(p.msg)), `${re}: ${errs(m).join(' | ')}`);
  }
  // duplicate control numbers in a group
  const dup = F.x12(['850', '850']).replace('ST*850*0002', 'ST*850*0001').replace(/SE\*(\d+)\*0002/, 'SE*$1*0001');
  assert.ok(E.parse(dup).problems.some((p) => /Control number 0001 is used by more than one transaction/.test(p.msg)));
});

test('checks: EDIFACT references and counts', () => {
  const good = F.edifact(['ORDERS']);
  const cases = [
    [good.replace(/UNT\+\d+\+1'/, "UNT+5+1'"), /UNT01 says 5 segments; the message has 26/],
    [good.replace(/UNT\+(\d+)\+1'/, "UNT+$1+2'"), /UNT02 control number 2 does not match UNH 1/],
    [good.replace("UNZ+1+1001'", "UNZ+4+1001'"), /UNZ01 says 4 messages; the interchange has 1/],
    [good.replace("UNZ+1+1001'", "UNZ+1+1002'"), /UNZ02 control number 1002 does not match UNB 1001/],
    [good.replace("NAD+SU+", "XYZ+1'NAD+SU+"), /Segment XYZ is not part of a ORDERS Purchase order/],
  ];
  for (const [t, re] of cases) {
    const m = E.parse(t);
    assert.ok(m.problems.some((p) => re.test(p.msg)), `${re}: ${errs(m).join(' | ')}`);
  }
});

test('names: element names and code meanings for X12 and EDIFACT', () => {
  const x = E.describe('x12', 'N1', 1, 'ST');
  assert.deepStrictEqual([x.id, x.name, x.meaning], ['N101', 'Entity identifier code', 'Ship to']);
  assert.strictEqual(E.describe('x12', 'BEG', 3, 'PO-1').name, 'Purchase order number');
  assert.strictEqual(E.describe('x12', 'CLP', 2, '4').meaning, 'Denied');
  assert.strictEqual(E.describe('x12', 'HL', 3, '22').meaning, 'Subscriber');
  const sep = { component: ':', element: '+', release: '?' };
  const d = E.describe('edifact', 'DTM', 1, '137:20261110:102', 3, sep);
  assert.deepStrictEqual([d.compName, d.meaning], ['Date or time or period format code', 'CCYYMMDD']);
  assert.strictEqual(E.describe('edifact', 'DTM', 1, '137:20261110:102', 1, sep).meaning, 'Document/message date/time');
  assert.strictEqual(E.describe('edifact', 'NAD', 1, 'BY', 0, sep).meaning, 'Buyer');
  assert.strictEqual(E.describe('edifact', 'BGM', 1, '380', 1, sep).meaning, 'Commercial invoice');
  assert.strictEqual(E.describe('x12', 'ZZZ', 0, '').name, '');
});

test('hover lookup: segment, element and component at an offset (X12 and EDIFACT, release character)', () => {
  const t = F.x12(['850']);
  const det = E.detect(t);
  const at = t.indexOf('PO-1001');
  const r = E.locate(t, det, at + 2);
  assert.deepStrictEqual([r.tag, r.index, r.value], ['BEG', 3, 'PO-1001']);
  const tagHit = E.locate(t, det, t.indexOf('BEG') + 1);
  assert.strictEqual(tagHit.index, 0);
  const u = "UNA:+.? 'UNB+UNOC:3+S:14+R:14+261110:1200+1'UNH+1+ORDERS:D:96A:UN'FTX+AAI+++a?+b:c'UNT+3+1'UNZ+1+1'";
  const d2 = E.detect(u);
  const f = E.locate(u, d2, u.indexOf('c\''));
  assert.deepStrictEqual([f.tag, f.index, f.component], ['FTX', 4, 2]);
  const g = E.locate(u, d2, u.indexOf('ORDERS') + 1);
  assert.deepStrictEqual([g.tag, g.index, g.component], ['UNH', 2, 0]);
});

test('format and minify keep every segment byte for byte', () => {
  for (const t of [F.x12(['850', '837P'], { nl: '' }), F.x12(['856'], { nl: '\r\n' }), F.edifact(['INVOIC'], { nl: '' })]) {
    const pretty = E.reformat(t, false);
    const flat = E.reformat(t, true);
    const segsOf = (s) => { const m = E.parse(s); return m.segs.map((x) => s.slice(x.o, x.o + x.n)); };
    assert.deepStrictEqual(segsOf(pretty), segsOf(t));
    assert.deepStrictEqual(segsOf(flat), segsOf(t));
    assert.ok(!/[\r\n]/.test(flat.trim()), 'minified is one line');
    assert.strictEqual(pretty.trim().split(/\r?\n/).length, segsOf(t).length);
    assert.strictEqual(E.reformat(pretty, true), flat);
  }
  // a file whose terminator is the new line itself: format leaves it alone
  const nlFile = F.x12(['850'], { term: '\n', nl: '' });
  assert.strictEqual(E.reformat(nlFile, false), nlFile);
});

test('X12 binary segment: BIN data may hold separators', () => {
  const t = F.x12(['850']).replace('CUR*BY*USD~', 'BIN*7*ab~*c:d~');
  const m = E.parse(t);
  const bin = m.segs.find((s) => s.t === 'BIN');
  assert.ok(bin);
  assert.strictEqual(m.segs[m.segs.indexOf(bin) + 1].t, 'REF');
});

test('functional group or transaction set without ISA still reads', () => {
  const t = 'GS*PO*A*B*20261110*1200*1*X*005010~ST*850*0001~BEG*00*SA*PO-9**20261110~SE*3*0001~GE*1*1~';
  const m = E.parse(t);
  assert.strictEqual(m.transactions.length, 1);
  assert.deepStrictEqual(errs(m), []);
});
