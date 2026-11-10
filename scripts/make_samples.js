'use strict';
// Writes the walkthrough samples (made-up partners and values) from test/fixtures.js.
const fs = require('fs');
const path = require('path');
const F = require('../test/fixtures');
const dir = path.join(__dirname, '..', 'samples');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'sample-850-purchase-order.edi'), F.x12(['850', '850', '855'], { ctrl: 101 }).replace('PO-1001', 'PO-1001').replace(/ST\*850\*0002~\nBEG\*00\*SA\*PO-1001/, 'ST*850*0002~\nBEG*00*SA*PO-1002'));
fs.writeFileSync(path.join(dir, 'sample-837p-claim.x12'), F.x12(['837P'], { ctrl: 202 }));
fs.writeFileSync(path.join(dir, 'sample-orders.edifact'), F.edifact(['ORDERS', 'ORDERS']).replace(/(UNH\+2\+ORDERS[^\n]*\nBGM\+220\+)PO-1001/, '$1PO-1003'));
for (const f of fs.readdirSync(dir)) console.log(f, fs.statSync(path.join(dir, f)).size);
