// WA-BATCH-E2E-RERUN P2: 12/12 fingerprint comparison (p1-09 / oemprop s3-07b calibre).
// Usage: node p2-compare12.mjs <getprop-dump.txt> [label]
// Dump format: adb `getprop` raw output  [key]: [value]
import { readFileSync } from 'node:fs';

const P1 = {
  'ro.product.brand': 'motorola',
  'ro.product.manufacturer': 'Motorola',
  'ro.product.model': 'Redmi1BA',
  'ro.product.device': 'redmi-1ba',
  'ro.product.name': 'redmi-1ba',
  'ro.build.id': 'V9AB2GJ',
  'ro.build.display.id': '14.V9AB2GJ.Y2MKJ.keys',
  'ro.build.fingerprint': 'motorola/redmi-1ba/redmi-1barcqv23p7xy:14/V9AB2GJ/633188:userdebug/dev-keys',
  'ro.serialno': 'MOTO-616277-P6V8',
  'persist.sys.timezone': 'Asia/Tokyo',
  'ro.hardware': 'redmi-1ba',
  'ro.boot.hardware': 'redmi-1ba',
};

// Non-fingerprint stock props (must be UNCHANGED vs P1 old-image baseline, s3-07b calibre).
const BASELINE = {
  'init.svc.zygote': 'running',
  'ro.adb.secure': '0',
  'ro.build.tags': 'test-keys',
  'ro.build.type': 'userdebug',
  'ro.build.version.release': '14',
  'ro.build.version.sdk': '34',
  'ro.build.version.security_patch': '2024-05-05',
  'ro.debuggable': '1',
  'ro.product.cpu.abi': 'x86_64',
  'ro.build.description': 'redroid_x86_64-userdebug 14 UD2A.240505.001.W1 eng.frank.20240527.141332 test-keys',
  'ro.product.build.fingerprint': 'redroid/redroid_x86_64/redroid_x86_64:14/UD2A.240505.001.W1/frank05271411:userdebug/test-keys',
  'ro.system.build.fingerprint': 'redroid/redroid_x86_64/redroid_x86_64:14/UD2A.240505.001.W1/frank05271411:userdebug/test-keys',
  'ro.vendor.build.fingerprint': 'redroid/redroid_x86_64/redroid_x86_64:14/UD2A.240505.001.W1/frank05271411:userdebug/test-keys',
};

const raw = readFileSync(process.argv[2], 'utf8');
const props = {};
for (const line of raw.split('\n')) {
  const m = line.match(/^\[([^\]]+)\]: \[(.*)\]$/);
  if (m) props[m[1]] = m[2];
}
if (Object.keys(props).length < 100) {
  console.log('DUMP-MALFORMED: only ' + Object.keys(props).length + ' props parsed');
  process.exit(2);
}

const label = process.argv[3] ?? process.argv[2];
let ok = 0;
console.log(`=== 12/12 fingerprint targets (${label}, p1-09 calibre) ===`);
for (const [k, exp] of Object.entries(P1)) {
  const got = props[k];
  const pass = got === exp;
  if (pass) ok++;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${k}: got='${got ?? '<absent>'}' exp='${exp}'`);
}
console.log(`=> ${ok}/12`);

let b = 0;
console.log('');
console.log('=== non-fingerprint stock props (vs P1 old-image baseline, s3-07b calibre) ===');
for (const [k, exp] of Object.entries(BASELINE)) {
  const got = props[k];
  const pass = got === exp;
  if (pass) b++;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${k}: got='${got ?? '<absent>'}' exp='${exp}'`);
}
console.log(`=> ${b}/13 baseline-sampled props unchanged`);
process.exit(ok === 12 ? 0 : 1);
