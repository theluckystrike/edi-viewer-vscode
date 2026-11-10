'use strict';
// Runs media/main.js in jsdom with a parsed model: the tree, element names, segments filter, problems, compare,
// styles through the CSSOM, hostile values as text, the error view. jsdom is not a dependency of this extension: the
// test uses JSDOM_PATH or the copy in a sibling product, and is skipped when there is none.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const E = require('../src/core/edi');
const T = require('../src/core/tools');
const F = require('./fixtures');
const { viewModel } = require('../src/worker');

const candidates = [process.env.JSDOM_PATH, path.join(__dirname, '..', 'node_modules', 'jsdom'), path.join(__dirname, '..', '..', 'docx-viewer-vscode', 'node_modules', 'jsdom')].filter(Boolean);
let JSDOM = null;
for (const c of candidates) { try { ({ JSDOM } = require(c)); break; } catch { /* next */ } }
const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
const model = (text) => viewModel(E.parse(text), text, Buffer.byteLength(text), 'utf-8');

function boot(text, name = 'po.edi') {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="app"></div><template id="zovo-footer"><div id="zovo-support">Rate</div></template></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const sent = [];
  dom.window.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(JSON.parse(JSON.stringify(m))) });
  dom.window.eval(script);
  const send = (m) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: m }));
  send({ type: 'model', model: model(text), name, pro: { show: true, licensed: false, tries: { export: 3, compare: 2, check: 3 } } });
  return { dom, doc: dom.window.document, sent, send };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('webview: tabs, tree with envelopes and loops, element names for a clicked segment', { skip: !JSDOM && 'jsdom not found' }, () => {
  const { doc, sent } = boot(F.x12(['850']));
  assert.deepStrictEqual(sent.map((m) => m.type), ['ready', 'rendered']);
  assert.deepStrictEqual([...doc.querySelectorAll('.tab')].map((t) => t.dataset.tab), ['tree', 'segments', 'problems']);
  assert.match(doc.querySelector('.desc').textContent, /^X12 00501 · 1 transaction set \(850\) · 30 segments$/);
  assert.strictEqual(doc.querySelector('.badge').textContent, 'No problems found');
  const labels = [...doc.querySelectorAll('.tr.node .nlabel')].map((e) => e.textContent);
  assert.ok(labels.includes('Interchange 000000905') && labels.includes('850 Purchase order') && labels.some((l) => /^PO1 line 1: 10 EA/.test(l)), labels.join(' | '));
  assert.strictEqual(doc.querySelector('.menu').hidden, true, 'the Export menu starts closed');
  assert.match(doc.querySelector('[data-tool=compare]').title, /2 free tries left/);
  assert.ok(doc.getElementById('zovo-support'), 'footer');
  // click the PO1 segment: element table with names and code meanings
  const po1 = [...doc.querySelectorAll('.tr.seg')].find((r) => r.querySelector('.tag').textContent === 'PO1');
  po1.click();
  const rows = [...doc.querySelectorAll('.els tbody tr')].map((r) => [...r.children].map((c) => c.textContent));
  assert.deepStrictEqual(rows[1], ['PO102', 'Quantity ordered', '10', '']);
  assert.deepStrictEqual(rows[2], ['PO103', 'Unit of measure', 'EA', 'Each']);
  assert.deepStrictEqual(rows[5], ['PO106', 'Product ID qualifier', 'UP', 'U.P.C. consumer package code']);
  // a click on an element row asks the host to select that element in the text
  doc.querySelectorAll('.els tbody tr')[1].click();
  const rv = sent.at(-1);
  assert.strictEqual(rv.type, 'reveal');
  const text = F.x12(['850']);
  assert.strictEqual(text.substr(rv.offset, rv.length), '10');
});

test('webview: EDIFACT composites show one row per component with names', { skip: !JSDOM && 'jsdom not found' }, () => {
  const { doc } = boot(F.edifact(['ORDERS']), 'o.edifact');
  const dtm = [...doc.querySelectorAll('.tr.seg')].find((r) => r.querySelector('.tag').textContent === 'DTM');
  dtm.click();
  const rows = [...doc.querySelectorAll('.els tbody tr')].map((r) => [...r.children].map((c) => c.textContent));
  assert.deepStrictEqual(rows[0].slice(0, 2), ['DTM01', 'Date/time/period *']);
  assert.deepStrictEqual(rows[1], ['DTM01-1', 'Date or time or period function code qualifier', '137', 'Document/message date/time']);
  assert.deepStrictEqual(rows[3], ['DTM01-3', 'Date or time or period format code', '102', 'CCYYMMDD']);
});

test('webview: segments filter, problems tab, styles through the CSSOM', { skip: !JSDOM && 'jsdom not found' }, async () => {
  const bad = F.x12(['850', '810']).replace(/SE\*\d+\*0002/, 'SE*3*0002');
  const { doc, dom } = boot(bad);
  assert.match(doc.querySelector('.badge').textContent, /1 error/);
  doc.querySelector('.tab[data-tab="segments"]').click();
  const head = doc.querySelector('.thead');
  assert.match(head.style.getPropertyValue('grid-template-columns'), /minmax/, 'columns set with style.setProperty');
  const f = doc.querySelector('.filter');
  f.value = 'po1';
  f.dispatchEvent(new dom.window.Event('input'));
  await sleep(250);
  assert.match(doc.querySelector('.tools .muted').textContent, /^2 of 48 segments$/);
  doc.querySelector('.tab[data-tab="problems"]').click();
  const p = [...doc.querySelectorAll('.tr.error')].map((r) => r.textContent);
  assert.ok(p.some((t) => /SE01 says 3 segments/.test(t)), p.join(' | '));
  // a click on a problem shows its segment in the tree
  doc.querySelector('.tr.error').click();
  assert.strictEqual(doc.querySelector('.tab.on').dataset.tab, 'tree');
  assert.strictEqual(doc.querySelector('#detail h2 .tag').textContent, 'SE');
});

test('webview: hostile values stay text; the compare tab; the error view', { skip: !JSDOM && 'jsdom not found' }, () => {
  const t = F.x12(['850']).replace('Zovo Stores', '<img src=x onerror=alert(1)>');
  const { doc, send } = boot(t);
  for (const n of doc.querySelectorAll('.tr.node')) n.click();
  const n1 = [...doc.querySelectorAll('.tr.seg')].find((r) => r.textContent.includes('<img'));
  assert.ok(n1, 'the value is shown as text');
  n1.click();
  assert.strictEqual(doc.querySelectorAll('#app img').length, 0);
  const a = E.parse(F.x12(['850'])), b = E.parse(F.x12(['850']).replace('PO1*1*10*EA', 'PO1*1*12*EA'));
  send({ type: 'compare', result: T.compareModels(a, b), nameA: 'a.edi', nameB: 'b.edi' });
  assert.strictEqual(doc.querySelector('.tab.on').dataset.tab, 'compare');
  assert.match(doc.querySelector('.tr.changed').textContent, /PO102 Quantity ordered: 10 → 12/);
  send({ type: 'error', message: 'This is not an EDI file: X12 starts with ISA, EDIFACT with UNA or UNB.', code: 'NOT_EDI' });
  assert.strictEqual(doc.querySelector('h2').textContent, 'Not an EDI file');
  assert.ok(doc.getElementById('zovo-support'));
});
