'use strict';
// Pro tool cores: JSON and CSV export, compare, folder report.
const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/core/edi');
const T = require('../src/core/tools');
const F = require('./fixtures');

const csvRows = (csv) => csv.trim().split('\r\n').map((l) => l.split(','));

test('JSON export: envelopes, transactions, loops and named elements', () => {
  const j = JSON.parse(T.toJson(E.parse(F.x12(['850', '837P'])), 'po.edi'));
  assert.strictEqual(j.standard, 'X12');
  const ich = j.content.find((x) => x.kind === 'interchange');
  assert.strictEqual(ich.control, '000000905');
  assert.strictEqual(ich.sender, 'ZOVOSENDER');
  const groups = ich.items.filter((x) => x.kind === 'group');
  assert.strictEqual(groups.length, 2);
  const tx = groups[0].items.find((x) => x.kind === 'transaction');
  assert.deepStrictEqual([tx.type, tx.control], ['850', '0001']);
  const beg = tx.items.find((x) => x.segment === 'BEG');
  assert.deepStrictEqual(beg.elements.BEG03, { value: 'PO-1001', name: 'Purchase order number' });
  assert.strictEqual(beg.elements.BEG02.meaning, 'Stand-alone order');
  const line = tx.items.find((x) => x.kind === 'loop' && /^PO1/.test(x.label));
  assert.ok(line.items.some((x) => x.segment === 'PID'));
  const clm = JSON.stringify(groups[1]);
  assert.match(clm, /"CLM05":\{"value":\["11","B","1"\]/);
  const ej = JSON.parse(T.toJson(E.parse(F.edifact(['ORDERS'])), 'o.edi'));
  assert.match(JSON.stringify(ej), /"NAD01":\{"value":"BY","name":"Party function code qualifier","meaning":"Buyer"\}/);
});

test('CSV export: line items of 850, 810, 856, ORDERS, INVOIC, DESADV', () => {
  const cases = { '850': [['850', '0001', 'PO-1001', '1', '10', 'EA', '4.25', '012345678905']], '810': [['810', '0001', 'INV-555', '1', '10', 'EA', '4.25', '012345678905']], '856': [['856', '0001', 'SHP-77', '', '10', 'EA', '', '012345678905']] };
  for (const [k, want] of Object.entries(cases)) {
    const r = T.toCsv(E.parse(F.x12([k])));
    assert.strictEqual(r.kind, 'lines', k);
    const rows = csvRows(r.csv);
    assert.strictEqual(rows[0][0], 'transaction');
    assert.strictEqual(rows.length, 3, k);
    assert.deepStrictEqual(rows[1].slice(0, 8), want[0], k);
  }
  for (const k of ['ORDERS', 'INVOIC', 'DESADV']) {
    const r = T.toCsv(E.parse(F.edifact([k])));
    assert.strictEqual(r.kind, 'lines', k);
    const rows = csvRows(r.csv);
    assert.strictEqual(rows.length, 3, k);
    assert.strictEqual(rows[1][7], '4000862141404', k);
  }
  assert.match(T.toCsv(E.parse(F.edifact(['ORDERS']))).csv, /ORDERS,1,PO-1001,1,10,PCE,4.25,4000862141404,GS1 global trade item number \(GTIN\),SA:ZV-100,Blue mug/);
});

test('CSV export: one row per segment for other types; formula cells are neutralised', () => {
  const r = T.toCsv(E.parse(F.x12(['837P'])));
  assert.strictEqual(r.kind, 'segments');
  const rows = csvRows(r.csv);
  assert.deepStrictEqual(rows[0].slice(0, 6), ['transaction', 'control', 'file line', 'segment', 'name', '01']);
  assert.ok(rows.some((x) => x[3] === 'CLM' && x[5] === 'PCN-1'));
  assert.strictEqual(T.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.strictEqual(T.csvCell('-12.5'), '-12.5');
  assert.strictEqual(T.csvCell('+cmd'), "'+cmd");
});

test('compare: same file, changed quantity, added and removed segments, control numbers ignored', () => {
  const a = E.parse(F.x12(['850']));
  const same = T.compareModels(a, E.parse(F.x12(['850'])));
  assert.deepStrictEqual([same.changed, same.added, same.removed], [0, 0, 0]);
  const btext = F.x12(['850'], { ctrl: 906 }).replace('PO1*1*10*EA', 'PO1*1*12*EA').replace('PID*F****Tea towel~\n', '').replace('CUR*BY*USD~', 'CUR*BY*USD~NTE*GEN*Rush~');
  const b = E.parse(btext);
  const r = T.compareModels(a, b, { ignoreControl: true });
  const ch = r.rows.filter((x) => x.kind === 'changed');
  assert.ok(ch.some((x) => x.tag === 'PO1' && x.diffs.some((d) => d.id === 'PO102' && d.a === '10' && d.b === '12' && d.name === 'Quantity ordered')), JSON.stringify(ch));
  assert.ok(r.rows.some((x) => x.kind === 'removed' && x.tag === 'PID'));
  assert.ok(r.rows.some((x) => x.kind === 'added' && x.tag === 'NTE'));
  assert.ok(!r.rows.some((x) => x.tag === 'ISA' || x.tag === 'IEA'), 'ISA13/IEA02 ignored');
  // SE01 changes because a segment count changed: that is a real change, not a control number
  const strict = T.compareModels(a, b, { ignoreControl: false });
  assert.ok(strict.rows.some((x) => x.tag === 'ISA' && x.diffs.some((d) => d.id === 'ISA13')));
  const md = T.compareMarkdown(r, 'a.edi', 'b.edi');
  assert.match(md, /^# EDI comparison of a\.edi and b\.edi/);
  assert.match(md, /PO102 \(Quantity ordered\): `10` → `12`/);
  assert.match(md, /Control numbers and envelope dates and times were ignored/);
  assert.match(T.compareModels(a, E.parse(F.edifact(['ORDERS']))).error, /One file is X12, the other EDIFACT/);
});

test('compare: large files fall back to a position compare and stay bounded', () => {
  const a = E.parse(F.bigX12(6000)), b = E.parse(F.bigX12(6000).replace('PO1*77*1*EA', 'PO1*77*2*EA'));
  const t0 = Date.now();
  const r = T.compareModels(a, b);
  assert.ok(Date.now() - t0 < 15000);
  assert.strictEqual(r.changed, 1);
});

test('folder report: rows, Markdown and CSV', () => {
  const good = T.reportRow('in/po.edi', E.parse(F.x12(['850'])));
  const bad = T.reportRow('in/bad.edi', E.parse(F.x12(['850']).replace(/SE\*\d+\*0001/, 'SE*1*0001')));
  const err = T.reportRow('in/cut.edi', null, 'The ISA header is cut short.');
  assert.deepStrictEqual([good.status, good.from, good.to, good.types], ['ok', 'ZOVOSENDER', 'ZOVORECEIVER', '850 x1']);
  assert.strictEqual(bad.status, 'errors');
  assert.match(bad.first, /^line \d+: SE01 says 1 segments/);
  const md = T.reportMarkdown([good, bad, err], '/data/edi', false);
  assert.match(md, /3 EDI files checked: 1 without problems, 1 with errors, 0 with warnings only, 1 not read/);
  const csv = T.reportCsv([good, bad]);
  assert.match(csv.split('\r\n')[0], /^file,standard,status,errors,warnings,interchanges,transactions,types,sender,receiver,first problem$/);
  const ed = T.reportRow('o.edifact', E.parse(F.edifact(['ORDERS'])));
  assert.deepStrictEqual([ed.standard, ed.from, ed.to], ['EDIFACT', '5412345000013', '5412345000020']);
});

test('EDI sniffing for the folder check', () => {
  assert.ok(T.looksEdi('ISA*00*'));
  assert.ok(T.looksEdi('﻿\n UNA:+.? \''));
  assert.ok(T.looksEdi('UNB+UNOC:3'));
  assert.ok(!T.looksEdi('ISAAC was here'.replace('ISAAC', 'ISA')) === false);
  assert.ok(!T.looksEdi('hello'));
  assert.ok(!T.looksEdi('UNBELIEVABLE'));
});
