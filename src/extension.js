'use strict';
// EDI Viewer for X12 and EDIFACT: a read-only custom editor (tree, segment table, problems) plus text editor support
// (hover names, diagnostics, format and minify). The reader runs in a worker thread (runner.js) with a time and memory
// cap, so a hostile file cannot hang the extension host. No network. Pro tools (pro.js) ask only when used.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { runJob, checkFiles } = require('./runner');
const T = require('./core/tools');
const { buildHtml } = require('./html');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');
const text = require('./text');

const EXT_ID = 'zovo.zovo-edi-viewer';
const PREFIX = 'ediViewer';
const VIEW_TYPE = 'ediViewer.tree';
const MAX_REMOTE_BYTES = 64 * 1024 * 1024;
const MAX_CHECK_BYTES = 64 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', '.tox', '.cache', 'dist', 'out']);
const SAMPLES = { x12: 'sample-850-purchase-order.edi', claim: 'sample-837p-claim.x12', edifact: 'sample-orders.edifact' };

let rating = { success() {}, failure() {} };
let pro;
const viewers = new Set();
let active = null;

function setting(key, dflt) { try { return vscode.workspace.getConfiguration(PREFIX).get(key, dflt); } catch { return dflt; } }
const baseName = (uri) => path.posix.basename(uri.path) || uri.toString();

