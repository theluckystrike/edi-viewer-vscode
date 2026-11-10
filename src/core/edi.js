'use strict';
// EDI reader for X12 and EDIFACT. Pure functions on a string, no vscode, no I/O: the worker, the tests and the text
// editor features all use this module. Every loop is bounded (segment cap, problem cap, segment length guard).
const X = require('./dict-x12');
const U = require('./dict-edifact');

const LIMITS = { maxSegments: 500000, maxProblems: 5000, maxNodes: 200000 };
const ISA_WIDTHS = [2, 10, 2, 10, 2, 15, 2, 15, 6, 4, 1, 5, 9, 1, 1, 1];

class EdiError extends Error { constructor(msg, code) { super(msg); this.code = code; } }

const show = (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : c === ' ' ? 'space' : c);
const isAlnum = (c) => /[A-Za-z0-9]/.test(c);

/** Find the standard and the separators. Throws EdiError NOT_EDI / BAD_HEADER / BAD_SEPARATORS. */
function detect(text) {
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < text.length && i < 4096 && /\s/.test(text[i])) i++;
  const head = text.slice(i, i + 3);
  if (head === 'ISA') return detectX12(text, i);
  if (head === 'UNA' || head === 'UNB' || (head === 'UNH' && /^UNH[+]/.test(text.slice(i, i + 4)))) return detectEdifact(text, i);
  if ((head.startsWith('GS') || head.startsWith('ST')) && /^(GS|ST)\*/.test(text.slice(i, i + 3))) {
    // a functional group or transaction set without the ISA envelope: '*' elements, '~' (or new line) segments
    const term = text.indexOf('~') >= 0 ? '~' : '\n';
    return { standard: 'x12', start: i, sep: { element: '*', component: ':', repetition: '^', segment: term, release: '' }, version: '', noEnvelope: true };
  }
  const bin = /[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 512));
  throw new EdiError(bin ? 'This file holds binary data, not EDI text.' : 'This is not an EDI file: X12 starts with ISA, EDIFACT with UNA or UNB.', 'NOT_EDI');
}

function detectX12(text, i) {
  const el = text[i + 3];
  if (el === undefined || isAlnum(el) || /[\r\n]/.test(el)) throw new EdiError('The ISA header has no element separator after "ISA".', 'BAD_HEADER');
  // walk 16 element separators: ISA16 (the component separator) follows the 16th, the segment terminator follows it
  let p = i + 3, n = 0;
  while (n < 16 && p < text.length && p < i + 400) { if (text[p] === el) n++; p++; }
  if (n < 16) throw new EdiError(`The ISA header is cut short: it has ${n} of its 16 elements.`, 'BAD_HEADER');
  const component = text[p], segment = text[p + 1];
  if (component === undefined || segment === undefined) throw new EdiError('The ISA header ends before its segment terminator.', 'BAD_HEADER');
  const fields = text.slice(i + 4, p).split(el);
  const version = fields[11] || '';
  let repetition = fields[10] || '';
  if (repetition.length !== 1 || isAlnum(repetition) || repetition === ' ') repetition = '';
  const used = [['element', el], ['component', component], ['segment terminator', segment]];
  if (repetition) used.push(['repetition', repetition]);
  for (let a = 0; a < used.length; a++) for (let b = a + 1; b < used.length; b++) {
    if (used[a][1] === used[b][1]) throw new EdiError(`The ISA header uses "${show(used[a][1])}" as the ${used[a][0]} separator and as the ${used[b][0]}. Each separator must be a different character.`, 'BAD_SEPARATORS');
  }
  if (isAlnum(component) || isAlnum(segment)) throw new EdiError(`The ISA header gives a letter or digit as a separator ("${show(isAlnum(component) ? component : segment)}"). The terminator must follow ISA16.`, 'BAD_SEPARATORS');
  return { standard: 'x12', start: i, sep: { element: el, component, repetition, segment, release: '' }, version };
}

