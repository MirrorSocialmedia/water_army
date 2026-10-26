// Download F-Droid APKs for the W2 E-matrix (real signed, real APK structure).
// Candidates: org.ligi.scoutcampsite (list/detail), eu.darken.swb (settings screens).
import fs from 'node:fs';
import { execSync } from 'node:child_process';
const DIR = '/var/lib/water-army/apk-rdev';
const PKGS = ['org.ligi.scoutcampsite', 'eu.darken.swb'];
fs.mkdirSync(DIR, { recursive: true });
for (const pkg of PKGS) {
  let j = null;
  try {
    const raw = execSync(`curl -s --max-time 30 "https://f-droid.org/api/v1/packages/${pkg}"`, { encoding: 'utf8' });
    j = JSON.parse(raw);
  } catch (e) { console.log(`${pkg}: API error ${e.message}`); continue; }
  if (!j?.apks?.length) { console.log(`${pkg}: no apk url`); continue; }
  const url = j.apks[0].downloadUrl;
  const fname = `${pkg}-${j.versionName ?? 'latest'}.apk`;
  console.log(`${pkg}: ${url}`);
  try {
    execSync(`curl -sfL --max-time 300 -o "${DIR}/${fname}" "${url}"`, { stdio: 'inherit' });
    const sz = fs.statSync(`${DIR}/${fname}`).size;
    const head = fs.readFileSync(`${DIR}/${fname}`).subarray(0, 4).toString('hex');
    const manifest = execSync(`cd "${DIR}" && unzip -l "${fname}" 2>/dev/null | grep -c "AndroidManifest.xml"`, { encoding: 'utf8' }).trim();
    console.log(`${fname}: ${sz}B magic=${head} manifestEntries=${manifest}`);
  } catch (e) { console.log(`${pkg}: download failed ${e.message}`); }
}