/** Read a file for a job: local files are read by the worker itself, other schemes through workspace.fs. */
async function jobSource(uri) {
  if (uri.scheme === 'file') return { file: uri.fsPath };
  const st = await vscode.workspace.fs.stat(uri);
  if (st.size > MAX_REMOTE_BYTES) throw Object.assign(new Error(`This file is ${Math.round(st.size / 1048576)} MB; files on a remote or virtual file system are read up to 64 MB.`), { code: 'TOO_LARGE' });
  const data = await vscode.workspace.fs.readFile(uri);
  return { buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
}
async function sourceFor(target) {
  if (target && target.doc) return { text: target.doc.getText() };
  return jobSource(target.uri);
}

class Viewer {
  constructor(uri, panel) { this.uri = uri; this.panel = panel; this.model = null; this.name = baseName(uri); this.counted = false; }
  post(msg) { return this.panel.webview.postMessage(msg).then(undefined, () => false); }
  async load() {
    try {
      const src = await jobSource(this.uri);
      const model = await runJob({ op: 'parse', ...src }, { transfer: src.buffer ? [src.buffer] : [] });
      await this.post({ type: 'model', model, name: this.name, pro: proState() });
      // The webview keeps the model; the host needs only the byte order mark flag (for reveal), so a large file is
      // not held twice while its viewer is open.
      this.model = { bom: !!model.bom };
    } catch (e) {
      const soft = ['NOT_EDI', 'TOO_LARGE', 'ENOENT'].includes(e.code);
      if (!soft) rating.failure();
      await this.post({ type: 'error', message: e.message || String(e), code: e.code || '', pro: proState() });
    }
  }
  async onMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return undefined;
    switch (msg.type) {
      case 'ready': return this.load();
      case 'rendered':
        if (!this.counted && this.model) { this.counted = true; rating.success(this.uri); }
        return undefined;
      case 'reveal': return reveal(this, Number(msg.offset), Number(msg.length));
      case 'openText': return vscode.commands.executeCommand('vscode.openWith', this.uri, 'default');
      case 'tool': return runTool(String(msg.tool), this);
      case 'copy': return vscode.env.clipboard.writeText(String(msg.text || '').slice(0, 20 << 20)).then(() => vscode.window.setStatusBarMessage(msg.what ? `Copied ${msg.what}.` : 'Copied.', 3000));
      case 'saveCompare': return saveCompare(this);
      case 'settings': return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXT_ID}`);
      default: return undefined;
    }
  }
}

/** Open the file as text beside the viewer and select a range (offsets into the decoded text). */
async function reveal(v, offset, length) {
  if (!Number.isSafeInteger(offset) || offset < 0) return;
  const doc = await vscode.workspace.openTextDocument(v.uri);
  const shift = v.model && v.model.bom ? 1 : 0;
  const a = doc.positionAt(Math.max(0, offset - shift)), b = doc.positionAt(Math.max(0, offset - shift + Math.max(0, length || 0)));
  const sel = new vscode.Selection(a, b);
  const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false, preview: true, selection: sel });
  if (ed && ed.revealRange) ed.revealRange(new vscode.Range(a, b), vscode.TextEditorRevealType ? vscode.TextEditorRevealType.InCenterIfOutsideViewport : undefined);
}

function proState() {
  return { show: setting('showProTools', true) !== false, licensed: !!(pro && pro.licensed), tries: pro ? pro.tries() : {} };
}

class Provider {
  constructor(context) { this.context = context; }
  openCustomDocument(uri) { return { uri, dispose() {} }; }
  resolveCustomEditor(document, panel) {
    const ctx = this.context;
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, enableCommandUris: commandUris(PREFIX), localResourceRoots: [media] };
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css')).toString(),
      title: baseName(document.uri),
      showSupportLinks: showLinks(vscode, PREFIX),
    });
    const v = new Viewer(document.uri, panel);
    viewers.add(v);
    if (panel.active) active = v;
    panel.onDidChangeViewState(() => { if (panel.active) active = v; else if (active === v && !panel.visible) active = null; });
    panel.onDidDispose(() => { viewers.delete(v); if (active === v) active = null; });
    panel.webview.onDidReceiveMessage((m) => v.onMessage(m).then(undefined, (e) => v.post({ type: 'notice', text: String((e && e.message) || e) })));
  }
}

// ---------------- Pro tools ----------------

/** The file a tool works on: a viewer, an EDI text editor, a URI from a menu, or a file the user picks. */
async function targetOf(from, title) {
  if (from instanceof Viewer) return { uri: from.uri, name: from.name, viewer: from };
  if (from && from.scheme) return { uri: from, name: baseName(from) };
  if (active) return { uri: active.uri, name: active.name, viewer: active };
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document && (ed.document.languageId === text.LANG || T.looksEdi(ed.document.getText(new vscode.Range(0, 0, 3, 0))))) return { uri: ed.document.uri, name: baseName(ed.document.uri), doc: ed.document };
  const pick = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: title, title: `${title}: pick an X12 or EDIFACT file` });
  if (!pick || !pick[0]) return null;
  return { uri: pick[0], name: baseName(pick[0]) };
}

async function runTool(tool, from) {
  if (tool === 'exportJson' || tool === 'exportCsv') return exportEdi(from, tool === 'exportCsv' ? 'csv' : 'json');
  if (tool === 'compare') return compare(from);
  if (tool === 'check') return validateFolder(from);
  return undefined;
}

async function exportEdi(from, kind) {
  if (!(await pro.allowed('export'))) return;
  const t = await targetOf(from, 'Export');
  if (!t) return;
  const base = t.uri.scheme === 'file' ? vscode.Uri.file(t.uri.fsPath.replace(/\.[^./\\]+$/, '') + `.${kind}`) : undefined;
  const target = await vscode.window.showSaveDialog({ defaultUri: base, filters: kind === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] }, title: `Export ${t.name} as ${kind === 'csv' ? 'CSV' : 'JSON'}` });
  if (!target) return; // cancelled: no try used
  let res;
  try { res = await runJob({ op: 'export', kind, name: t.name, ...(await sourceFor(t)) }, { idleMs: 30000 }); } catch (e) { vscode.window.showWarningMessage(`Export: ${e.message}`); return; }
  const body = kind === 'csv' ? res.csv : res.json;
  await vscode.workspace.fs.writeFile(target, Buffer.from(body, 'utf8'));
  // The saved message first: pro.produced shows the free-try count, and the newest status message is the one shown.
  if (kind === 'csv') vscode.window.setStatusBarMessage(`Saved ${res.rows} ${res.kind === 'lines' ? 'line items' : 'segments'} to ${baseName(target)}.`, 6000);
  await pro.produced('export');
  await vscode.window.showTextDocument(target, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  refreshPro();
}

async function compare(from) {
  if (!(await pro.allowed('compare'))) return;
  const a = await targetOf(from, 'Compare');
  if (!a) return;
  const pick = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Compare', title: `Compare ${a.name} with...`, defaultUri: a.uri.scheme === 'file' ? vscode.Uri.file(path.dirname(a.uri.fsPath)) : undefined });
  if (!pick || !pick[0]) return; // cancelled: no try used
  const how = await vscode.window.showQuickPick([
    { label: 'Ignore control numbers, dates and times', description: 'ISA, GS, ST, UNB, UNH ... envelope values', ignore: true },
    { label: 'Compare every element', ignore: false },
  ], { title: `Compare ${a.name} with ${baseName(pick[0])}` });
  if (!how) return; // cancelled: no try used
  let result;
  try { result = await runJob({ op: 'compare', a: await sourceFor(a), b: await jobSource(pick[0]), ignoreControl: how.ignore }, { idleMs: 60000 }); } catch (e) { vscode.window.showWarningMessage(`Compare: ${e.message}`); return; }
  if (result.error) { vscode.window.showWarningMessage(`Compare: ${result.error}`); return; }
  const nameB = baseName(pick[0]);
  const v = a.viewer;
  if (v) {
    v.lastCompare = { result, nameA: a.name, nameB };
    await v.post({ type: 'compare', result, nameA: a.name, nameB });
    v.panel.reveal();
  } else {
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: T.compareMarkdown(result, a.name, nameB) });
    await vscode.window.showTextDocument(doc, { preview: false });
  }
  await pro.produced('compare');
  refreshPro();
}

async function saveCompare(v) {
  if (!v.lastCompare) return;
  const { result, nameA, nameB } = v.lastCompare;
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: T.compareMarkdown(result, nameA, nameB) });
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

/** EDI files under a folder: the first bytes are sniffed (ISA, UNA, UNB); at most 20,000 entries looked at. */
async function listEdiFiles(root, cancelled) {
  const out = [];
  let seen = 0;
  const stack = [[root, 0]];
  const head = Buffer.alloc(512);
  while (stack.length && seen < 20000 && out.length < 5000 && !cancelled()) {
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((x, y) => (x.name < y.name ? -1 : 1));
    for (const e of entries) {
      if (++seen > 20000) break;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && depth < 24) stack.push([p, depth + 1]); continue; }
      if (!e.isFile()) continue;
      let fh;
      try {
        fh = await fs.promises.open(p, 'r');
        const st = await fh.stat();
        if (st.size < 20 || st.size > MAX_CHECK_BYTES) continue;
        const { bytesRead } = await fh.read(head, 0, 512, 0);
        if (T.looksEdi(head.subarray(0, bytesRead).toString('latin1'))) out.push(p);
      } catch { /* unreadable: skip */ } finally { if (fh) await fh.close().catch(() => {}); }
    }
  }
  return out.sort();
}

async function validateFolder(from) {
  if (!(await pro.allowed('check'))) return;
  const folders = (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file');
  let root;
  if (from && from.scheme === 'file' && !(from instanceof Viewer)) {
    try { root = fs.statSync(from.fsPath).isDirectory() ? from.fsPath : path.dirname(from.fsPath); } catch { root = undefined; }
  }
  if (!root && from instanceof Viewer && from.uri.scheme === 'file' && !folders.some((f) => from.uri.fsPath.startsWith(f.uri.fsPath + path.sep))) root = path.dirname(from.uri.fsPath);
  if (!root && folders.length === 1) root = folders[0].uri.fsPath;
  if (!root && folders.length > 1) {
    const p = await vscode.window.showQuickPick(folders.map((f) => ({ label: f.name, description: f.uri.fsPath, f })), { title: 'Validate the EDI files of which folder?' });
    if (!p) return;
    root = p.f.uri.fsPath;
  }
  if (!root) {
    const p = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: 'Validate this folder', title: 'Folder with EDI files' });
    if (!p || !p[0]) return; // cancelled: no try used
    root = p[0].fsPath;
  }
  const rows = [];
  let total = 0;
  const stopped = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Validating EDI files', cancellable: true }, async (progress, token) => {
    const cancelled = () => token.isCancellationRequested;
    const list = await listEdiFiles(root, cancelled);
    total = list.length;
    await checkFiles(list, {
      root, cancelled,
      onFile: (p) => {
        if (p.row) rows.push(p.row);
        else if (p.error) rows.push(T.reportRow(path.relative(root, p.file), null, p.error));
        if (p.index % 10 === 0) progress.report({ message: `${p.index + 1} of ${total} files` });
      },
    });
    return cancelled();
  });
  if (!rows.length) { vscode.window.showInformationMessage(`No X12 or EDIFACT files found in ${root}.`); return; } // no output: no try used
  const md = await vscode.workspace.openTextDocument({ language: 'markdown', content: T.reportMarkdown(rows, root, stopped) });
  await vscode.window.showTextDocument(md, { preview: false });
  const csv = await vscode.workspace.openTextDocument({ language: 'csv', content: T.reportCsv(rows) }).then(undefined, () => vscode.workspace.openTextDocument({ content: T.reportCsv(rows) }));
  await vscode.window.showTextDocument(csv, { preview: false, viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
  await pro.produced('check');
  refreshPro();
}

function refreshPro() { for (const v of viewers) v.post({ type: 'pro', pro: proState() }); }

// ---------------- activation ----------------

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'EDI Viewer' });
  registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  pro = createPro({ vscode, context });
  context.subscriptions.push(pro.onDidChange(() => refreshPro()));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, new Provider(context), { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } }));
  text.register({ vscode, context, runJob, prefix: PREFIX, enabled: (what) => setting(what === 'hover' ? 'hover' : 'validate', true) !== false });
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg(`${PREFIX}.open`, async (uri) => {
    let target = uri && uri.scheme ? uri : (vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri : null);
    if (!target || target.scheme === 'untitled') {
      const p = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Open', title: 'Open an X12 or EDIFACT file in EDI Viewer' });
      if (!p || !p[0]) return;
      target = p[0];
    }
    await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
  });
  reg(`${PREFIX}.openSample`, async (which) => {
    const name = SAMPLES[which] || SAMPLES.x12;
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(context.extensionUri, 'samples', name), VIEW_TYPE);
  });
  reg(`${PREFIX}.openSampleText`, async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(context.extensionUri, 'samples', SAMPLES.claim));
    await vscode.window.showTextDocument(doc, { preview: false });
  });
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#ediViewer.start`, false));
  reg(`${PREFIX}.exportJson`, (uri) => exportEdi(uri && uri.scheme ? uri : null, 'json'));
  reg(`${PREFIX}.exportCsv`, (uri) => exportEdi(uri && uri.scheme ? uri : null, 'csv'));
  reg(`${PREFIX}.compare`, (uri) => compare(uri && uri.scheme ? uri : null));
  reg(`${PREFIX}.validateFolder`, (uri) => validateFolder(uri && uri.scheme ? uri : active));
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${PREFIX}.showProTools`)) refreshPro(); }));
}

function deactivate() {}

module.exports = { activate, deactivate, listEdiFiles, SAMPLES };