function detectEdifact(text, i) {
  let sep = { component: ':', element: '+', decimal: '.', release: '?', segment: "'" };
  let una = null;
  if (text.slice(i, i + 3) === 'UNA') {
    const s = text.slice(i + 3, i + 9);
    if (s.length < 6) throw new EdiError('The UNA service string advice is cut short: it needs 6 characters after "UNA".', 'BAD_HEADER');
    sep = { component: s[0], element: s[1], decimal: s[2], release: s[3] === ' ' ? '' : s[3], segment: s[5] };
    una = { off: i, len: 9 };
    const used = [['component', sep.component], ['element', sep.element], ['segment terminator', sep.segment]];
    if (sep.release) used.push(['release character', sep.release]);
    for (let a = 0; a < used.length; a++) for (let b = a + 1; b < used.length; b++) {
      if (used[a][1] === used[b][1]) throw new EdiError(`The UNA segment uses "${show(used[a][1])}" as the ${used[a][0]} and as the ${used[b][0]}. Each separator must be a different character.`, 'BAD_SEPARATORS');
    }
    if (used.some(([, c]) => isAlnum(c))) throw new EdiError('The UNA segment gives a letter or digit as a separator.', 'BAD_SEPARATORS');
  }
  return { standard: 'edifact', start: una ? i + 9 : i, sep: { ...sep, repetition: '*' }, una, version: '' };
}

/** Split a raw segment into elements; EDIFACT honours the release character (the values keep it; see unescape). */
function splitRaw(raw, ch, release) {
  if (!release || raw.indexOf(release) < 0) return raw.split(ch);
  const out = [];
  let cur = 0, k = 0;
  while (k < raw.length) {
    const c = raw[k];
    if (c === release) { k += 2; continue; }
    if (c === ch) { out.push(raw.slice(cur, k)); cur = k + 1; }
    k++;
  }
  out.push(raw.slice(cur));
  return out;
}
function unescape(v, release) {
  if (!release || v.indexOf(release) < 0) return v;
  let s = '';
  for (let k = 0; k < v.length; k++) { if (v[k] === release && k + 1 < v.length) k++; s += v[k]; }
  return s;
}

/** Next segment terminator at or after `from` that is not released. */
function nextTerm(text, from, term, release) {
  let j = text.indexOf(term, from);
  if (!release) return j;
  while (j >= 0) {
    let r = 0, k = j - 1;
    while (k >= from && text[k] === release) { r++; k--; }
    if (r % 2 === 0) return j;
    j = text.indexOf(term, j + 1);
  }
  return -1;
}

/** Tokenize into segments: { t: tag, o: offset, n: length (no terminator), l: line (0-based), e: [raw elements] }. */
function tokenize(text, det, limits = LIMITS) {
  const { sep } = det;
  const segs = [];
  const notes = [];
  if (det.una) segs.push({ t: 'UNA', o: det.una.off, n: 9, l: lineAt(text, det.una.off), e: [text.slice(det.una.off + 3, det.una.off + 9)], una: true });
  let i = det.start, line = lineAt(text, i), lineFrom = i;
  const N = text.length;
  const isWs = (c) => c === '\r' || c === '\n' || c === ' ' || c === '\t';
  while (i < N) {
    while (i < N && isWs(text[i]) && text[i] !== sep.segment) i++;
    if (i >= N) break;
    if (segs.length >= limits.maxSegments) { notes.push(`The file has more than ${limits.maxSegments.toLocaleString('en-US')} segments; the first ${limits.maxSegments.toLocaleString('en-US')} are shown.`); break; }
    let j = nextTerm(text, i, sep.segment, sep.release);
    let terminated = j >= 0;
    if (!terminated) j = N;
    // X12 binary segment: BIN*<length>*<data>; the data may contain any character
    if (det.standard === 'x12' && text.startsWith('BIN' + sep.element, i)) {
      const k = text.indexOf(sep.element, i + 4);
      const len = k > 0 ? Number(text.slice(i + 4, k)) : NaN;
      if (Number.isSafeInteger(len) && len >= 0) {
        const end = k + 1 + len;
        if (end > N) { notes.push(`A BIN segment says it holds ${len.toLocaleString('en-US')} bytes, more than the rest of the file.`); j = N; terminated = false; }
        else { j = end; terminated = text[end] === sep.segment; if (!terminated) { const t2 = nextTerm(text, end, sep.segment, ''); j = t2 >= 0 ? t2 : N; terminated = t2 >= 0; } }
      }
    }
    let n = j - i;
    if (sep.segment === '\n' && text[j - 1] === '\r') n--;
    // count lines between the last counted position and this segment's start
    for (let k = lineFrom; k < i; k++) if (text.charCodeAt(k) === 10) line++;
    lineFrom = i;
    const raw = text.slice(i, i + n);
    const e = splitRaw(raw, sep.element, sep.release);
    const t = e.shift();
    segs.push({ t, o: i, n, l: line, e, ...(terminated ? {} : { open: true }) });
    i = j + 1;
  }
  return { segs, notes };
}

function lineAt(text, off) { let l = 0; for (let k = 0; k < off && k < text.length; k++) if (text.charCodeAt(k) === 10) l++; return l; }

// ---------------- structure ----------------

