'use strict';
// Pro tool cores, pure functions on parsed models: JSON and CSV export, segment-by-segment compare, folder report.
const E = require('./edi');

const pad2 = (k) => String(k).padStart(2, '0');
const elemId = (std, tag, k) => (std === 'x12' ? `${tag}${pad2(k)}` : `${tag}${pad2(k)}`);

/** Values of a segment: components split, released characters removed. */
function values(seg, sep, std) {
  return seg.e.map((raw) => {
    const parts = E.splitRaw(raw, sep.component, sep.release);
    if (std === 'x12' && sep.repetition && raw.indexOf(sep.repetition) >= 0 && seg.t !== 'ISA') return raw.split(sep.repetition).map((r) => r.split(sep.component));
    return parts.length > 1 ? parts.map((p) => E.unescape(p, sep.release)) : E.unescape(raw, sep.release);
  });
}

function segJson(m, i) {
  const s = m.segs[i];
  const d = (m.standard === 'x12' ? E.X : E.U).SEG[s.t];
  const vals = values(s, m.sep, m.standard);
  const elements = {};
  vals.forEach((v, k) => {
    if (v === '' || (Array.isArray(v) && v.every((x) => x === ''))) return;
    const ed = d && d.e && d.e[k];
    const meaning = ed && ed[2] && typeof v === 'string' ? E.codeMeaning(m.standard, ed[2], v) : undefined;
    elements[elemId(m.standard, s.t, k + 1)] = ed ? { value: v, name: ed[0], ...(meaning ? { meaning } : {}) } : { value: v };
  });
  return { segment: s.t, ...(d ? { name: d.n } : {}), line: s.l + 1, elements };
}

/** JSON tree per transaction: envelopes, then loops and segments in file order. */
function toJson(m, name) {
  const kids = new Map();
  for (const n of m.nodes) if (n.parent >= 0) { if (!kids.has(n.parent)) kids.set(n.parent, []); kids.get(n.parent).push(n); }
  const segsOf = new Map();
  for (let i = 0; i < m.segs.length; i++) { const o = m.owner[i]; if (!segsOf.has(o)) segsOf.set(o, []); segsOf.get(o).push(i); }
  const build = (node) => {
    const items = [];
    const ns = kids.get(node.id) || [], ss = segsOf.get(node.id) || [];
    let a = 0, b = 0;
    while (a < ns.length || b < ss.length) {
      if (b >= ss.length || (a < ns.length && ns[a].first <= ss[b])) { items.push(build(ns[a])); a++; }
      else { if (!m.segs[ss[b]].una) items.push(segJson(m, ss[b])); b++; }
    }
    const head = { kind: node.kind, label: node.label };
    if (node.kind === 'interchange') Object.assign(head, { control: node.ctrl, sender: node.from, receiver: node.to, date: node.date });
    if (node.kind === 'group') Object.assign(head, { control: node.ctrl });
    if (node.kind === 'transaction') Object.assign(head, { type: node.code, control: node.ctrl, version: node.version });
    return { ...head, items };
  };
  const root = build(m.nodes[0]);
  return JSON.stringify({ file: name, standard: m.summary.standard, version: m.summary.version, separators: m.sep, summary: m.summary, problems: m.problems.slice(0, 1000).map((p) => ({ severity: p.sev, line: m.segs[p.seg] ? m.segs[p.seg].l + 1 : 0, segment: m.segs[p.seg] ? m.segs[p.seg].t : '', message: p.msg })), content: root.items }, null, 2) + '\n';
}

