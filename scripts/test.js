'use strict';
// npm test: runs every test/*.test.js with the Node test runner. Temp files go to one fresh folder under the system
// temp folder (or EDI_TEST_TMP), removed at the end.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));
const tmp = fs.mkdtempSync(path.join(process.env.EDI_TEST_TMP || os.tmpdir(), 'edi-viewer-test-'));
const env = { ...process.env, TMPDIR: tmp, ZOVO_SPONSORS_MODULE: path.join(__dirname, '..', 'src', 'license', 'sponsors.js') };
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env });
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(r.status === null ? 1 : r.status);
