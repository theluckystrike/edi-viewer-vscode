'use strict';
// The extension host with a stub vscode: activation, opening files, no network, Pro tries, the card1 panel, the text
// editor features (hover, diagnostics, format, minify), package.json rules, rating wiring.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const F = require('./fixtures');
const { loadExtension, openInViewer } = require('./support/vscode-stub');
const { buildHtml } = require('../src/html');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edi-ext-'));
const file = (name, text) => { const p = path.join(dir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const PO = file('in/po-1001.edi', F.x12(['850']));
const PO2 = file('in/po-1001-v2.edi', F.x12(['850'], { ctrl: 906 }).replace('PO1*1*10*EA', 'PO1*1*12*EA'));
const BAD = file('in/bad.edi', F.x12(['810']).replace(/SE\*\d+\*0001/, 'SE*3*0001'));
const ORD = file('in/orders.edifact', F.edifact(['ORDERS']));
const TXT = file('notes.txt', 'hello, this is text\n');
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'edi-empty-'));
fs.writeFileSync(path.join(EMPTY, 'readme.txt'), 'no EDI here');
test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(EMPTY, { recursive: true, force: true }); });

function trapNetwork() {
  const calls = [];
  const saved = { fetch: global.fetch, hr: http.request, hg: http.get, sr: https.request, sg: https.get, nc: net.connect, ncc: net.createConnection };
  global.fetch = async (u) => { calls.push(String(u)); throw new Error('network blocked in test'); };
  http.request = http.get = https.request = https.get = (...a) => { calls.push(String(a[0] && (a[0].href || a[0].host || a[0]))); throw new Error('network blocked in test'); };
  net.connect = net.createConnection = (...a) => { calls.push('net ' + JSON.stringify(a[0])); throw new Error('network blocked in test'); };
  return { calls, restore: () => { global.fetch = saved.fetch; http.request = saved.hr; http.get = saved.hg; https.request = saved.sr; https.get = saved.sg; net.connect = saved.nc; net.createConnection = saved.ncc; } };
}
const CARD1 = ['Pay by card (USD 19)', 'Get Zovo Pro with GitHub Sponsors', 'Pay with PayPal', 'Enter a key'];

test('activation and opening X12, EDIFACT and a text file make no network call and show no message', async () => {
  const nw = trapNetwork();
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    assert.ok(s.providers.has('ediViewer.tree'));
    for (const c of ['ediViewer.open', 'ediViewer.format', 'ediViewer.minify', 'ediViewer.exportJson', 'ediViewer.exportCsv', 'ediViewer.compare', 'ediViewer.validateFolder', 'ediViewer.getPro', 'ediViewer.payByCard', 'ediViewer.enterLicenseKey']) assert.ok(s.commands.has(c), c);
    const a = await openInViewer(s, PO);
    assert.strictEqual(a.posted[0].type, 'model');
    assert.strictEqual(a.posted[0].model.summary.transactions, 1);
    assert.strictEqual(a.posted[0].model.segs.t[0], 'ISA');
    assert.deepStrictEqual(a.posted[0].pro.tries, { export: 3, compare: 3, check: 3 });
    const b = await openInViewer(s, ORD);
    assert.strictEqual(b.posted[0].model.standard, 'edifact');
    const t = await openInViewer(s, TXT);
    assert.strictEqual(t.posted[0].type, 'error');
    assert.strictEqual(t.posted[0].code, 'NOT_EDI');
    assert.deepStrictEqual(nw.calls, []);
    assert.deepStrictEqual([s.log.info.length, s.log.warn.length, s.log.error.length], [0, 0, 0], 'no message on open');
    assert.deepStrictEqual(s.log.external, []);
  } finally { nw.restore(); s.restore(); }
});

