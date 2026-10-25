// Spracuje GTFS dáta DPB do kompaktného JSON-u pre vyhľadávanie spojení v aplikácii.
// Spoje s rovnakou trasou sa zlúčia do "vzorov" (patterns) a časy sa ukladajú ako
// začiatok spoja + profil posunov, vďaka čomu je celá sieť len pár stoviek kB.
//
// Použitie:
//   node tools/build-data.mjs <gtfs_priečinok_1> [<gtfs_priečinok_2> ...]
// Priečinky = rozbalené GTFS feedy. Ak ich je viac, každý platí od svojho
// feed_start_date až po deň pred začiatkom nasledujúceho feedu.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// Domov: zastávka, na ktorú sa vyhľadáva. Súradnice sú zastávky (nie adresy),
// aby sa vo verejne dostupných dátach neobjavila presná adresa.
const HOME_STOP_NAME = 'Kaštieľ Rusovce';
const FOOTPATH_M = 300;          // prestup pešo medzi zastávkami do tejto vzdialenosti
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'data', 'network.json');

function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function readCsv(file, onRow) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!header) { header = parseCsvLine(line.replace(/^﻿/, '')); continue; }
    if (!line.trim()) continue;
    const vals = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => (row[h] = vals[i] ?? ''));
    onRow(row);
  }
}

const toSec = (t) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };
const ymdAddDays = (ymd, n) => {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + n));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
};
function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function readFeed(dir) {
  const f = { dir, info: {}, stops: new Map(), routes: new Map(), trips: new Map(), calendar: new Map(), calDates: [], stopTimes: new Map() };
  await readCsv(path.join(dir, 'feed_info.txt'), (r) => Object.assign(f.info, r));
  await readCsv(path.join(dir, 'stops.txt'), (r) => f.stops.set(r.stop_id, r));
  await readCsv(path.join(dir, 'routes.txt'), (r) => f.routes.set(r.route_id, r));
  await readCsv(path.join(dir, 'trips.txt'), (r) => f.trips.set(r.trip_id, r));
  await readCsv(path.join(dir, 'calendar.txt'), (r) => f.calendar.set(r.service_id, r));
  await readCsv(path.join(dir, 'calendar_dates.txt'), (r) => f.calDates.push(r));
  await readCsv(path.join(dir, 'stop_times.txt'), (r) => {
    let a = f.stopTimes.get(r.trip_id);
    if (!a) f.stopTimes.set(r.trip_id, (a = []));
    a.push([+r.stop_sequence, r.stop_id, toSec(r.departure_time || r.arrival_time)]);
  });
  return f;
}

const feedDirs = process.argv.slice(2);
if (!feedDirs.length) {
  console.error('Zadaj aspoň jeden priečinok s rozbaleným GTFS.');
  process.exit(1);
}

const feeds = [];
for (const d of feedDirs) {
  console.log('Čítam', d);
  feeds.push(await readFeed(d));
}
feeds.sort((a, b) => a.info.feed_start_date.localeCompare(b.info.feed_start_date));
feeds.forEach((f, i) => {
  f.validFrom = f.info.feed_start_date;
  f.validTo = feeds[i + 1] ? ymdAddDays(feeds[i + 1].info.feed_start_date, -1) : f.info.feed_end_date;
});

const out = {
  generated: new Date().toISOString(),
  validFrom: feeds[0].validFrom,
  validTo: feeds.at(-1).validTo,
  home: null,
  stops: [],      // [názov, nástupište, lat, lon]
  routes: [],     // [číslo linky, farba, farba textu, typ]
  services: [],   // [dni Po..Ne, od, do, [pridané dni], [zrušené dni]]
  patterns: [],   // [route, smer, [zastávky], [[posuny]...], [[profil, začiatok, služba]...]]
  footpaths: [],  // [z, do, metre]
};
const stopIdx = new Map(), routeIdx = new Map();