const dictOf = (std) => (std === 'x12' ? X : U);
function codeMeaning(std, table, v) { const t = table && dictOf(std).CODES[table]; return t && v !== undefined ? t[String(v).trim()] : undefined; }

/** Value of element k (1-based) of a segment, component c (1-based, optional), released characters removed. */
function val(seg, k, c, sep) {
  let v = seg.e[k - 1];
  if (v === undefined) return '';
  if (c) v = splitRaw(v, sep.component, sep.release)[c - 1] || '';
  return unescape(v, sep.release);
}

function segLabel(std, seg, sep) {
  const v = (k, c) => val(seg, k, c, sep);
  const m = (table, x) => codeMeaning(std, table, x);
  const join = (...p) => p.filter((x) => x !== undefined && x !== null && String(x).trim() !== '').join(' ');
  const t = seg.t;
  if (std === 'x12') {
    switch (t) {
      case 'PO1': case 'IT1': return join(`line ${v(1) || '?'}:`, v(2), v(3), v(7) ? `· ${m('prodQual', v(6)) || v(6)} ${v(7)}` : '');
      case 'LIN': return join(v(1) ? `line ${v(1)}:` : '', m('prodQual', v(2)) || v(2), v(3));
      case 'N1': return join(m('entity', v(1)) || v(1), v(2) ? `· ${v(2)}` : '');
      case 'NM1': return join(m('entity', v(1)) || v(1), (v(3) || v(4)) ? `· ${join(v(3), v(4))}` : '');
      case 'HL': return join(m('hl03', v(3)) || `level ${v(3)}`, `(HL ${v(1)}${v(2) ? ` under ${v(2)}` : ''})`);
      case 'CLM': return join('claim', v(1), v(2) ? `· ${v(2)}` : '');
      case 'CLP': return join('claim', v(1), '·', m('clp02', v(2)) || v(2), v(4) ? `· paid ${v(4)}` : '');
      case 'SVC': return join(v(1).split(sep.component).slice(1).join(' ') || v(1), v(3) ? `· paid ${v(3)}` : '');
      case 'LX': return `line ${v(1)}`;
      case 'SBR': return join(m('sbr01', v(1)) || v(1), 'payer');
      case 'ENT': return join('entity', v(1));
      case 'RMR': return join(m('ref01', v(1)) || v(1), v(2), v(4) ? `· paid ${v(4)}` : '');
      case 'AK2': return join(v(1), m('st01', v(1)) || '', `#${v(2)}`);
      case 'AK3': case 'IK3': return join('segment', v(1), `at ${v(2)}`);
      case 'IK4': case 'AK4': return join('element', v(1));
      case 'S5': return join('stop', v(1), '·', m('s502', v(2)) || v(2));
      case 'OID': return join('order', v(2) || v(1));
      case 'W01': return join(v(1), v(2), v(5) ? `· ${v(5)}` : '');
      case 'W12': return join(v(3) || v(2), v(5), v(8) ? `· ${v(8)}` : '');
      case 'AT7': return m('at701', v(1)) || v(1) || v(2);
      case 'EB': return m('eb01', v(1)) || v(1);
      case 'EQ': return m('eq01', v(1)) || v(1);
      case 'TRN': return join('trace', v(2));
      case 'SLN': return join('subline', v(1));
      case 'N9': return join(m('ref01', v(1)) || v(1), v(2));
      case 'ACK': return m('ack01', v(1)) || v(1);
      case 'CTT': return join(v(1), 'line items');
      case 'PLB': return join('provider', v(1));
      default: return '';
    }
  }
  switch (t) {
    case 'LIN': return join(v(1) ? `line ${v(1)}:` : '', v(3, 1), v(3, 2) ? `(${codeMeaning(std, 'itemType', v(3, 2)) || v(3, 2)})` : '');
    case 'NAD': return join(m('nad', v(1)) || v(1), v(2, 1), v(4, 1) ? `· ${v(4, 1)}` : '');
    case 'RFF': return join(m('rff', v(1, 1)) || v(1, 1), v(1, 2));
    case 'CPS': return join('level', v(1), v(2) ? `under ${v(2)}` : '');
    case 'PAC': return join(v(1), v(3, 1));
    case 'TDT': return join(m('tdt8051', v(1)) || v(1), v(3, 1) ? `· ${m('tdtMode', v(3, 1)) || v(3, 1)}` : '');
    case 'TAX': return join(v(2, 1), v(5, 4) ? `${v(5, 4)} %` : '');
    case 'ALC': return join(m('alc', v(1)) || v(1), v(5, 1) || v(2, 1));
    case 'CUX': return join(v(1, 2));
    case 'PAT': return join('terms', v(1));
    case 'GID': return join('goods item', v(1));
    case 'ERC': return join('error', v(1, 1));
    case 'UCM': return join('message', v(1), v(2, 1), '·', m('contrlAction', v(3)) || v(3));
    case 'UCF': return join('group', v(1));
    case 'UCS': return join('segment', v(1));
    case 'PRI': return join(m('pri', v(1, 1)) || v(1, 1), v(1, 2));
    case 'CTA': return join(m('cta', v(1)) || v(1), v(2, 2));
    case 'EQD': return join(v(1), v(2, 1));
    case 'PGI': return join('product group', v(1));
    default: return '';
  }
}

