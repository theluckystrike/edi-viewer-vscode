// EDI Viewer webview. Every value is put on the page with textContent (never as HTML), so values from a hostile file
// stay text. The model comes from the extension host by postMessage; nothing here talks to the network.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const ROW_H = 22;
  const S = { m: null, name: '', tab: 'tree', open: new Set(), sel: { type: 'node', id: 0 }, filter: '', scroll: {}, compare: null, pro: { show: true, tries: {} }, kids: null, own: null };

  const h = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    // Styles go through the CSSOM (style.setProperty): the CSP has no 'unsafe-inline', so a style attribute would be dropped.
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
      else if (k === 'style') { for (const decl of String(v).split(';')) { const i = decl.indexOf(':'); if (i > 0) e.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim()); } }
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return e;
  };
  const post = (m) => vscode.postMessage(m);
  const fmtInt = (n) => Number(n).toLocaleString('en-US');
  const plural = (n, one, many) => `${fmtInt(n)} ${n === 1 ? one : many || one + 's'}`;

  // ---------- EDI helpers (same rules as src/core/edi.js) ----------
  function splitRaw(raw, ch, release) {
    if (!release || raw.indexOf(release) < 0) return raw.split(ch);
    const out = []; let cur = 0, k = 0;
    while (k < raw.length) { const c = raw[k]; if (c === release) { k += 2; continue; } if (c === ch) { out.push(raw.slice(cur, k)); cur = k + 1; } k++; }
    out.push(raw.slice(cur)); return out;
  }
  function unesc(v, release) { if (!release || v.indexOf(release) < 0) return v; let s = ''; for (let k = 0; k < v.length; k++) { if (v[k] === release && k + 1 < v.length) k++; s += v[k]; } return s; }
  const segRaw = (i) => S.m.text.substr(S.m.segs.o[i], S.m.segs.n[i]);
  const segEls = (i) => splitRaw(segRaw(i), S.m.sep.element, S.m.sep.release);
  const dseg = (tag) => S.m.dict.seg[tag];
  const meaning = (table, v) => { const t = table && S.m.dict.codes[table]; return t ? t[String(v).trim()] : undefined; };
  const elemId = (tag, k) => (S.m.standard === 'x12' ? `${tag}${String(k).padStart(2, '0')}` : `${tag}${String(k).padStart(2, '0')}`);
  function preview(i) {
    const els = segEls(i).slice(1).map((x) => unesc(x, S.m.sep.release));
    let s = els.join(' · ');
    return s.length > 160 ? s.slice(0, 160) + '…' : s;
  }

  // ---------- model indexes ----------
  function index() {
    const m = S.m;
    const n = m.segs.t.length;
    S.kids = new Map(); S.own = new Map();
    for (const node of m.nodes) if (node.parent >= 0) { if (!S.kids.has(node.parent)) S.kids.set(node.parent, []); S.kids.get(node.parent).push(node); }
    for (let i = 0; i < n; i++) { const o = m.owner[i]; let a = S.own.get(o); if (!a) S.own.set(o, a = []); a.push(i); }
    S.probBySeg = new Map();
    for (const p of m.problems) { if (!S.probBySeg.has(p.seg)) S.probBySeg.set(p.seg, []); S.probBySeg.get(p.seg).push(p); }
    S.open = new Set([0]);
    const small = n <= 400;
    let tx = 0;
    for (const node of m.nodes) {
      if (node.kind === 'interchange' || node.kind === 'group') S.open.add(node.id);
      if (node.kind === 'transaction' && (small || tx++ < 1)) S.open.add(node.id);
      if (small && (node.kind === 'hl' || node.kind === 'loop')) S.open.add(node.id);
    }
    S.sel = { type: 'node', id: (m.nodes.find((x) => x.kind === 'transaction') || m.nodes[0]).id };
  }
  /** Children of a node in file order: child nodes and the segments it owns directly. */
  function children(id) {
    const ns = S.kids.get(id) || [], ss = S.own.get(id) || [];
    const out = [];
    let a = 0, b = 0;
    while (a < ns.length || b < ss.length) {
      if (b >= ss.length || (a < ns.length && ns[a].first <= ss[b])) out.push({ node: ns[a++] });
      else out.push({ seg: ss[b++] });
    }
    return out;
  }
  function flatRows() {
    const rows = [];
    const walk = (id, depth) => {
      for (const c of children(id)) {
        if (rows.length > 600000) return;
        if (c.node) { rows.push({ node: c.node, depth }); if (S.open.has(c.node.id)) walk(c.node.id, depth + 1); }
        else rows.push({ seg: c.seg, depth });
      }
    };
    walk(0, 0);
    return rows;
  }
  function ancestorsOfSeg(i) {
    const out = [];
    for (let id = S.m.owner[i]; id >= 0; id = S.m.nodes[id].parent) { out.push(id); if (id === 0) break; }
    return out;
  }

  // ---------- frame ----------
  function frame(main) {
    app.textContent = '';
    const m = S.m, s = m.summary;
    const types = Object.entries(s.types).map(([k, v]) => (v > 1 ? `${k} x${v}` : k)).join(', ');
    const desc = `${s.standard}${s.version ? ' ' + s.version : ''} · ${plural(s.transactions, m.standard === 'x12' ? 'transaction set' : 'message')}${types ? ` (${types})` : ''} · ${plural(s.segments, 'segment')}`;
    const head = h('header', { class: 'top' },
      h('div', { class: 'title' }, h('span', { class: 'fname', text: S.name }), h('span', { class: 'desc', text: desc }),
        s.errors || s.warnings ? h('span', { class: 'badge ' + (s.errors ? 'bad' : 'warn'), text: [s.errors ? plural(s.errors, 'error') : '', s.warnings ? plural(s.warnings, 'warning') : ''].filter(Boolean).join(', ') }) : h('span', { class: 'badge ok', text: 'No problems found' })),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', title: 'Open the file in the text editor (hover names, format, minify)', onclick: () => post({ type: 'openText' }) }, 'Open as text'),
        S.pro.show ? proButtons() : null));
    const tabs = h('nav', { class: 'tabs', role: 'tablist' }, ...tabList().map(([id, label, count]) => h('button', {
      class: 'tab' + (S.tab === id ? ' on' : ''), role: 'tab', 'aria-selected': S.tab === id ? 'true' : 'false', 'data-tab': id,
      onclick: () => { S.tab = id; render(); },
    }, label, count !== undefined ? h('span', { class: 'count', text: fmtInt(count) }) : null)));
    const foot = document.getElementById('zovo-footer');
    app.append(head, tabs, h('main', { class: 'view', id: 'view' }, main), foot ? foot.content.cloneNode(true) : '');
  }

  function proButtons() {
    const tries = (f) => (S.pro.licensed ? 'Zovo Pro' : `Zovo Pro tool, ${S.pro.tries[f] ?? 3} free tr${(S.pro.tries[f] ?? 3) === 1 ? 'y' : 'ies'} left`);
    const menu = h('div', { class: 'menu', hidden: true },
      h('button', { text: 'As JSON (tree with element names)', 'data-tool': 'exportJson', onclick: () => { menu.hidden = true; post({ type: 'tool', tool: 'exportJson' }); } }),
      h('button', { text: 'As CSV (line items or segments)', 'data-tool': 'exportCsv', onclick: () => { menu.hidden = true; post({ type: 'tool', tool: 'exportCsv' }); } }));
    const wrap = h('span', { class: 'drop' },
      h('button', { class: 'btn', 'data-tool': 'export', title: `Export to JSON or CSV (${tries('export')})`, onclick: (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; } }, 'Export ▾'), menu);
    document.addEventListener('click', () => { menu.hidden = true; }, { once: true });
    return [wrap,
      h('button', { class: 'btn', 'data-tool': 'compare', title: `Compare with another EDI file (${tries('compare')})`, onclick: () => post({ type: 'tool', tool: 'compare' }) }, 'Compare…'),
      h('button', { class: 'btn', 'data-tool': 'check', title: `Validate every EDI file in a folder (${tries('check')})`, onclick: () => post({ type: 'tool', tool: 'check' }) }, 'Validate folder…')];
  }

  function tabList() {
    const out = [['tree', 'Tree'], ['segments', 'Segments', S.m.segs.t.length], ['problems', 'Problems', S.m.problems.length]];
    if (S.compare) out.push(['compare', 'Compare']);
    return out;
  }

  function render() {
    if (!S.m) return;
    if (!tabList().some((t) => t[0] === S.tab)) S.tab = 'tree';
    let main;
    if (S.tab === 'tree') main = treeView();
    else if (S.tab === 'segments') main = segmentsView();
    else if (S.tab === 'problems') main = problemsView();
    else main = compareView();
    frame(main);
    // Draw right away: requestAnimationFrame does not run in a hidden or occluded window.
    if (S.afterRender) { const f = S.afterRender; S.afterRender = null; f(); }
  }

  /** A virtual list: only the rows on screen are in the DOM. */
  function virtualList(count, drawRow, key, onKey) {
    const body = h('div', { class: 'tbody', tabindex: '0' });
    const spacer = h('div', { class: 'spacer', style: `height:${count * ROW_H}px` });
    const layer = h('div', { class: 'layer' });
    body.append(spacer, layer);
    const draw = () => {
      const top = body.scrollTop, hgt = body.clientHeight || 600;
      const first = Math.max(0, Math.floor(top / ROW_H) - 5), last = Math.min(count, Math.ceil((top + hgt) / ROW_H) + 5);
      layer.textContent = '';
      layer.style.transform = `translateY(${first * ROW_H}px)`;
      for (let k = first; k < last; k++) layer.append(drawRow(k));
    };
    body.addEventListener('scroll', () => { S.scroll[key] = body.scrollTop; draw(); });
    if (onKey) body.addEventListener('keydown', onKey);
    body._draw = draw;
    body._scrollTo = (k) => { const y = k * ROW_H; const hg = body.clientHeight || 600; if (y < body.scrollTop || y + ROW_H > body.scrollTop + hg) body.scrollTop = Math.max(0, y - hg / 3); };
    return body;
  }

  // ---------- tree ----------
  function treeView() {
    const rows = flatRows();
    S.rows = rows;
    const isSel = (r) => (r.node ? S.sel.type === 'node' && S.sel.id === r.node.id : S.sel.type === 'seg' && S.sel.id === r.seg);
    const selIdx = rows.findIndex(isSel);
    const drawRow = (k) => {
      const r = rows[k];
      const indent = `padding-left:${8 + r.depth * 16}px`;
      if (r.node) {
        const n = r.node, open = S.open.has(n.id);
        const nprob = countProblems(n);
        return h('div', { class: 'tr node k-' + n.kind + (isSel(r) ? ' sel' : ''), style: indent, 'data-node': String(n.id), onclick: () => { S.sel = { type: 'node', id: n.id }; renderKeep(); }, ondblclick: () => toggle(n.id) },
          h('span', { class: 'twisty', text: open ? '▾' : '▸', onclick: (e) => { e.stopPropagation(); toggle(n.id); } }),
          h('span', { class: 'nlabel', text: n.label }), n.sub ? h('span', { class: 'muted', text: ` ${n.sub}` }) : null,
          h('span', { class: 'muted small', text: ` ${plural(n.last - n.first + 1, 'segment')}` }), nprob ? h('span', { class: 'dot ' + nprob, title: nprob === 'bad' ? 'Has errors' : 'Has warnings' }) : null);
      }
      const i = r.seg, tag = S.m.segs.t[i], d = dseg(tag);
      const probs = S.probBySeg.get(i);
      return h('div', { class: 'tr seg' + (isSel(r) ? ' sel' : ''), style: indent, 'data-seg': String(i), onclick: () => { S.sel = { type: 'seg', id: i }; renderKeep(); }, ondblclick: () => revealSeg(i) },
        h('span', { class: 'twisty' }), h('span', { class: 'tag', text: tag }), h('span', { class: 'muted', text: d ? ` ${d.n}` : '' }), h('span', { class: 'pv', text: `  ${preview(i)}` }),
        probs ? h('span', { class: 'dot ' + (probs.some((p) => p.sev === 'error') ? 'bad' : 'warn'), title: probs.map((p) => p.msg).join('\n') }) : null);
    };
    const onKey = (e) => {
      let k = rows.findIndex(isSel);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { k = Math.max(0, Math.min(rows.length - 1, k + (e.key === 'ArrowDown' ? 1 : -1))); const r = rows[k]; S.sel = r.node ? { type: 'node', id: r.node.id } : { type: 'seg', id: r.seg }; S.focusTree = true; renderKeep(); e.preventDefault(); }
      else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && k >= 0 && rows[k].node) { const id = rows[k].node.id; if (e.key === 'ArrowRight') S.open.add(id); else S.open.delete(id); S.focusTree = true; renderKeep(); e.preventDefault(); }
      else if (e.key === 'Enter' && k >= 0) { const r = rows[k]; if (r.seg !== undefined) revealSeg(r.seg); else revealNode(r.node); e.preventDefault(); }
    };
    const list = virtualList(rows.length, drawRow, 'tree', onKey);
    list.classList.add('treelist');
    const tools = h('div', { class: 'tools' },
      h('button', { class: 'btn small', onclick: () => { for (const n of S.m.nodes) S.open.add(n.id); render(); } }, 'Expand all'),
      h('button', { class: 'btn small', onclick: () => { S.open = new Set([0]); for (const n of S.m.nodes) if (n.kind === 'interchange' || n.kind === 'group') S.open.add(n.id); render(); } }, 'Collapse'),
      h('span', { class: 'muted', text: S.m.notes.length ? S.m.notes.join(' ') : 'Double-click a row (or Enter) to select it in the text.' }));
    const prev = S.afterRender;
    S.afterRender = () => { if (prev) prev(); list.scrollTop = S.scroll.tree || 0; if (S.revealSel && selIdx >= 0) { list._scrollTo(selIdx); S.revealSel = false; } list._draw(); if (S.focusTree) { list.focus(); S.focusTree = false; } };
    return h('div', { class: 'split' }, h('div', { class: 'pane left' }, tools, list), h('div', { class: 'pane right', id: 'detail' }, detail()));
  }
  function countProblems(n) {
    let warn = false;
    for (const p of S.m.problems) { if (p.seg >= n.first && p.seg <= n.last) { if (p.sev === 'error') return 'bad'; warn = true; } }
    return warn ? 'warn' : '';
  }
  function toggle(id) { if (S.open.has(id)) S.open.delete(id); else S.open.add(id); renderKeep(); }
  function renderKeep() { render(); }
  function selectSeg(i) {
    for (const id of ancestorsOfSeg(i)) S.open.add(id);
    S.sel = { type: 'seg', id: i }; S.tab = 'tree'; S.revealSel = true; render();
  }
  function revealSeg(i, el, comp) {
    let off = S.m.segs.o[i], len = S.m.segs.n[i];
    if (el) { const span = elementSpan(i, el, comp); off = span[0]; len = span[1]; }
    post({ type: 'reveal', offset: off, length: len });
  }
  function revealNode(n) { post({ type: 'reveal', offset: S.m.segs.o[n.first], length: S.m.segs.o[n.last] + S.m.segs.n[n.last] - S.m.segs.o[n.first] }); }
  function elementSpan(i, k, c) {
    const raw = segRaw(i), sep = S.m.sep;
    let idx = 0, start = 0;
    for (let p = 0; p <= raw.length; p++) {
      if (sep.release && raw[p] === sep.release) { p++; continue; }
      if (p === raw.length || raw[p] === sep.element) {
        if (idx === k) {
          if (c) { const parts = splitRaw(raw.slice(start, p), sep.component, sep.release); let o = start; for (let q = 0; q < c - 1 && q < parts.length; q++) o += parts[q].length + 1; if (parts[c - 1] !== undefined) return [S.m.segs.o[i] + o, parts[c - 1].length]; }
          return [S.m.segs.o[i] + start, p - start];
        }
        idx++; start = p + 1;
      }
    }
    return [S.m.segs.o[i], S.m.segs.n[i]];
  }

  // ---------- detail pane ----------
  function detail() {
    if (S.sel.type === 'seg') return segDetail(S.sel.id);
    const n = S.m.nodes[S.sel.id] || S.m.nodes[0];
    return nodeDetail(n);
  }
  function kv(pairs) {
    return h('table', { class: 'kv' }, h('tbody', {}, ...pairs.filter((p) => p[1] !== undefined && p[1] !== '').map(([k, v]) => h('tr', {}, h('th', { text: k }), h('td', { text: String(v) })))));
  }
  function problemList(list) {
    if (!list.length) return null;
    return h('ul', { class: 'probs' }, ...list.slice(0, 200).map((p) => h('li', { class: p.sev, onclick: () => selectSeg(p.seg) }, h('b', { text: p.sev === 'error' ? 'Error' : p.sev === 'warning' ? 'Warning' : 'Note' }), ` line ${fmtInt(S.m.segs.l[p.seg] + 1)}: `, p.msg)));
  }
  function nodeDetail(n) {
    const segN = n.last - n.first + 1;
    const pairs = [['Kind', { file: 'File', interchange: 'Interchange', group: 'Functional group', transaction: S.m.standard === 'x12' ? 'Transaction set' : 'Message', hl: 'Hierarchical level', loop: 'Loop' }[n.kind]]];
    if (n.kind === 'file') {
      const s = S.m.summary;
      pairs.push(['Standard', `${s.standard} ${s.version || ''}`.trim()], ['Separators', sepText()], ['Encoding', S.m.encoding], ['Interchanges', s.interchanges], ['Groups', s.groups], [S.m.standard === 'x12' ? 'Transaction sets' : 'Messages', s.transactions]);
    }
    if (n.kind === 'interchange') pairs.push(['Control number', n.ctrl], ['Sender', n.from], ['Receiver', n.to], ['Date and time', n.date]);
    if (n.kind === 'group') pairs.push(['Control number', n.ctrl], ['Kind', n.sub]);
    if (n.kind === 'transaction') pairs.push(['Type', `${n.code} ${S.m.dict.sets[n.code] || ''}`.trim()], ['Control number', n.ctrl], ['Version', n.version]);
    pairs.push(['Segments', `${fmtInt(segN)} (lines ${fmtInt(S.m.segs.l[n.first] + 1)} to ${fmtInt(S.m.segs.l[n.last] + 1)})`]);
    const probs = S.m.problems.filter((p) => p.seg >= n.first && p.seg <= n.last);
    return h('div', { class: 'pad' },
      h('h2', {}, n.label, n.sub && n.kind !== 'group' ? h('span', { class: 'muted', text: ` ${n.sub}` }) : null),
      h('div', { class: 'tools' }, h('button', { class: 'btn small', onclick: () => revealNode(n) }, 'Show in text')),
      kv(pairs),
      probs.length ? h('h3', { text: `Problems (${fmtInt(probs.length)})` }) : null, problemList(probs));
  }
  function sepText() {
    const s = S.m.sep, show = (c) => (c === '\n' ? 'new line' : c === '\r' ? 'CR' : !c ? 'none' : `"${c}"`);
    return `element ${show(s.element)}, component ${show(s.component)}, segment ${show(s.segment)}${S.m.standard === 'x12' ? `, repetition ${show(s.repetition)}` : `, release ${show(s.release)}`}`;
  }
  function segDetail(i) {
    const tag = S.m.segs.t[i], d = dseg(tag), els = segEls(i), sep = S.m.sep;
    const rows = [];
    for (let k = 1; k < els.length; k++) {
      const ed = d && d.e && d.e[k - 1];
      const raw = els[k];
      const comps = splitRaw(raw, sep.component, sep.release);
      const name = ed ? ed[0] : '';
      if (comps.length > 1 && !(S.m.standard === 'x12' && tag === 'ISA')) {
        rows.push({ id: elemId(tag, k), name, value: '', k, head: true, req: ed && ed[1] });
        comps.forEach((c, ci) => {
          const cd = ed && ed[3] ? ed[3][ci] : null;
          const cname = cd ? (Array.isArray(cd) ? cd[0] : cd) : '';
          const table = cd ? (Array.isArray(cd) ? cd[1] : (ci === 0 ? ed[2] : '')) : (ci === 0 && ed && S.m.standard === 'edifact' ? ed[2] : '');
          const v = unesc(c, sep.release);
          rows.push({ id: `${elemId(tag, k)}-${ci + 1}`, name: cname, value: v, mean: table ? meaning(table, v) : undefined, k, c: ci + 1, sub: true });
        });
      } else {
        const v = unesc(raw, sep.release);
        rows.push({ id: elemId(tag, k), name, value: v, mean: ed && ed[2] ? meaning(ed[2], S.m.standard === 'edifact' ? comps[0] : v) : undefined, k, req: ed && ed[1] });
      }
    }
    const table = h('table', { class: 'els' }, h('thead', {}, h('tr', {}, h('th', { text: 'Element' }), h('th', { text: 'Name' }), h('th', { text: 'Value' }), h('th', { text: 'Meaning' }))),
      h('tbody', {}, ...rows.map((r) => h('tr', { class: (r.sub ? 'sub' : '') + (r.head ? ' head' : ''), title: 'Click to select it in the text', onclick: () => revealSeg(i, r.k, r.c) },
        h('td', { class: 'mono', text: r.id }), h('td', { text: (r.name || '') + (r.req ? ' *' : '') }), h('td', { class: 'mono val', text: r.value }), h('td', { text: r.mean || '' })))));
    const probs = S.probBySeg.get(i) || [];
    const owner = S.m.nodes[S.m.owner[i]];
    return h('div', { class: 'pad' },
      h('h2', {}, h('span', { class: 'tag', text: tag }), ` ${d ? d.n : 'Segment not in the dictionary'}`),
      d && d.d ? h('p', { class: 'muted', text: d.d }) : null,
      h('div', { class: 'tools' }, h('span', { class: 'muted', text: `Line ${fmtInt(S.m.segs.l[i] + 1)} · segment ${fmtInt(i + 1)}${owner && owner.id ? ` · in ${owner.label}` : ''}` }),
        h('button', { class: 'btn small', onclick: () => revealSeg(i) }, 'Show in text'),
        h('button', { class: 'btn small', onclick: () => post({ type: 'copy', what: 'the segment', text: segRaw(i) }) }, 'Copy')),
      problemList(probs),
      rows.length ? table : h('p', { class: 'muted', text: 'This segment has no elements.' }),
      rows.some((r) => r.req) ? h('p', { class: 'muted small', text: '* mandatory element' }) : null,
      h('pre', { class: 'raw', text: segRaw(i) }));
  }

  // ---------- segments table ----------
  function segmentsView() {
    const n = S.m.segs.t.length;
    const q = S.filter.trim().toLowerCase();
    let idx = [];
    if (!q) idx = null;
    else if (/^[a-z][a-z0-9]{1,2}$/.test(q)) { for (let i = 0; i < n; i++) if (S.m.segs.t[i].toLowerCase() === q || segRaw(i).toLowerCase().includes(q)) idx.push(i); }
    else for (let i = 0; i < n; i++) if (segRaw(i).toLowerCase().includes(q)) idx.push(i);
    const count = idx ? idx.length : n;
    const at = (k) => (idx ? idx[k] : k);
    const grid = 'grid-template-columns: 70px 70px 60px minmax(140px, 1fr) minmax(200px, 3fr)';
    const filter = h('input', { type: 'search', class: 'filter', placeholder: `Filter ${fmtInt(n)} segments (ID or text)`, 'aria-label': 'Filter segments', value: S.filter });
    let timer;
    filter.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { S.filter = filter.value; S.scroll.segs = 0; S.afterRender = () => { const f = document.querySelector('.filter'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }; render(); }, 150); });
    const head = h('div', { class: 'thead', style: grid }, ...['#', 'Line', 'ID', 'Name', 'Data'].map((c) => h('span', { class: 'th', text: c })));
    const list = virtualList(count, (k) => {
      const i = at(k), tag = S.m.segs.t[i], d = dseg(tag), probs = S.probBySeg.get(i);
      return h('div', { class: 'tr link' + (probs ? (probs.some((p) => p.sev === 'error') ? ' rbad' : ' rwarn') : ''), style: grid, 'data-seg': String(i), title: 'Show in the tree', onclick: () => selectSeg(i) },
        h('span', { class: 'td num', text: fmtInt(i + 1) }), h('span', { class: 'td num', text: fmtInt(S.m.segs.l[i] + 1) }), h('span', { class: 'td tag', text: tag }), h('span', { class: 'td', text: d ? d.n : '' }), h('span', { class: 'td mono', text: segRaw(i).slice(0, 300) }));
    }, 'segs');
    const status = h('span', { class: 'muted', text: idx ? `${fmtInt(count)} of ${fmtInt(n)} segments` : `${fmtInt(n)} segments` });
    const copy = h('button', { class: 'btn small', title: 'Copy the segments shown, one per line', onclick: () => { const out = []; for (let k = 0; k < Math.min(count, 200000); k++) out.push(segRaw(at(k))); post({ type: 'copy', what: plural(out.length, 'segment'), text: out.join('\n') }); } }, 'Copy');
    const prev = S.afterRender;
    S.afterRender = () => { if (prev) prev(); list.scrollTop = S.scroll.segs || 0; list._draw(); };
    return h('div', { class: 'tablewrap' }, h('div', { class: 'tools' }, filter, status, copy), head, list);
  }

  // ---------- problems ----------
  function problemsView() {
    const ps = S.m.problems;
    if (!ps.length) return h('div', { class: 'pad' }, h('h2', { text: 'No problems found' }), h('p', { class: 'muted', text: `Checked: ${S.m.standard === 'x12' ? 'ISA field widths, ISA/IEA, GS/GE and ST/SE control numbers and counts' : 'UNB/UNZ, UNG/UNE and UNH/UNT references and counts'}, segments that do not belong to their ${S.m.standard === 'x12' ? 'transaction set' : 'message'} type, and empty mandatory elements.` }));
    const grid = 'grid-template-columns: 80px 70px 60px minmax(240px, 1fr)';
    const head = h('div', { class: 'thead', style: grid }, ...['Severity', 'Line', 'Segment', 'Problem'].map((c) => h('span', { class: 'th', text: c })));
    const list = virtualList(ps.length, (k) => {
      const p = ps[k];
      return h('div', { class: 'tr link ' + p.sev, style: grid, title: p.msg, onclick: () => selectSeg(p.seg) },
        h('span', { class: 'td sev', text: p.sev === 'error' ? 'Error' : p.sev === 'warning' ? 'Warning' : 'Note' }), h('span', { class: 'td num', text: fmtInt(S.m.segs.l[p.seg] + 1) }), h('span', { class: 'td tag', text: S.m.segs.t[p.seg] || '' }), h('span', { class: 'td', text: p.msg }));
    }, 'probs');
    const prev = S.afterRender;
    S.afterRender = () => { if (prev) prev(); list.scrollTop = S.scroll.probs || 0; list._draw(); };
    const copy = h('button', { class: 'btn small', onclick: () => post({ type: 'copy', what: plural(ps.length, 'problem'), text: ps.map((p) => `${p.sev}\tline ${S.m.segs.l[p.seg] + 1}\t${S.m.segs.t[p.seg]}\t${p.msg}`).join('\n') }) }, 'Copy');
    return h('div', { class: 'tablewrap' }, h('div', { class: 'tools' }, h('span', { class: 'muted', text: `${plural(S.m.summary.errors, 'error')}, ${plural(S.m.summary.warnings, 'warning')}${ps.length >= 5000 ? ' (first 5,000 listed)' : ''}` }), copy), head, list);
  }

  // ---------- compare ----------
  function compareView() {
    const { result: r, nameA, nameB } = S.compare;
    const grid = 'grid-template-columns: 80px 64px 64px 70px minmax(240px, 1fr)';
    const head = h('div', { class: 'thead', style: grid }, ...['Change', nameA.slice(0, 12), nameB.slice(0, 12), 'Segment', 'Difference'].map((c) => h('span', { class: 'th', text: c, title: c })));
    const rows = r.rows;
    const list = virtualList(rows.length, (k) => {
      const x = rows[k];
      const what = x.kind === 'changed' ? x.diffs.map((d) => `${d.id}${d.name ? ` ${d.name}` : ''}: ${d.a || '(empty)'} → ${d.b || '(empty)'}`).join(' · ') : x.text;
      return h('div', { class: 'tr ' + x.kind, style: grid, title: what },
        h('span', { class: 'td', text: x.kind }), h('span', { class: 'td num', text: x.lineA ? fmtInt(x.lineA) : '' }), h('span', { class: 'td num', text: x.lineB ? fmtInt(x.lineB) : '' }), h('span', { class: 'td tag', text: x.tag }), h('span', { class: 'td mono', text: what }));
    }, 'cmp');
    const prev = S.afterRender;
    S.afterRender = () => { if (prev) prev(); list._draw(); };
    return h('div', { class: 'tablewrap' },
      h('div', { class: 'tools' }, h('b', { text: `${nameA} compared with ${nameB}` }),
        h('span', { class: 'muted', text: `${fmtInt(r.same)} the same, ${fmtInt(r.changed)} changed, ${fmtInt(r.added)} added, ${fmtInt(r.removed)} removed${r.ignoreControl ? ' (control numbers, dates and times ignored)' : ''}` }),
        h('button', { class: 'btn small', onclick: () => post({ type: 'saveCompare' }) }, 'Open as Markdown')),
      rows.length ? head : h('p', { class: 'pad muted', text: 'The files have the same segments.' }), rows.length ? list : null);
  }

  // ---------- messages ----------
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.pro) S.pro = m.pro;
    if (m.type === 'model') {
      S.m = m.model; S.name = m.name; S.tab = 'tree'; S.compare = null; S.filter = ''; S.scroll = {};
      index();
      render();
      post({ type: 'rendered' });
    } else if (m.type === 'error') {
      app.textContent = '';
      const notEdi = m.code === 'NOT_EDI';
      app.append(h('div', { class: 'pad' }, h('h2', { text: notEdi ? 'Not an EDI file' : m.code === 'TOO_LARGE' ? 'This file is too large for the viewer' : 'This file could not be read' }), h('p', { text: m.message }),
        notEdi ? h('p', { class: 'muted', text: 'EDI Viewer reads X12 files (they start with ISA) and EDIFACT files (they start with UNA or UNB).' }) : null,
        h('button', { class: 'btn', onclick: () => post({ type: 'openText' }) }, 'Open as text')));
      const foot = document.getElementById('zovo-footer'); if (foot) app.append(foot.content.cloneNode(true));
    } else if (m.type === 'compare') {
      S.compare = m; S.tab = 'compare'; render();
    } else if (m.type === 'pro') {
      if (S.m) render();
    } else if (m.type === 'notice') {
      const v = document.getElementById('view');
      if (v) v.prepend(h('div', { class: 'notice', text: m.text }));
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.m) render(); });
  window.addEventListener('resize', () => { if (S.m) render(); });
  post({ type: 'ready' });
}());