function csvCell(v) {
  const s = String(v === undefined || v === null ? '' : v);
  // a leading = + - @ would run as a formula in a spreadsheet: prefix it with an apostrophe
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
const csvRow = (r) => r.map(csvCell).join(',');

const LINE_ITEM_SETS = { '850': 'PO1', '855': 'PO1', '810': 'IT1', '856': 'LIN', ORDERS: 'LIN', ORDRSP: 'LIN', INVOIC: 'LIN', DESADV: 'LIN' };

/**
 * CSV: line items when every transaction is a line item kind (850, 810, 856, ORDERS, INVOIC, DESADV ...),
 * otherwise one row per segment with its elements. Returns { kind: 'lines'|'segments', csv, rows }.
 */
function toCsv(m) {
  const txs = m.transactions;
  const sep = m.sep;
  if (txs.length && txs.every((t) => LINE_ITEM_SETS[t.code])) {
    const rows = [];
    const head = ['transaction', 'control', 'document', 'line', 'quantity', 'unit', 'unit price', 'product id', 'product id type', 'other ids', 'description', 'file line'];
    for (const t of txs) {
      const starter = LINE_ITEM_SETS[t.code];
      let doc = '';
      let cur = null;
      const flush = () => { if (cur) rows.push([t.code, t.ctrl, doc, cur.line, cur.qty, cur.unit, cur.price, cur.id, cur.idType, cur.other.join(' '), cur.desc, cur.fileLine]); cur = null; };
      for (let i = t.first; i <= t.last; i++) {
        const s = m.segs[i];
        const v = (k, c) => E.val(s, k, c, sep);
        if (m.standard === 'x12') {
          if (s.t === 'BEG') doc = v(3); else if (s.t === 'BIG') doc = v(2); else if (s.t === 'BSN') doc = v(2); else if (s.t === 'BAK') doc = v(3);
          if (s.t === starter) {
            flush();
            if (starter === 'LIN') cur = { line: v(1), qty: '', unit: '', price: '', id: v(3), idType: E.codeMeaning('x12', 'prodQual', v(2)) || v(2), other: [], desc: '', fileLine: s.l + 1 };
            else cur = { line: v(1), qty: v(2), unit: v(3), price: v(4), id: v(7), idType: E.codeMeaning('x12', 'prodQual', v(6)) || v(6), other: [], desc: '', fileLine: s.l + 1 };
            for (let k = starter === 'LIN' ? 4 : 8; k + 1 <= s.e.length; k += 2) if (v(k + 1)) cur.other.push(`${v(k)}:${v(k + 1)}`);
          } else if (cur && s.t === 'SN1') { cur.qty = v(2); cur.unit = v(3); }
          else if (cur && s.t === 'PID' && !cur.desc) cur.desc = v(5);
          else if (cur && s.t === 'ACK') cur.other.push(`ACK:${v(1)}`);
          else if (cur && (s.t === 'HL' || s.t === 'CTT' || s.t === 'SE' || s.t === 'TDS')) flush();
        } else {
          if (s.t === 'BGM') doc = v(2, 1);
          if (s.t === 'LIN') { flush(); cur = { line: v(1), qty: '', unit: '', price: '', id: v(3, 1), idType: E.codeMeaning('edifact', 'itemType', v(3, 2)) || v(3, 2), other: [], desc: '', fileLine: s.l + 1 }; }
          else if (cur && s.t === 'QTY' && !cur.qty) { cur.qty = v(1, 2); cur.unit = v(1, 3); }
          else if (cur && s.t === 'PRI' && !cur.price) cur.price = v(1, 2);
          else if (cur && s.t === 'PIA') cur.other.push(`${v(2, 2)}:${v(2, 1)}`);
          else if (cur && s.t === 'IMD' && !cur.desc) cur.desc = v(3, 4);
          else if (cur && (s.t === 'UNS' || s.t === 'UNT' || s.t === 'CPS' || s.t === 'CNT')) flush();
        }
      }
      flush();
    }
    return { kind: 'lines', rows: rows.length, csv: [csvRow(head), ...rows.map(csvRow)].join('\r\n') + '\r\n' };
  }
  let width = 0;
  for (const s of m.segs) width = Math.max(width, s.e.length);
  width = Math.min(width, 60);
  const head = ['transaction', 'control', 'file line', 'segment', 'name', ...Array.from({ length: width }, (_, k) => pad2(k + 1))];
  const rows = [];
  const txOf = new Map();
  for (const t of m.transactions) for (let i = t.first; i <= t.last; i++) txOf.set(i, t);
  for (let i = 0; i < m.segs.length; i++) {
    const s = m.segs[i];
    if (s.una) continue;
    const t = txOf.get(i);
    rows.push([t ? t.code : '', t ? t.ctrl : '', s.l + 1, s.t, E.segName(m.standard, s.t), ...s.e.slice(0, width).map((x) => E.unescape(x, sep.release))]);
  }
  return { kind: 'segments', rows: rows.length, csv: [csvRow(head), ...rows.map(csvRow)].join('\r\n') + '\r\n' };
}

// ---------------- compare ----------------

/** Elements that hold control numbers or envelope dates and times; masked when the user asks to ignore them. */
const VOLATILE = {
  x12: { ISA: [9, 10, 13], IEA: [2], GS: [4, 5, 6], GE: [2], ST: [2], SE: [2], BHT: [4, 5] },
  edifact: { UNB: [4, 5], UNZ: [2], UNG: [4, 5], UNE: [2], UNH: [1], UNT: [2] },
};

function normalized(m, i, ignore) {
  const s = m.segs[i];
  const els = s.e.slice();
  if (ignore) {
    const mask = VOLATILE[m.standard][s.t];
    if (mask) for (const k of mask) if (k <= els.length) els[k - 1] = '·';
  }
  while (els.length && els[els.length - 1] === '') els.pop();
  return [s.t, ...els].join('\u0001');
}

/** LCS on segment keys after trimming the equal head and tail: O(n*m) only when n*m <= 25M, else by position. */
function diffSeq(a, b) {
  const n = a.length, m = b.length;
  // trim equal head and tail
  let h = 0; while (h < n && h < m && a[h] === b[h]) h++;
  let t = 0; while (t < n - h && t < m - h && a[n - 1 - t] === b[m - 1 - t]) t++;
  const A = a.slice(h, n - t), B = b.slice(h, m - t);
  const ops = [];
  for (let k = 0; k < h; k++) ops.push(['=', k, k]);
  if (A.length * B.length <= 25e6) {
    const N = A.length, M = B.length;
    const W = M + 1;
    const L = new Uint32Array((N + 1) * W);
    for (let i = N - 1; i >= 0; i--) for (let j = M - 1; j >= 0; j--) L[i * W + j] = A[i] === B[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    let i = 0, j = 0;
    while (i < N && j < M) {
      if (A[i] === B[j]) { ops.push(['=', h + i, h + j]); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) { ops.push(['-', h + i, -1]); i++; }
      else { ops.push(['+', -1, h + j]); j++; }
    }
    while (i < N) ops.push(['-', h + i++, -1]);
    while (j < M) ops.push(['+', -1, h + j++]);
  } else {
    const k = Math.max(A.length, B.length);
    for (let i = 0; i < k; i++) {
      if (i < A.length && i < B.length) ops.push(A[i] === B[i] ? ['=', h + i, h + i] : ['~', h + i, h + i]);
      else if (i < A.length) ops.push(['-', h + i, -1]); else ops.push(['+', -1, h + i]);
    }
  }
  for (let k = 0; k < t; k++) ops.push(['=', n - t + k, m - t + k]);
  return ops;
}

/**
 * Segment-by-segment comparison. A removed segment followed by an added one with the same tag is shown as a
 * change with element differences. Returns { same, added, removed, changed, rows: [...] } (rows capped at 5,000).
 */
function compareModels(a, b, { ignoreControl = false } = {}) {
  if (a.standard !== b.standard) return { error: `One file is ${a.summary.standard}, the other ${b.summary.standard}.`, rows: [], same: 0, added: 0, removed: 0, changed: 0 };
  const ka = a.segs.map((_, i) => normalized(a, i, ignoreControl));
  const kb = b.segs.map((_, i) => normalized(b, i, ignoreControl));
  const ops = diffSeq(ka, kb);
  // pair - then + of the same tag into changes
  const out = [];
  let same = 0, added = 0, removed = 0, changed = 0;
  for (let k = 0; k < ops.length; k++) {
    const [op, i, j] = ops[k];
    if (op === '=') { same++; continue; }
    if (op === '-') {
      let q = k + 1; while (q < ops.length && ops[q][0] === '-') q++;
      const dels = ops.slice(k, q), adds = [];
      let r = q; while (r < ops.length && ops[r][0] === '+') { adds.push(ops[r]); r++; }
      const used = new Set();
      for (const d of dels) {
        const ai = d[1];
        const p = adds.findIndex((x, xi) => !used.has(xi) && b.segs[x[2]].t === a.segs[ai].t);
        if (p >= 0) { used.add(p); out.push(changeRow(a, b, ai, adds[p][2], ignoreControl)); changed++; }
        else { out.push(row('removed', a, ai, null)); removed++; }
      }
      adds.forEach((x, xi) => { if (!used.has(xi)) { out.push(row('added', b, x[2], null)); added++; } });
      k = r - 1;
      continue;
    }
    if (op === '+') { out.push(row('added', b, j, null)); added++; continue; }
    if (op === '~') { out.push(changeRow(a, b, i, j, ignoreControl)); changed++; }
  }
  out.sort((x, y) => (x.lineA || x.lineB) - (y.lineA || y.lineB));
  return { same, added, removed, changed, ignoreControl, rows: out.slice(0, 5000), more: Math.max(0, out.length - 5000), segmentsA: a.segs.length, segmentsB: b.segs.length };
}

const segText = (m, i) => [m.segs[i].t, ...m.segs[i].e].join(m.sep.element);
function row(kind, m, i) {
  const s = m.segs[i];
  return { kind, tag: s.t, name: E.segName(m.standard, s.t), [kind === 'added' ? 'lineB' : 'lineA']: s.l + 1, text: segText(m, i).slice(0, 400) };
}
function changeRow(a, b, i, j, ignore) {
  const sa = a.segs[i], sb = b.segs[j];
  const n = Math.max(sa.e.length, sb.e.length);
  const diffs = [];
  const mask = ignore ? (VOLATILE[a.standard][sa.t] || []) : [];
  for (let k = 1; k <= n; k++) {
    if (mask.includes(k)) continue;
    const x = E.unescape(sa.e[k - 1] || '', a.sep.release), y = E.unescape(sb.e[k - 1] || '', b.sep.release);
    if (x !== y) {
      const ed = (a.standard === 'x12' ? E.X : E.U).SEG[sa.t];
      diffs.push({ id: elemId(a.standard, sa.t, k), name: ed && ed.e && ed.e[k - 1] ? ed.e[k - 1][0] : '', a: x, b: y });
    }
  }
  return { kind: 'changed', tag: sa.t, name: E.segName(a.standard, sa.t), lineA: sa.l + 1, lineB: sb.l + 1, text: segText(a, i).slice(0, 400), textB: segText(b, j).slice(0, 400), diffs };
}

function mdEsc(s) { return String(s).replace(/\|/g, '\\|').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;')).replace(/\r?\n/g, ' '); }

function compareMarkdown(r, nameA, nameB) {
  const out = [`# EDI comparison of ${mdEsc(nameA)} and ${mdEsc(nameB)}`, ''];
  if (r.error) return out.concat([r.error, '']).join('\n');
  out.push(`${r.segmentsA} segments in ${mdEsc(nameA)}, ${r.segmentsB} in ${mdEsc(nameB)}. ${r.same} the same, ${r.changed} changed, ${r.added} added, ${r.removed} removed.${r.ignoreControl ? ' Control numbers and envelope dates and times were ignored.' : ''}`, '');
  if (!r.rows.length) { out.push('The files have the same segments.', ''); return out.join('\n'); }
  out.push('| | Line A | Line B | Segment | Difference |', '|---|---|---|---|---|');
  for (const x of r.rows) {
    const what = x.kind === 'changed' ? x.diffs.map((d) => `${d.id}${d.name ? ` (${mdEsc(d.name)})` : ''}: \`${mdEsc(d.a) || ' '}\` → \`${mdEsc(d.b) || ' '}\``).join('<br>') : `\`${mdEsc(x.text)}\``;
    out.push(`| ${x.kind} | ${x.lineA || ''} | ${x.lineB || ''} | ${x.tag}${x.name ? ` ${mdEsc(x.name)}` : ''} | ${what} |`);
  }
  if (r.more) out.push('', `${r.more} more differences are not listed.`);
  return out.join('\n') + '\n';
}

// ---------------- folder report ----------------

/** One row of the folder report from a parsed model (or an error). */
function reportRow(rel, m, err) {
  if (err) return { file: rel, standard: '', status: 'not read', errors: 0, warnings: 0, interchanges: 0, transactions: 0, types: '', from: '', to: '', first: err };
  const s = m.summary;
  const first = m.problems.find((p) => p.sev === 'error') || m.problems[0];
  return {
    file: rel, standard: s.standard, status: s.errors ? 'errors' : s.warnings ? 'warnings' : 'ok', errors: s.errors, warnings: s.warnings,
    interchanges: s.interchanges, transactions: s.transactions, types: Object.entries(s.types).map(([k, v]) => `${k} x${v}`).join(' '),
    from: s.from, to: s.to, first: first ? `line ${m.segs[first.seg] ? m.segs[first.seg].l + 1 : 1}: ${first.msg}` : '',
  };
}

function reportMarkdown(rows, root, stopped) {
  const ok = rows.filter((r) => r.status === 'ok').length;
  const bad = rows.filter((r) => r.status === 'errors').length;
  const out = [`# EDI folder check of ${mdEsc(root)}`, '', `${rows.length} EDI file${rows.length === 1 ? '' : 's'} checked: ${ok} without problems, ${bad} with errors, ${rows.filter((r) => r.status === 'warnings').length} with warnings only, ${rows.filter((r) => r.status === 'not read').length} not read.${stopped ? ' The check was stopped before the end.' : ''}`, ''];
  out.push('| File | Standard | Status | Errors | Warnings | Transactions | Types | Sender | Receiver | First problem |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) out.push(`| ${mdEsc(r.file)} | ${r.standard} | ${r.status} | ${r.errors} | ${r.warnings} | ${r.transactions} | ${mdEsc(r.types)} | ${mdEsc(r.from)} | ${mdEsc(r.to)} | ${mdEsc(r.first)} |`);
  return out.join('\n') + '\n';
}

function reportCsv(rows) {
  const head = ['file', 'standard', 'status', 'errors', 'warnings', 'interchanges', 'transactions', 'types', 'sender', 'receiver', 'first problem'];
  return [csvRow(head), ...rows.map((r) => csvRow([r.file, r.standard, r.status, r.errors, r.warnings, r.interchanges, r.transactions, r.types, r.from, r.to, r.first]))].join('\r\n') + '\r\n';
}

/** Does this start of a file look like EDI? */
function looksEdi(head) {
  const s = head.replace(/^\uFEFF/, '').replace(/^\s+/, '');
  return /^ISA./.test(s) || /^UNA.{6}/.test(s) || /^UNB[+]/.test(s);
}

module.exports = { toJson, toCsv, compareModels, compareMarkdown, reportRow, reportMarkdown, reportCsv, looksEdi, csvCell, values, VOLATILE, LINE_ITEM_SETS };