function segName(std, tag) { const s = dictOf(std).SEG[tag]; return s ? s.n : ''; }

/**
 * Parse text into the full model used by the viewer, the validator and the Pro tools.
 * Returns { standard, sep, version, segs, nodes, owner, problems, notes, summary, transactions }.
 */
function parse(text, limits = {}) {
  const L = { ...LIMITS, ...limits };
  const det = detect(text);
  const { segs, notes } = tokenize(text, det, L);
  const std = det.standard, sep = det.sep;
  const D = dictOf(std);
  const problems = [];
  const problem = (sev, seg, msg, el) => { if (problems.length < L.maxProblems) problems.push({ sev, seg, el: el || 0, msg }); };
  const nodes = [{ id: 0, parent: -1, kind: 'file', tag: '', label: std === 'x12' ? 'X12 file' : 'EDIFACT file', first: 0, last: segs.length - 1 }];
  const owner = new Int32Array(segs.length);
  const newNode = (parent, kind, seg, label, extra) => {
    if (nodes.length >= L.maxNodes) return nodes[parent];
    const n = { id: nodes.length, parent, kind, tag: segs[seg] ? segs[seg].t : '', label, first: seg, last: seg, ...(extra || {}) };
    nodes.push(n);
    return n;
  };
  const extend = (node, i) => { for (let n = node; n && n.id !== 0; n = nodes[n.parent]) if (n.last < i) n.last = i; };
  const v = (s, k, c) => val(s, k, c, sep);
  const transactions = [];
  let ich = null, grp = null, tx = null, stack = null, hlMap = null, set = null, setKey = '';
  const env = std === 'x12'
    ? { I: 'ISA', IE: 'IEA', G: 'GS', GE: 'GE', T: 'ST', TE: 'SE' }
    : { I: 'UNB', IE: 'UNZ', G: 'UNG', GE: 'UNE', T: 'UNH', TE: 'UNT' };
  const tagOk = std === 'x12' ? /^[A-Z][A-Z0-9]{1,2}$/ : /^[A-Z]{3}$/;

  const closeTx = (i, why) => {
    if (!tx) return;
    if (why) problem('error', tx.first, why);
    tx = null; stack = null; hlMap = null; set = null;
  };
  const closeGrp = (why) => { if (!grp) return; if (why) problem('error', grp.first, why); grp = null; };

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const t = s.t;
    if (s.una) { owner[i] = 0; continue; }
    if (s.open && i === segs.length - 1 && s.n > 0) problem('warning', i, `The last segment (${t}) has no segment terminator "${show(sep.segment)}".`);
    if (s.n > 100000) problem('warning', i, `This segment is ${s.n.toLocaleString('en-US')} characters long. Is the segment terminator "${show(sep.segment)}" right?`);
    if (!tagOk.test(t)) { problem('error', i, `"${t.slice(0, 20)}" is not a segment ID.`); }
    if (t === env.I) {
      if (tx) closeTx(i, `Transaction ${tx.code} has no ${env.TE} trailer.`);
      if (grp) closeGrp(`Group ${grp.ctrl} has no ${env.GE} trailer.`);
      if (ich) problem('error', ich.first, `Interchange ${ich.ctrl} has no ${env.IE} trailer.`);
      const ctrl = std === 'x12' ? v(s, 13) : v(s, 5);
      const from = std === 'x12' ? v(s, 6).trim() : v(s, 2, 1), to = std === 'x12' ? v(s, 8).trim() : v(s, 3, 1);
      ich = newNode(0, 'interchange', i, `Interchange ${ctrl}`, { ctrl, from, to, groups: 0, msgs: 0, date: std === 'x12' ? `${v(s, 9)} ${v(s, 10)}` : `${v(s, 4, 1)} ${v(s, 4, 2)}`, sub: `${from} → ${to}` });
      owner[i] = ich.id;
      if (std === 'x12') {
        if (s.e.length !== 16) problem('error', i, `The ISA segment has ${s.e.length} elements; it must have 16.`);
        for (let k = 0; k < Math.min(16, s.e.length); k++) {
          const w = s.e[k].length;
          if (w !== ISA_WIDTHS[k]) problem('error', i, `ISA${String(k + 1).padStart(2, '0')} (${D.SEG.ISA.e[k][0]}) is ${w} character${w === 1 ? '' : 's'} long; it must be ${ISA_WIDTHS[k]}${ISA_WIDTHS[k] > 2 ? ' (pad with spaces or zeros)' : ''}.`, k + 1);
        }
        if (!/^\d{9}$/.test(v(s, 13))) problem('warning', i, 'ISA13 (Interchange control number) should be 9 digits.', 13);
      }
      continue;
    }
    if (t === env.IE) {
      if (tx) closeTx(i, `Transaction ${tx.code} has no ${env.TE} trailer.`);
      if (grp) closeGrp(`Group ${grp.ctrl} has no ${env.GE} trailer.`);
      if (!ich) { problem('error', i, `${t} without an ${env.I} header before it.`); owner[i] = 0; continue; }
      owner[i] = ich.id; extend(ich, i);
      const count = Number(v(s, 1)), ref = v(s, 2);
      const want = std === 'x12' ? ich.groups : (ich.groups || ich.msgs);
      const what = std === 'x12' ? 'functional groups' : ich.groups ? 'functional groups' : 'messages';
      if (String(count) !== String(Number(v(s, 1))) || count !== want) problem('error', i, `${t}01 says ${v(s, 1) || '(empty)'} ${what}; the interchange has ${want}.`, 1);
      if (!sameCtrl(ref, ich.ctrl)) problem('error', i, `${t}02 control number ${ref || '(empty)'} does not match ${env.I} ${ich.ctrl}.`, 2);
      ich.closed = true; ich = null;
      continue;
    }
    if (t === env.G) {
      if (tx) closeTx(i, `Transaction ${tx.code} has no ${env.TE} trailer.`);
      if (grp) closeGrp(`Group ${grp.ctrl} has no ${env.GE} trailer.`);
      const parent = ich || nodes[0];
      if (!ich && !det.noEnvelope) problem('error', i, `${t} outside an interchange (no ${env.I} before it).`);
      const ctrl = std === 'x12' ? v(s, 6) : v(s, 5);
      const kind = std === 'x12' ? v(s, 1) : v(s, 1);
      grp = newNode(parent.id, 'group', i, `Group ${ctrl}`, { ctrl, msgs: 0, sub: std === 'x12' ? [codeMeaning(std, 'gs01', kind) || kind, v(s, 8)].filter(Boolean).join(' · ') : kind });
      if (ich) ich.groups++;
      owner[i] = grp.id; extend(grp, i);
      continue;
    }
    if (t === env.GE) {
      if (tx) closeTx(i, `Transaction ${tx.code} has no ${env.TE} trailer.`);
      if (!grp) { problem('error', i, `${t} without a ${env.G} header before it.`); owner[i] = ich ? ich.id : 0; if (ich) extend(ich, i); continue; }
      owner[i] = grp.id; extend(grp, i);
      if (Number(v(s, 1)) !== grp.msgs || !/^\d+$/.test(v(s, 1))) problem('error', i, `${t}01 says ${v(s, 1) || '(empty)'} ${std === 'x12' ? 'transaction sets' : 'messages'}; the group has ${grp.msgs}.`, 1);
      if (!sameCtrl(v(s, 2), grp.ctrl)) problem('error', i, `${t}02 control number ${v(s, 2) || '(empty)'} does not match ${env.G} ${grp.ctrl}.`, 2);
      grp = null;
      continue;
    }
    if (t === env.T) {
      if (tx) closeTx(i, `Transaction ${tx.code} has no ${env.TE} trailer.`);
      const parent = grp || ich || nodes[0];
      if (std === 'x12' && !grp && !det.noEnvelope) problem('error', i, 'ST outside a functional group (no GS before it).');
      if (std === 'edifact' && !ich) problem('warning', i, 'UNH without a UNB interchange header before it.');
      const code = std === 'x12' ? v(s, 1) : v(s, 2, 1);
      const ctrl = std === 'x12' ? v(s, 2) : v(s, 1);
      setKey = code;
      set = D.SETS[code] || null;
      let name = set ? set.n : (std === 'x12' ? codeMeaning(std, 'st01', code) : codeMeaning(std, 'msgType', code)) || '';
      if (std === 'x12' && code === '837') { const vv = X.variant837(v(s, 3) || (grpSeg(segs, grp) ? v(grpSeg(segs, grp), 8) : '')); if (vv) name = vv; }
      const ver = std === 'x12' ? (v(s, 3) || (grp ? v(segs[grp.first], 8) : '')) : [v(s, 2, 2), v(s, 2, 3)].filter(Boolean).join('');
      tx = newNode(parent.id, 'transaction', i, `${code} ${name}`.trim(), { code, ctrl, sub: `#${ctrl}`, version: ver });
      tx.count = 1;
      transactions.push(tx);
      if (grp) { grp.msgs++; extend(grp, i); }
      if (ich) { ich.msgs++; extend(ich, i); }
      if (grp && grp.ctrls) { if (grp.ctrls.has(ctrl)) problem('warning', i, `Control number ${ctrl} is used by more than one transaction in this group.`, 2); grp.ctrls.add(ctrl); } else if (grp) grp.ctrls = new Set([ctrl]);
      stack = [{ node: tx, tag: env.T }];
      hlMap = new Map();
      owner[i] = tx.id;
      continue;
    }
    if (t === env.TE) {
      if (!tx) { problem('error', i, `${t} without a ${env.T} header before it.`); owner[i] = (grp || ich || nodes[0]).id; continue; }
      owner[i] = tx.id; extend(tx, i);
      const segCount = i - tx.first + 1;
      if (!/^\d+$/.test(v(s, 1)) || Number(v(s, 1)) !== segCount) problem('error', i, `${t}01 says ${v(s, 1) || '(empty)'} segments; the ${std === 'x12' ? 'transaction set' : 'message'} has ${segCount} (from ${env.T} to ${env.TE}).`, 1);
      if (v(s, 2) !== tx.ctrl) problem('error', i, `${t}02 control number ${v(s, 2) || '(empty)'} does not match ${env.T} ${tx.ctrl}.`, 2);
      checkSegment(std, s, i, problem, sep);
      tx = null; stack = null; set = null;
      continue;
    }
    // ---- body segments
    if (!tx) {
      const okOutside = std === 'x12' ? (t === 'TA1' && ich) : false;
      if (!okOutside && tagOk.test(t)) problem('error', i, `Segment ${t} is outside a ${std === 'x12' ? 'transaction set (ST to SE)' : 'message (UNH to UNT)'}.`);
      const o = grp || ich || nodes[0];
      owner[i] = o.id; if (o.id) extend(o, i);
      checkSegment(std, s, i, problem, sep);
      continue;
    }
    if (set && !set.known.has(t) && tagOk.test(t)) problem('warning', i, `Segment ${t}${segName(std, t) ? ` (${segName(std, t)})` : ''} is not part of ${std === 'x12' ? 'an' : 'a'} ${setKey} ${set.n}.`);
    else if (!set && tagOk.test(t) && !D.SEG[t] && std === 'x12') { /* unknown set: no rule */ }
    checkSegment(std, s, i, problem, sep);
    owner[i] = placeInLoop(std, s, i, { set, stack, hlMap, tx, newNode, nodes, sep, v });
    extend(nodes[owner[i]], i);
  }
  if (tx) problem('error', tx.first, `Transaction ${tx.code} ${tx.ctrl} has no ${env.TE} trailer.`);
  if (grp) problem('error', grp.first, `Group ${grp.ctrl} has no ${env.GE} trailer.`);
  if (ich) problem('error', ich.first, `Interchange ${ich.ctrl} has no ${env.IE} trailer.`);
  if (!transactions.length && segs.length) problem('warning', 0, `No ${std === 'x12' ? 'transaction set (ST)' : 'message (UNH)'} found.`);
  for (const n of nodes) { delete n.ctrls; }
  problems.sort((a, b) => a.seg - b.seg);
  const types = {};
  for (const t of transactions) types[t.code] = (types[t.code] || 0) + 1;
  const firstI = nodes.find((n) => n.kind === 'interchange');
  const summary = {
    standard: std === 'x12' ? 'X12' : 'EDIFACT',
    version: std === 'x12' ? (det.version || '') : (segs.find((s) => s.t === 'UNB') ? v(segs.find((s) => s.t === 'UNB'), 1, 1) + ' ' + v(segs.find((s) => s.t === 'UNB'), 1, 2) : ''),
    segments: segs.length, transactions: transactions.length, types,
    interchanges: nodes.filter((n) => n.kind === 'interchange').length,
    groups: nodes.filter((n) => n.kind === 'group').length,
    from: firstI ? firstI.from : '', to: firstI ? firstI.to : '',
    errors: problems.filter((p) => p.sev === 'error').length, warnings: problems.filter((p) => p.sev === 'warning').length,
  };
  return { standard: std, sep, version: det.version || '', segs, nodes, owner, problems, notes, summary, transactions };
}

