'use strict';
// Runs the EDI reader in a worker thread, so a hostile or huge file can never block or crash the extension host.
// The host (runner.js) kills this worker when it takes too long or uses too much memory.
const fs = require('fs');
const path = require('path');
const { parentPort } = require('worker_threads');
const E = require('./core/edi');
const T = require('./core/tools');

const MAX_FILE = 64 * 1024 * 1024; // the viewer reads files up to 64 MB
const MAX_CHECK = 64 * 1024 * 1024;

/** Bytes to text: UTF-8 when the bytes are valid UTF-8, else ISO 8859-1 (EDIFACT UNOC, older X12). */
function decode(buf) {
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' }; } catch { return { text: Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('latin1'), encoding: 'iso-8859-1' }; }
}

function readText(job, max = MAX_FILE) {
  if (typeof job.text === 'string') return { text: job.text, encoding: 'utf-8', size: Buffer.byteLength(job.text) };
  let buf;
  if (job.buffer) buf = new Uint8Array(job.buffer);
  else {
    const st = fs.statSync(job.file);
    if (!st.isFile()) throw Object.assign(new Error('This is not a file.'), { code: 'NOT_EDI' });
    if (st.size > max) throw Object.assign(new Error(`This file is ${Math.round(st.size / 1048576)} MB. The viewer reads EDI files up to ${Math.round(max / 1048576)} MB; open it as text instead.`), { code: 'TOO_LARGE' });
    buf = fs.readFileSync(job.file);
  }
  const d = decode(buf);
  return { ...d, size: buf.byteLength };
}

/** The model the webview gets: compact arrays, the text, and the dictionary of the standard. */
function viewModel(m, text, size, encoding) {
  const n = m.segs.length;
  const t = new Array(n), o = new Int32Array(n), len = new Int32Array(n), l = new Int32Array(n);
  for (let i = 0; i < n; i++) { const s = m.segs[i]; t[i] = s.t; o[i] = s.o; len[i] = s.n; l[i] = s.l; }
  const D = m.standard === 'x12' ? E.X : E.U;
  const sets = {};
  for (const [k, v] of Object.entries(D.SETS)) sets[k] = v.n;
  return {
    standard: m.standard, sep: m.sep, summary: m.summary, notes: m.notes, problems: m.problems, size, encoding, bom: text.charCodeAt(0) === 0xfeff,
    nodes: m.nodes.map((x) => ({ id: x.id, parent: x.parent, kind: x.kind, tag: x.tag, label: x.label, sub: x.sub || '', first: x.first, last: x.last, ctrl: x.ctrl, code: x.code, version: x.version, from: x.from, to: x.to, date: x.date })),
    owner: m.owner, segs: { t, o, n: len, l }, text,
    dict: { seg: D.SEG, codes: D.CODES, sets },
  };
}

async function run(job, progress) {
  if (job.op === 'parse') {
    const { text, size, encoding } = readText(job);
    const m = E.parse(text, job.limits);
    return viewModel(m, text, size, encoding);
  }
  if (job.op === 'validate') {
    const m = E.parse(job.text, { maxSegments: job.maxSegments || 200000, maxProblems: 1000 });
    return { problems: m.problems.map((p) => ({ ...p, span: p.el ? E.elementSpan(job.text, m.segs[p.seg], p.el, m.sep) : [m.segs[p.seg] ? m.segs[p.seg].o : 0, m.segs[p.seg] ? Math.max(1, m.segs[p.seg].t.length) : 1] })), notes: m.notes };
  }
  if (job.op === 'export') {
    const { text } = readText(job);
    const m = E.parse(text, job.limits);
    if (job.kind === 'csv') return T.toCsv(m);
    return { json: T.toJson(m, job.name || '') };
  }
  if (job.op === 'compare') {
    const a = E.parse(readText(job.a).text, { maxSegments: 200000 });
    const b = E.parse(readText(job.b).text, { maxSegments: 200000 });
    return T.compareModels(a, b, { ignoreControl: !!job.ignoreControl });
  }
  if (job.op === 'check') {
    for (let i = 0; i < job.files.length; i++) {
      const file = job.files[i];
      const rel = job.root ? path.relative(job.root, file) : file;
      let row;
      try {
        const { text } = readText({ file }, MAX_CHECK);
        row = T.reportRow(rel, E.parse(text, { maxSegments: 500000, maxProblems: 2000 }));
      } catch (e) { row = e.code === 'NOT_EDI' ? null : T.reportRow(rel, null, String(e.message || e).slice(0, 200)); }
      progress({ index: i, file, row });
    }
    return { done: true };
  }
  throw new Error(`unknown job ${job.op}`);
}

if (parentPort) parentPort.on('message', async (msg) => {
  try {
    const result = await run(msg.job, (p) => parentPort.postMessage({ id: msg.id, progress: p }));
    parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String((e && e.message) || e), code: e && e.code });
  }
});

module.exports = { decode, viewModel };
