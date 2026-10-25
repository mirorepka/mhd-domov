// Stiahne aktuálne GTFS dáta DPB, odloží ich do gtfs/ (ak sú nové), zmaže už neplatné
// a vyrobí app/data/network.json. Spúšťa ho GitHub Actions každý deň, dá sa aj ručne:
//   node tools/update-feeds.mjs
// Potrebuje príkaz `unzip`.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FEED_URL = 'https://www.arcgis.com/sharing/rest/content/items/aba12fd2cbac4843bc7406151bc66106/data';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GTFS = path.join(ROOT, 'gtfs');
const TMP = path.join(ROOT, 'tmp');

const feedInfo = (zip) => {
  const csv = execFileSync('unzip', ['-p', zip, 'feed_info.txt'], { encoding: 'utf8' }).replace(/^﻿/, '').trim().split(/\r?\n/);
  const head = csv[0].split(','), vals = csv[1].match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((v) => v.replace(/,$/, '').replace(/^"|"$/g, ''));
  return Object.fromEntries(head.map((h, i) => [h, vals[i]]));
};
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Bratislava' }).format(new Date()).replace(/-/g, '');

fs.mkdirSync(GTFS, { recursive: true });
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// 1) stiahnuť
try {
  const res = await fetch(FEED_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const tmpZip = path.join(TMP, 'new.zip');
  fs.writeFileSync(tmpZip, Buffer.from(await res.arrayBuffer()));
  const info = feedInfo(tmpZip);
  const name = `${info.feed_start_date}_${info.feed_version}.zip`;
  if (!fs.existsSync(path.join(GTFS, name))) {
    fs.copyFileSync(tmpZip, path.join(GTFS, name));
    console.log('Nový cestovný poriadok:', name);
  } else console.log('Cestovný poriadok sa nezmenil:', name);
} catch (e) {
  console.warn('Sťahovanie zlyhalo, použijem uložené dáta:', e.message);
}

// 2) upratať: pre každý dátum začiatku najnovšiu verziu; z už platných len najnovší
let zips = fs.readdirSync(GTFS).filter((f) => f.endsWith('.zip')).sort();
const byStart = new Map();
for (const z of zips) byStart.set(z.split('_')[0], z); // zoradené → posledná verzia vyhrá
const keep = new Set();
const starts = [...byStart.keys()].sort();
const current = starts.filter((s) => s <= today).at(-1);
for (const s of starts) if (s >= (current ?? '')) keep.add(byStart.get(s));
for (const z of zips) if (!keep.has(z)) { fs.rmSync(path.join(GTFS, z)); console.log('Mažem starý:', z); }
zips = [...keep].sort();
if (!zips.length) throw new Error('Žiadne GTFS dáta.');

// 3) rozbaliť a postaviť
const dirs = zips.map((z) => {
  const dir = path.join(TMP, z.replace('.zip', ''));
  execFileSync('unzip', ['-q', '-o', path.join(GTFS, z), '-d', dir]);
  return dir;
});
execFileSync(process.execPath, ['--max-old-space-size=4096', path.join(ROOT, 'tools', 'build-data.mjs'), ...dirs], { stdio: 'inherit' });
fs.rmSync(TMP, { recursive: true, force: true });