function grpSeg(segs, grp) { return grp ? segs[grp.first] : null; }
function sameCtrl(a, b) {
  a = String(a || '').trim(); b = String(b || '').trim();
  if (a === b) return true;
  return /^\d+$/.test(a) && /^\d+$/.test(b) && Number(a) === Number(b);
}

/** Empty mandatory elements of a dictionary segment. */
function checkSegment(std, s, i, problem, sep) {
  const d = dictOf(std).SEG[s.t];
  if (!d || !d.e) return;
  for (let k = 0; k < d.e.length; k++) {
    if (!d.e[k][1]) continue;
    let raw = s.e[k];
    if (std === 'edifact' && raw !== undefined) raw = splitRaw(raw, sep.component, sep.release)[0];
    if (raw === undefined || raw === '' || (std === 'x12' && s.t !== 'ISA' && raw.trim() === '')) {
      const id = std === 'x12' ? `${s.t}${String(k + 1).padStart(2, '0')}` : `${s.t} element ${k + 1}`;
      problem('warning', i, `${id} (${d.e[k][0]}) is empty; it is mandatory.`, k + 1);
    }
  }
}

/** Put a body segment into its loop; returns the id of the node that owns it. */
function placeInLoop(std, s, i, c) {
  const { set, stack, hlMap, tx, newNode, nodes, sep } = c;
  const t = s.t;
  const top = () => stack[stack.length - 1];
  if (!set) return top().node.id;
  if (set.hl && t === 'HL') {
    const id = val(s, 1, 0, sep), parentId = val(s, 2, 0, sep);
    const parent = (parentId && hlMap.get(parentId)) || tx;
    const n = newNode(parent.id, 'hl', i, `HL ${segLabel(std, s, sep)}`.trim());
    if (id) hlMap.set(id, n);
    stack.length = 1;
    stack.push({ node: n, tag: 'HL', hl: true });
    return n.id;
  }
  if (set.closers && set.closers[t]) {
    for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === set.closers[t]) { stack.length = k + 1; return stack[k].node.id; }
  }
  if (set.loops && Object.prototype.hasOwnProperty.call(set.loops, t)) {
    const allowed = (e) => (e.node === tx ? set.top : e.hl ? (set.hlLoops || []) : (set.loops[e.tag] || []));
    let k = stack.length - 1;
    while (k >= 0 && !allowed(stack[k]).includes(t)) k--;
    if (k >= 0) {
      stack.length = k + 1;
      const lab = segLabel(std, s, sep);
      const n = newNode(stack[k].node.id, 'loop', i, `${t}${lab ? ' ' + lab : ' ' + (segName(std, t) || '')}`.trim());
      stack.push({ node: n, tag: t });
      return n.id;
    }
  }
  if (set.summary && set.summary.includes(t)) {
    // the summary area: leave the hierarchy and the loops
    stack.length = 1;
    return tx.id;
  }
  return top().node.id;
}