function getStop(s) {
  const key = `${s.stop_name}|${s.platform_code}|${(+s.stop_lat).toFixed(5)}|${(+s.stop_lon).toFixed(5)}`;
  if (!stopIdx.has(key)) {
    stopIdx.set(key, out.stops.length);
    out.stops.push([s.stop_name, s.platform_code || '', +(+s.stop_lat).toFixed(6), +(+s.stop_lon).toFixed(6)]);
  }
  return stopIdx.get(key);
}
function getRoute(r) {
  const key = `${r.route_short_name}|${r.route_color}|${r.route_type}`;
  if (!routeIdx.has(key)) {
    routeIdx.set(key, out.routes.length);
    out.routes.push([r.route_short_name, r.route_color || '0E5AA7', r.route_text_color || 'FFFFFF', +r.route_type]);
  }
  return routeIdx.get(key);
}

for (const f of feeds) {
  if (f.validTo < f.validFrom) continue; // feed úplne prekrytý novším
  const svcIdx = new Map();
  const getService = (id) => {
    if (svcIdx.has(id)) return svcIdx.get(id);
    const c = f.calendar.get(id);
    const days = c ? [c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday].join('') : '0000000';
    const start = c && c.start_date > f.validFrom ? c.start_date : f.validFrom;
    const end = c && c.end_date < f.validTo ? c.end_date : f.validTo;
    const inWin = (d) => d >= f.validFrom && d <= f.validTo;
    const add = f.calDates.filter((x) => x.service_id === id && x.exception_type === '1' && inWin(x.date)).map((x) => x.date);
    const rem = f.calDates.filter((x) => x.service_id === id && x.exception_type === '2' && inWin(x.date)).map((x) => x.date);
    svcIdx.set(id, out.services.length);
    out.services.push([days, start, end, add, rem]);
    return svcIdx.get(id);
  };

  const patIdx = new Map();
  let nTrips = 0;
  for (const [tripId, rows] of f.stopTimes) {
    const t = f.trips.get(tripId);
    if (!t || rows.length < 2) continue;
    rows.sort((a, b) => a[0] - b[0]);
    const stops = rows.map((r) => getStop(f.stops.get(r[1])));
    const route = getRoute(f.routes.get(t.route_id));
    const key = `${route}|${t.trip_headsign}|${stops.join(',')}`;
    let p = patIdx.get(key);
    if (p === undefined) {
      p = out.patterns.length;
      patIdx.set(key, p);
      out.patterns.push([route, t.trip_headsign, stops, [], []]);
    }
    const pat = out.patterns[p];
    const start = rows[0][2];
    const offs = rows.map((r) => r[2] - start);
    const offKey = offs.join(',');
    let prof = pat[3].findIndex((o) => o.join(',') === offKey);
    if (prof < 0) { prof = pat[3].length; pat[3].push(offs); }
    pat[4].push([prof, start, getService(t.service_id)]);
    nTrips++;
  }
  console.log(`  ${f.validFrom}–${f.validTo}: ${nTrips} spojov`);
}

for (const pat of out.patterns) pat[4].sort((a, b) => a[1] - b[1]);

// Pešie prestupy medzi blízkymi zastávkami
for (let i = 0; i < out.stops.length; i++) {
  for (let j = i + 1; j < out.stops.length; j++) {
    const [, , la1, lo1] = out.stops[i], [, , la2, lo2] = out.stops[j];
    const d = distM(la1, lo1, la2, lo2);
    if (d <= FOOTPATH_M) out.footpaths.push([i, j, Math.round(d)]);
  }
}

const homeStops = out.stops.map((s, i) => [s, i]).filter(([s]) => s[0] === HOME_STOP_NAME);
if (!homeStops.length) throw new Error(`Nenašiel som zastávku "${HOME_STOP_NAME}"`);
out.home = {
  name: HOME_STOP_NAME,
  lat: +(homeStops.reduce((a, [s]) => a + s[2], 0) / homeStops.length).toFixed(6),
  lon: +(homeStops.reduce((a, [s]) => a + s[3], 0) / homeStops.length).toFixed(6),
};

fs.writeFileSync(OUT, JSON.stringify(out));
const profiles = out.patterns.reduce((a, p) => a + p[3].length, 0);
console.log(`Hotovo: ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} kB) – zastávok ${out.stops.length}, liniek ${out.routes.length}, vzorov ${out.patterns.length}, profilov ${profiles}, prestupov ${out.footpaths.length}`);
