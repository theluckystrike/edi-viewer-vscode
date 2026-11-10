'use strict';
// Zovo Pro for EDI Viewer, on top of the shared license module (src/license, copied unchanged from
// factory/sprint/license). Three Pro tools, 3 free tries each on this computer. A try counts only after the tool
// produced its output (a saved file, a comparison on screen, a folder report); Escape or Cancel never uses one.
// Nothing about Pro shows on open or activation: the panel appears only after a click on a Pro tool with no tries left.
const { createLicense } = require('./license');

const SKU = 'edi-pro';
const TRIAL_USES = 3;
const TRIAL_KEY = 'ediViewer.proTrial';

const FEATURES = {
  export: {
    title: 'Export EDI to JSON or CSV',
    detail: 'Saves every transaction as a JSON tree with element names, or the line items (850, 810, 856, ORDERS, INVOIC, DESADV) as CSV for a spreadsheet.',
  },
  compare: {
    title: 'Compare two EDI files',
    detail: 'Lines up two files segment by segment and lists the added, removed and changed segments with the elements that differ. It can ignore control numbers, dates and times. Save the result as Markdown.',
  },
  check: {
    title: 'Validate a folder of EDI files',
    detail: 'Checks every X12 and EDIFACT file in a folder (envelopes, control numbers, counts, mandatory elements) and writes one report with the errors, warnings and trading partners of each file, as Markdown and CSV.',
  },
};
const TOOLS = Object.values(FEATURES).map((f) => f.title);

function createPro({ vscode, context, license, prefix = 'ediViewer', productName = 'EDI Viewer' }) {
  const emitter = new vscode.EventEmitter();
  const lic = license || createLicense({ vscode, context, sku: SKU, name: 'Zovo', product: productName, commandPrefix: prefix, proTools: TOOLS });
  if (lic.onDidChange) lic.onDidChange(() => emitter.fire(lic.isPro(SKU)));

  const used = (f) => Number((context.globalState.get(TRIAL_KEY) || {})[f]) || 0;
  const left = (f) => (FEATURES[f] ? Math.max(0, TRIAL_USES - used(f)) : 0);
  const licensed = () => lic.isPro(SKU);

  /** Before a Pro tool runs: true when it may run (licensed, or a free try left). Otherwise the one panel. */
  async function allowed(f) {
    if (licensed()) { if (lic.refresh) lic.refresh(); return true; }
    if (left(f) > 0) return true;
    const feat = FEATURES[f] || { title: 'This tool', detail: '' };
    return !!(await lic.requirePro(feat.title, { detail: feat.detail, triesUsed: used(f), tools: TOOLS }));
  }

  /** After the tool produced its output: counts one free try (nothing when licensed). */
  async function produced(f) {
    if (licensed() || !FEATURES[f]) return;
    const m = { ...(context.globalState.get(TRIAL_KEY) || {}) };
    m[f] = used(f) + 1;
    await context.globalState.update(TRIAL_KEY, m);
    const l = left(f);
    vscode.window.setStatusBarMessage(`Zovo Pro: free try ${used(f)} of ${TRIAL_USES} of "${FEATURES[f].title}" used${l ? `, ${l} left` : ''} on this computer.`, 8000);
    emitter.fire(false);
  }

  context.subscriptions.push(emitter);
  return {
    SKU, FEATURES, TRIAL_USES,
    get licensed() { return licensed(); },
    ready: lic.ready,
    allowed, produced, left,
    tries: () => Object.fromEntries(Object.keys(FEATURES).map((f) => [f, left(f)])),
    handleUri: (uri) => (lic.handleUri ? lic.handleUri(uri) : undefined),
    onDidChange: emitter.event,
    license: lic,
  };
}

module.exports = { createPro, FEATURES, SKU, TRIAL_USES, TRIAL_KEY, TOOLS };