// ---------------- positions, format, hover ----------------

/** [offset, length] of element k (1-based; 0 = the tag) of a segment, component c (1-based) when given. */
function elementSpan(text, seg, k, sep, c) {
  const raw = text.slice(seg.o, seg.o + seg.n);
  if (!k) return [seg.o, seg.t.length];
  let pos = 0, idx = 0, start = 0;
  const ch = sep.element;
  for (; pos <= raw.length; pos++) {
    if (sep.release && raw[pos] === sep.release) { pos++; continue; }
    if (pos === raw.length || raw[pos] === ch) {
      if (idx === k) {
        let s0 = start, e0 = pos;
        if (c) {
          const parts = splitRaw(raw.slice(s0, e0), sep.component, sep.release);
          let o = s0;
          for (let q = 0; q < c - 1 && q < parts.length; q++) o += parts[q].length + 1;
          const p = parts[c - 1];
          if (p !== undefined) return [seg.o + o, p.length];
        }
        return [seg.o + s0, e0 - s0];
      }
      idx++; start = pos + 1;
    }
  }
  return [seg.o + seg.n, 0];
}

/**
 * The segment and element at a text offset, scanning at most 64 KB around it (hover, no full parse).
 * Returns { tag, index (element, 0 = tag), component, value, segStart, segEnd, elStart, elEnd } or null.
 */
