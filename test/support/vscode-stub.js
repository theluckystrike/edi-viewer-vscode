'use strict';
// A small stand-in for the vscode module: enough for activation, the custom editor, the Pro tools and the license
// facade. Tests script the dialogs through `ui` and read what happened from `log`.
const fs = require('fs');
const path = require('path');
const Module = require('module');

function create() {
  const log = { info: [], warn: [], error: [], status: [], opened: [], external: [], commands: [], posted: [], saved: [], progress: [], diagnostics: new Map(), hovers: [] };
  const ui = { open: [], save: [], input: [], quick: [], info: [] };
  const commands = new Map();
  const providers = new Map();
  const state = new Map();
  const config = { showProTools: true, showSupportLinks: true, askForRating: true, validate: true, hover: true };
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range { constructor(a, b, c, d) { if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); } else { this.start = a; this.end = b; } } }
  class Selection extends Range {}
  class MarkdownString { constructor(v) { this.value = v || ''; } appendMarkdown(t) { this.value += t; return this; } }
  class Hover { constructor(contents, range) { this.contents = contents; this.range = range; } }
  class Diagnostic { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } }
  const listeners = { open: [], change: [], close: [] };
  const hoverProviders = [];
  class EventEmitter { constructor() { this.l = new Set(); this.event = (f) => { this.l.add(f); return { dispose: () => this.l.delete(f) }; }; } fire(v) { for (const f of this.l) f(v); } dispose() { this.l.clear(); } }
  class Uri {
    constructor(scheme, p) { this.scheme = scheme; this.path = p; this.fsPath = p; }
    static file(p) { return new Uri('file', path.resolve(p)); }
    static parse(s) { const u = new Uri(s.split(':')[0], s); u.str = s; return u; }
    static joinPath(u, ...parts) { return new Uri(u.scheme, path.join(u.path, ...parts)); }
    toString() { return this.str || `${this.scheme}://${this.path}`; }
    with() { return this; }
  }
  const nextOf = (q, dflt) => (q.length ? q.shift() : dflt);
  const msg = (kind) => async (text, ...rest) => {
    const opts = rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0]) ? rest.shift() : {};
    log[kind].push({ text, opts, buttons: rest.map((b) => (typeof b === 'string' ? b : b.title)) });
    return kind === 'info' ? nextOf(ui.info, undefined) : undefined;
  };
  const vscode = {
    version: '1.90.2',
    EventEmitter, Uri, Position, Range, Selection, MarkdownString, Hover, Diagnostic,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    languages: {
      createDiagnosticCollection: () => ({ set: (u, l) => log.diagnostics.set(String(u), l), delete: (u) => log.diagnostics.delete(String(u)), dispose() {} }),
      registerHoverProvider: (sel, p) => { hoverProviders.push(p); return { dispose() {} }; },
      setTextDocumentLanguage: async (d, l) => { d.languageId = l; return d; },
    },
    ViewColumn: { Beside: -2, Active: -1, One: 1 },
    ProgressLocation: { Notification: 15, Window: 10 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    env: { appName: 'Visual Studio Code', uriScheme: 'vscode', machineId: 'test', clipboard: { writeText: async (t) => { log.clipboard = t; } }, openExternal: async (u) => { log.external.push(String(u)); return true; }, asExternalUri: async (u) => u },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d), update: async () => {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      textDocuments: [],
      onDidOpenTextDocument: (f) => { listeners.open.push(f); return { dispose() {} }; },
      onDidChangeTextDocument: (f) => { listeners.change.push(f); return { dispose() {} }; },
      onDidCloseTextDocument: (f) => { listeners.close.push(f); return { dispose() {} }; },
      fs: {
        stat: async (u) => ({ size: fs.statSync(u.fsPath).size }),
        readFile: async (u) => fs.readFileSync(u.fsPath),
        writeFile: async (u, b) => { fs.writeFileSync(u.fsPath, b); log.saved.push(u.fsPath); },
      },
      openTextDocument: async (o) => ({ uri: Uri.parse('untitled:doc'), getText: () => (o && o.content) || '' , o }),
      isTrusted: true,
    },
    window: {
      state: { focused: true },
      onDidChangeWindowState: () => ({ dispose() {} }),
      registerCustomEditorProvider: (vt, p) => { providers.set(vt, p); return { dispose() {} }; },
      registerUriHandler: () => ({ dispose() {} }),
      showInformationMessage: msg('info'), showWarningMessage: msg('warn'), showErrorMessage: msg('error'),
      setStatusBarMessage: (t) => { log.status.push(t); return { dispose() {} }; },
      showOpenDialog: async () => nextOf(ui.open, undefined),
      showSaveDialog: async () => nextOf(ui.save, undefined),
      showInputBox: async (o) => { const v = nextOf(ui.input, undefined); if (v !== undefined && o && o.validateInput) { const e = o.validateInput(v); if (e) throw new Error(e); } return v; },
      showQuickPick: async (items) => { const f = nextOf(ui.quick, undefined); return typeof f === 'function' ? f(await items) : f; },
      showTextDocument: async (d) => { log.opened.push(d); return {}; },
      withProgress: async (o, fn) => { log.progress.push(o.title); return fn({ report: (r) => log.progress.push(r.message) }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }); },
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (id, ...a) => { log.commands.push([id, ...a]); if (commands.has(id)) return commands.get(id)(...a); return undefined; },
    },
    extensions: { all: [], getExtension: () => undefined, onDidChange: () => ({ dispose() {} }) },
    authentication: { getSession: async () => undefined, onDidChangeSessions: () => ({ dispose() {} }) },
    l10n: { t: (s) => s },
  };
  const secrets = new Map();
  const context = {
    subscriptions: [],
    extensionUri: Uri.file(path.join(__dirname, '..', '..')),
    extensionPath: path.join(__dirname, '..', '..'),
    extension: undefined,
    globalStorageUri: Uri.file(fs.mkdtempSync(path.join(require('os').tmpdir(), 'edi-gs-'))),
    globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => { state.set(k, v); }, keys: () => [...state.keys()], setKeysForSync() {} },
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); }, onDidChange: () => ({ dispose() {} }) },
  };
  /** A text document over a string, with offsetAt/positionAt like VS Code's. */
  function textDoc(text, languageId = 'edi', file = '/tmp/doc.edi') {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    const doc = {
      uri: Uri.file(file), languageId, version: 1, isClosed: false, get lineCount() { return starts.length; },
      _text: text,
      getText(r) { if (!r) return doc._text; return doc._text.slice(doc.offsetAt(r.start), doc.offsetAt(r.end)); },
      offsetAt(p) { const l = Math.max(0, Math.min(p.line, starts.length - 1)); return Math.min(doc._text.length, starts[l] + p.character); },
      positionAt(o) { o = Math.max(0, Math.min(o, doc._text.length)); let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= o) lo = mid; else hi = mid - 1; } return new Position(lo, o - starts[lo]); },
    };
    return doc;
  }
  const fire = { open: (d) => listeners.open.forEach((f) => f(d)), change: (d) => listeners.change.forEach((f) => f({ document: d })), close: (d) => listeners.close.forEach((f) => f(d)) };
  return { vscode, context, log, ui, commands, providers, state, config, textDoc, fire, hoverProviders };
}

