'use strict';
// Text editor support for EDI files: hover names, problems as diagnostics, "Format EDI" and "Minify EDI".
// Hover reads at most 128 KB around the mouse; validation runs in the worker (runner.js), debounced.
const E = require('./core/edi');

const LANG = 'edi';
const MAX_VALIDATE = 32 * 1024 * 1024;

function isEdiDoc(doc) { return doc && doc.languageId === LANG; }

/** Separators of a document from its first 4 KB, cached per document version. */
function detectDoc(vscode, doc, cache) {
  const key = doc.uri.toString();
  const c = cache.get(key);
  if (c && c.version === doc.version) return c.det;
  let det = null;
  try { det = E.detect(doc.getText(new vscode.Range(doc.positionAt(0), doc.positionAt(4096)))); } catch { det = null; }
  cache.set(key, { version: doc.version, det });
  return det;
}

function hoverMarkdown(vscode, det, r) {
  const d = E.describe(det.standard, r.tag, r.index, r.value, r.component, det.sep);
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = false;
  md.supportHtml = false;
  const esc = (s) => String(s).replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
  const code = (s) => String(s).replace(/[`\r\n]/g, ''); // inside a code span nothing needs escaping, only no backtick
  if (r.index === 0) {
    md.appendMarkdown(`\`${code(r.tag)}\`${d.name ? ` · ${esc(d.name)}` : ' · segment not in the dictionary'}`);
    if (d.desc) md.appendMarkdown(`\n\n${esc(d.desc)}`);
    return md;
  }
  md.appendMarkdown(`\`${code(d.id)}\`${d.name ? ` · ${esc(d.name)}` : ''}${d.compName ? ` · ${esc(d.compName)}` : ''}${d.required ? ' (mandatory)' : ''}`);
  let v = r.value;
  if (det.standard === 'edifact') v = E.unescape(E.splitRaw(r.value, det.sep.component, det.sep.release)[(r.component || 1) - 1] || '', det.sep.release);
  if (v !== '') md.appendMarkdown(`\n\nValue: \`${String(v).replace(/`/g, "'").slice(0, 200)}\`${d.meaning ? ` = ${esc(d.meaning)}` : ''}`);
  if (d.segName) md.appendMarkdown(`\n\nIn ${esc(r.tag)} · ${esc(d.segName)}`);
  return md;
}

function register({ vscode, context, runJob, prefix, enabled }) {
  const cache = new Map();
  const coll = vscode.languages.createDiagnosticCollection('edi');
  context.subscriptions.push(coll);
  const sel = [{ language: LANG }];

  context.subscriptions.push(vscode.languages.registerHoverProvider(sel, {
    provideHover(doc, pos) {
      if (!enabled('hover')) return undefined;
      const det = detectDoc(vscode, doc, cache);
      if (!det) return undefined;
      const off = doc.offsetAt(pos);
      const base = Math.max(0, off - 65536);
      const text = doc.getText(new vscode.Range(doc.positionAt(base), doc.positionAt(off + 65536)));
      const local = { ...det, start: Math.max(0, det.start - base), una: det.una && det.una.off >= base ? { off: det.una.off - base, len: 9 } : null };
      if (base > 0) local.start = 0;
      const r = E.locate(text, local, off - base);
      if (!r || !r.tag || !/^[A-Z][A-Z0-9]{1,2}$/.test(r.tag)) return undefined;
      const range = new vscode.Range(doc.positionAt(base + (r.index ? r.elStart : r.segStart)), doc.positionAt(base + (r.index ? r.elEnd : r.segStart + r.tag.length)));
      return new vscode.Hover(hoverMarkdown(vscode, det, r), range);
    },
  }));

  // diagnostics
  const timers = new Map();
  const runs = new Map();
  const SEV = (s) => (s === 'error' ? vscode.DiagnosticSeverity.Error : s === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
  async function validate(doc) {
    if (!isEdiDoc(doc) || !enabled('validate')) { coll.delete(doc.uri); return; }
    const text = doc.getText();
    if (text.length > MAX_VALIDATE) { coll.delete(doc.uri); return; }
    const key = doc.uri.toString();
    const ver = doc.version;
    runs.set(key, ver);
    let res;
    try { res = await runJob({ op: 'validate', text }, { idleMs: 20000 }); } catch (e) {
      if (runs.get(key) !== ver) return;
      if (e.code === 'NOT_EDI' || e.code === 'BAD_HEADER' || e.code === 'BAD_SEPARATORS') {
        coll.set(doc.uri, e.code === 'NOT_EDI' ? [] : [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 3), e.message, vscode.DiagnosticSeverity.Error)]);
      } else coll.delete(doc.uri);
      return;
    }
    if (runs.get(key) !== ver || doc.isClosed) return;
    const list = res.problems.map((p) => {
      const [o, n] = p.span;
      const d = new vscode.Diagnostic(new vscode.Range(doc.positionAt(o), doc.positionAt(o + Math.max(1, n))), p.msg, SEV(p.sev));
      d.source = 'EDI';
      return d;
    });
    coll.set(doc.uri, list);
  }
  const schedule = (doc, ms = 400) => {
    if (!isEdiDoc(doc)) return;
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); validate(doc).catch(() => {}); }, ms));
  };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((d) => schedule(d, 50)),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => { coll.delete(d.uri); cache.delete(d.uri.toString()); }),
  );
  for (const d of vscode.workspace.textDocuments || []) schedule(d, 50);

  async function reformatActive(oneLine) {
    const ed = vscode.window.activeTextEditor;
    if (!ed) { vscode.window.showInformationMessage('Open an EDI file in a text editor first.'); return false; }
    const doc = ed.document;
    let out;
    try { out = E.reformat(doc.getText(), oneLine); } catch (e) { vscode.window.showWarningMessage(`${oneLine ? 'Minify' : 'Format'} EDI: ${e.message}`); return false; }
    if (out === doc.getText()) { vscode.window.setStatusBarMessage(oneLine ? 'EDI: already on one line.' : 'EDI: already one segment per line.', 4000); return true; }
    const all = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    await ed.edit((b) => b.replace(all, out));
    if (doc.languageId !== LANG) { try { await vscode.languages.setTextDocumentLanguage(doc, LANG); } catch { /* keep */ } }
    return true;
  }
  context.subscriptions.push(
    vscode.commands.registerCommand(`${prefix}.format`, () => reformatActive(false)),
    vscode.commands.registerCommand(`${prefix}.minify`, () => reformatActive(true)),
  );
  return { validate, schedule, collection: coll };
}

module.exports = { register, hoverMarkdown, LANG };