function locate(text, det, off) {
  const { sep } = det;
  if (off < det.start) return det.una && off >= det.una.off && off < det.una.off + 9 ? { tag: 'UNA', index: 0, component: 0, value: text.slice(det.una.off, det.una.off + 9), segStart: det.una.off, segEnd: det.una.off + 9, elStart: det.una.off, elEnd: det.una.off + 9 } : null;
  const lo = Math.max(det.start, off - 65536), hi = Math.min(text.length, off + 65536);
  let s = off;
  while (s > lo) {
    const ch = text[s - 1];
    if (ch === sep.segment && !(sep.release && released(text, s - 1, sep.release, lo))) break;
    s--;
  }
  while (s < off && /[\r\n \t]/.test(text[s]) && text[s] !== sep.segment) s++;
  let e = s;
  while (e < hi) {
    if (text[e] === sep.segment && !(sep.release && released(text, e, sep.release, s))) break;
    e++;
  }
  if (off > e || off < s) return null;
  const raw = text.slice(s, e).replace(/\r$/, '');
  let idx = 0, start = 0, comp = 0, cstart = 0;
  for (let p = 0; p < off - s && p < raw.length; p++) {
    if (sep.release && raw[p] === sep.release) { p++; continue; }
    if (raw[p] === sep.element) { idx++; start = p + 1; comp = 0; cstart = p + 1; } else if (raw[p] === sep.component || (sep.repetition && raw[p] === sep.repetition && det.standard === 'x12')) { if (raw[p] === sep.component) comp++; cstart = p + 1; }
  }
  let end = start;
  while (end < raw.length && !(raw[end] === sep.element && !(sep.release && end > 0 && released(raw, end, sep.release, 0)))) end++;
  const tag = splitRaw(raw, sep.element, sep.release)[0];
  return { tag, index: idx, component: comp ? comp + 1 : 0, value: raw.slice(start, end), segStart: s, segEnd: e, elStart: s + start, elEnd: s + end, compStart: s + cstart };
}
function released(text, j, release, lo) { let r = 0, k = j - 1; while (k >= lo && text[k] === release) { r++; k--; } return r % 2 === 1; }