test('export: Escape keeps the try; 3 exports use the 3 tries; the 4th click shows the card1 panel', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const v = await openInViewer(s, PO);
    s.ui.save.push(undefined);
    await v.send({ type: 'tool', tool: 'exportJson' });
    assert.strictEqual((s.state.get('ediViewer.proTrial') || {}).export, undefined, 'cancel uses no try');
    for (let i = 1; i <= 3; i++) {
      const out = path.join(dir, 'out', `po${i}.${i === 2 ? 'csv' : 'json'}`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      s.ui.save.push(s.vscode.Uri.file(out));
      await v.send({ type: 'tool', tool: i === 2 ? 'exportCsv' : 'exportJson' });
      assert.ok(fs.existsSync(out), `export ${i} written`);
      assert.strictEqual(s.state.get('ediViewer.proTrial').export, i);
    }
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'out', 'po1.json'), 'utf8')).standard, 'X12');
    assert.match(fs.readFileSync(path.join(dir, 'out', 'po2.csv'), 'utf8'), /^transaction,control,document,line,quantity/);
    assert.ok(s.log.status.some((t) => /free try 3 of 3/.test(t)));
    assert.strictEqual(s.log.info.length, 0, 'no panel while tries are left');
    s.ui.info.push(undefined); // Cancel
    await v.send({ type: 'tool', tool: 'exportJson' });
    assert.strictEqual(s.log.info.length, 1);
    const panel = s.log.info[0];
    assert.strictEqual(panel.text, 'Export EDI to JSON or CSV is part of Zovo Pro.');
    assert.strictEqual(panel.opts.modal, true);
    assert.deepStrictEqual(panel.buttons.slice(0, 4), CARD1);
    assert.match(panel.opts.detail, /You used the 3 free tries/);
    assert.match(panel.opts.detail, /Compare two EDI files/);
    assert.match(panel.opts.detail, /Everything that is free today stays free/);
    assert.strictEqual(s.log.saved.length, 3, 'nothing written after the tries');
    assert.deepStrictEqual(v.posted.filter((m) => m.type === 'pro').at(-1).pro.tries, { export: 0, compare: 3, check: 3 });
  } finally { s.restore(); }
});

test('panel buttons: Pay by card opens the card Worker with an install id; Sponsors opens tier 679878', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    s.state.set('ediViewer.proTrial', { compare: 3, check: 3 });
    const v = await openInViewer(s, PO);
    s.ui.info.push('Pay by card (USD 19)');
    await v.send({ type: 'tool', tool: 'compare' });
    assert.match(s.log.external.at(-1), /^https:\/\/license\.zovo\.one\/buy\/zovo-pro\?client_reference_id=[0-9a-f-]{36}$/);
    s.ui.info.push('Get Zovo Pro with GitHub Sponsors');
    await v.send({ type: 'tool', tool: 'check' });
    assert.strictEqual(s.log.external.at(-1), 'https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679878');
    assert.ok(!v.posted.some((m) => m.type === 'compare'));
  } finally { s.restore(); }
});

test('compare: cancel on the file or the option keeps the try; a comparison on screen uses one', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const v = await openInViewer(s, PO);
    s.ui.open.push(undefined);
    await v.send({ type: 'tool', tool: 'compare' });
    s.ui.open.push([s.vscode.Uri.file(PO2)]); s.ui.quick.push(undefined);
    await v.send({ type: 'tool', tool: 'compare' });
    assert.strictEqual((s.state.get('ediViewer.proTrial') || {}).compare, undefined);
    s.ui.open.push([s.vscode.Uri.file(PO2)]); s.ui.quick.push((items) => items[0]);
    await v.send({ type: 'tool', tool: 'compare' });
    const c = v.posted.find((m) => m.type === 'compare');
    assert.ok(c);
    assert.strictEqual(c.result.changed, 1);
    assert.ok(c.result.rows[0].diffs.some((d) => d.id === 'PO102'));
    assert.strictEqual(s.state.get('ediViewer.proTrial').compare, 1);
    await v.send({ type: 'saveCompare' });
    assert.match(s.log.opened.at(-1).getText(), /# EDI comparison: po-1001\.edi and po-1001-v2\.edi/);
  } finally { s.restore(); }
});

test('validate folder: a folder with no EDI file uses no try; a report (Markdown + CSV) uses one', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    s.vscode.workspace.workspaceFolders = [{ name: 'e', uri: s.vscode.Uri.file(EMPTY) }];
    await s.commands.get('ediViewer.validateFolder')();
    assert.match(s.log.info.at(-1).text, /No X12 or EDIFACT files found/);
    assert.strictEqual((s.state.get('ediViewer.proTrial') || {}).check, undefined);
    s.vscode.workspace.workspaceFolders = [{ name: 'w', uri: s.vscode.Uri.file(dir) }];
    await s.commands.get('ediViewer.validateFolder')();
    const docs = s.log.opened.map((d) => d.getText());
    const md = docs.find((t) => t.startsWith('# EDI folder check'));
    assert.match(md, /4 EDI files checked: 3 without problems, 1 with errors/);
    assert.match(md, /in\/bad\.edi \| X12 \| errors/);
    assert.ok(docs.some((t) => /^file,standard,status/.test(t)));
    assert.strictEqual(s.state.get('ediViewer.proTrial').check, 1);
  } finally { s.restore(); }
});