/** Load src/extension.js with a fresh stub; returns the stub and the module. */
function loadExtension() {
  const stub = create();
  const orig = Module._load;
  Module._load = function (req, parent, isMain) { if (req === 'vscode') return stub.vscode; return orig.call(this, req, parent, isMain); };
  const root = path.join(__dirname, '..', '..', 'src');
  for (const k of Object.keys(require.cache)) if (k.startsWith(root)) delete require.cache[k];
  try { stub.ext = require(path.join(root, 'extension.js')); } finally { Module._load = orig; }
  // later requires of vscode (lazy ones) still need the stub
  Module._load = function (req, parent, isMain) { if (req === 'vscode') return stub.vscode; return orig.call(this, req, parent, isMain); };
  stub.restore = () => { Module._load = orig; };
  return stub;
}

/** Open a file in the custom editor and wait for the model or error message. */
async function openInViewer(stub, file, vt = 'ediViewer.tree') {
  const posted = [];
  let onMsg;
  const panel = {
    active: true, visible: true,
    webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u, postMessage: async (m) => { posted.push(m); stub.log.posted.push(m); return true; }, onDidReceiveMessage: (f) => { onMsg = f; return { dispose() {} }; } },
    onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }), reveal() {},
  };
  const p = stub.providers.get(vt);
  const doc = await p.openCustomDocument(stub.vscode.Uri.file(file));
  p.resolveCustomEditor(doc, panel);
  await onMsg({ type: 'ready' });
  return { panel, posted, send: (m) => onMsg(m) };
}

module.exports = { create, loadExtension, openInViewer };