/** Name, description and code meaning of an element, for hover and the viewer. */
function describe(std, tag, index, value, component, sep) {
  const D = dictOf(std);
  const sd = D.SEG[tag];
  if (index === 0) return { id: tag, name: sd ? sd.n : '', desc: sd ? sd.d : '', segName: sd ? sd.n : '' };
  const ed = sd && sd.e && sd.e[index - 1];
  const id = std === 'x12' ? `${tag}${String(index).padStart(2, '0')}` : `${tag} ${String(index).padStart(2, '0')}`;
  if (!ed) return { id, name: '', desc: '', segName: sd ? sd.n : '' };
  let name = ed[0], code = ed[2], compName = '';
  const comps = ed[3];
  let v = value;
  if (std === 'edifact' && sep) {
    const parts = splitRaw(String(value || ''), sep.component, sep.release);
    const c = component || 1;
    if (comps && comps[c - 1] !== undefined) {
      const cd = comps[c - 1];
      compName = Array.isArray(cd) ? cd[0] : cd;
      code = Array.isArray(cd) ? cd[1] : (c === 1 ? ed[2] : '');
    } else if (c > 1) code = '';
    v = unescape(parts[c - 1] || '', sep.release);
  }
  const meaning = code && v !== undefined ? (D.CODES[code] || {})[String(v).trim()] : undefined;
  return { id: compName && component ? `${id}-${component}` : id, name, compName, meaning, required: !!ed[1], segName: sd.n, desc: sd.d };
}

/** One segment per line. Keeps the text of every segment; only white space between segments changes. */
function reformat(text, oneLine) {
  const det = detect(text);
  const { segs } = tokenize(text, det, { ...LIMITS, maxSegments: 5000000 });
  const term = det.sep.segment;
  const nl = term === '\n' ? '' : oneLine ? '' : (text.includes('\r\n') ? '\r\n' : '\n');
  const out = [];
  for (const s of segs) {
    const raw = text.slice(s.o, s.o + s.n);
    if (s.una) { out.push(raw + nl); continue; }
    out.push(raw + (s.open ? '' : (term === '\n' ? '\n' : term)) + (s.open ? '' : nl));
  }
  let r = text.slice(0, det.una ? det.una.off : det.start) + out.join('');
  if (oneLine && term !== '\n') r = r.replace(/[\r\n]+$/, '');
  else if (!oneLine && term !== '\n' && !r.endsWith('\n')) r += nl;
  return r;
}

module.exports = { parse, detect, tokenize, splitRaw, unescape, val, elementSpan, locate, describe, reformat, codeMeaning, segName, segLabel, EdiError, LIMITS, ISA_WIDTHS, X, U };