test('text editor: hover names, diagnostics from the worker, format and minify', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const doc = s.textDoc(fs.readFileSync(BAD, 'utf8'));
    const hp = s.hoverProviders[0];
    const at = doc._text.indexOf('INV-555') + 2;
    const hv = hp.provideHover(doc, doc.positionAt(at));
    assert.match(hv.contents.value.replace(/\\/g, ''), /\*\*BIG02\*\* · Invoice number \(mandatory\)/);
    assert.match(hv.contents.value, /Value: `INV-555`/);
    const n1 = hp.provideHover(doc, doc.positionAt(doc._text.indexOf('N1*RE') + 3));
    assert.match(n1.contents.value.replace(/\\/g, ''), /N101.*Value: `RE` = Party to receive the payment \(remit to\)/s);
    s.fire.open(doc);
    await new Promise((r) => setTimeout(r, 1500));
    const diags = s.log.diagnostics.get(String(doc.uri));
    assert.ok(diags && diags.some((d) => /SE01 says 3 segments/.test(d.message) && d.severity === 0), JSON.stringify(diags && diags.map((d) => d.message)));
    // format / minify on the active editor
    const flat = s.textDoc(F.x12(['850'], { nl: '' }));
    let edited = null;
    s.vscode.window.activeTextEditor = { document: flat, edit: async (fn) => { fn({ replace: (r, t) => { edited = t; } }); return true; } };
    await s.commands.get('ediViewer.format')();
    assert.strictEqual(edited.split('\n').filter(Boolean).length, 30);
    flat._text = edited;
    await s.commands.get('ediViewer.minify')();
    assert.ok(!edited.includes('\n'));
  } finally { s.restore(); }
});

test('webview HTML: nonce scripts, no remote origin, no connect-src', () => {
  const html = buildHtml({ cspSource: 'vscode-webview://x', scriptUri: 'vscode-webview://x/main.js', styleUri: 'vscode-webview://x/main.css', title: '<evil>"', nonce: 'abc' });
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-abc'/);
  assert.ok(!/https?:/.test(csp));
  assert.ok(!/connect-src/.test(csp));
  assert.ok(!/unsafe-inline/.test(csp));
  assert.ok(html.includes('&lt;evil&gt;&quot;'));
});

test('the webview script sets no innerHTML and loads nothing remote', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js));
  assert.ok(!/https?:\/\//.test(js));
  assert.ok(/e\.style\.setProperty/.test(js));
  assert.ok(!/setAttribute\(\s*['"]style/.test(js));
});

test('showProTools false hides the tools in the webview state', async () => {
  const s = loadExtension();
  try {
    s.config.showProTools = false;
    s.ext.activate(s.context);
    const v = await openInViewer(s, PO);
    assert.strictEqual(v.posted[0].pro.show, false);
  } finally { s.restore(); }
});

test('package.json: phrase-first name, engines ^1.90.0, option editor, Pro titles end in (Pro), card1 palette', () => {
  const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(p.displayName.startsWith('EDI Viewer & X12 Viewer, EDIFACT Viewer'));
  assert.ok(!/EDI Reader|EDI Support|EDI Tools|EDI-Cat/i.test(p.displayName));
  assert.ok(p.description.startsWith('EDI viewer, X12 viewer and EDIFACT viewer'));
  assert.ok(p.keywords.length <= 30 && p.keywords.slice(0, 4).join() === 'edi viewer,x12 viewer,edifact viewer,edi parser');
  assert.strictEqual(p.engines.vscode, '^1.90.0');
  assert.strictEqual(p.devDependencies['@types/vscode'], '~1.90.0');
  assert.strictEqual(p.contributes.customEditors[0].priority, 'option');
  const pro = p.contributes.commands.filter((c) => /exportJson|exportCsv|compare|validateFolder/.test(c.command));
  assert.strictEqual(pro.length, 4);
  for (const c of pro) assert.match(c.title, /\(Pro\)$/);
  assert.strictEqual(p.contributes.commands.filter((c) => c.category === 'Zovo Pro').length, 6);
  assert.ok(p.contributes.commands.some((c) => c.command === 'ediViewer.payByCard'));
  assert.ok(!p.dependencies, 'no runtime dependencies');
});

test('rating wiring: a rendered EDI file counts once; a text file is neither a success nor a failure', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const t = await openInViewer(s, TXT);
    assert.strictEqual(t.posted[0].code, 'NOT_EDI');
    const st0 = s.state.get('zovo.rating.v2');
    assert.ok(!st0 || !st0.lastError, 'not a failure');
    const v = await openInViewer(s, PO);
    await v.send({ type: 'rendered' });
    await v.send({ type: 'rendered' });
    const st = s.state.get('zovo.rating.v2');
    assert.ok(st && st.count === 1, `one good file counted once: ${JSON.stringify(st)}`);
  } finally { s.restore(); }
});
