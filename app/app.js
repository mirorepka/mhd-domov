'use strict';

const WALK_M_PER_SEC = 1.0;    // detský krok
const DETOUR = 1.3;            // vzdušná čiara → reálna cesta
const AT_STOP_M = 40;
const AT_HOME_M = 500;         // bližšie než toto sa domov oplatí ísť pešo
const ORIGIN_RADIUS_M = 1200;  // z akej vzdialenosti môže ísť dieťa pešo na zastávku
const HOME_RADIUS_M = 700;     // z ktorých zastávok sa dá dôjsť pešo domov
const MAX_TRIPS = 4;           // max. počet vozidiel (= 3 prestupy)
const TRANSFER_SLACK = 60;     // rezerva na prestup na tej istej zastávke [s]
const TRANSFER_PENALTY = 300;  // radšej o 5 min neskôr, ale s menej prestupmi
const WINDOW_H = 10;           // ako ďaleko dopredu hľadať spoje
const OPTIONS = 4;             // koľko možností ukázať

const $ = (id) => document.getElementById(id);
const state = { data: null, groups: [], pos: null, manual: null, watchId: null, locError: null };
const net = { stopRoutes: null, foot: null, homeCands: null, cacheKey: null, active: null, mid0: 0 };

// ---------- pomocné ----------
function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const walkSec = (m) => (m * DETOUR) / WALK_M_PER_SEC;
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const hhmm = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
function dayHhmm(d, now) {
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
  return (diff === 1 ? 'zajtra ' : '') + hhmm(d);
}
const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function minWord(n) {
  if (n === 1) return 'minútu';
  if (n >= 2 && n <= 4) return 'minúty';
  return 'minút';
}
function stopWord(n) {
  if (n === 1) return 'zastávke';
  return 'zastávkach';
}
const fold = (s) => s.toLocaleLowerCase('sk').normalize('NFD').replace(/\p{M}/gu, '');
const relToDate = (rel) => new Date(net.mid0 + rel * 1000);

function serviceRuns(svc, date) {
  const [days, start, end, add, rem] = svc;
  const d = ymd(date);
  if (rem.includes(d)) return false;
  if (add.includes(d)) return true;
  if (d < start || d > end) return false;
  return days[(date.getDay() + 6) % 7] === '1';
}

// ---------- sieť ----------
function prepareNetwork(data) {
  const n = data.stops.length;
  net.stopRoutes = Array.from({ length: n }, () => []);
  data.patterns.forEach((p, pi) => p[2].forEach((s, i) => net.stopRoutes[s].push(pi, i)));
  net.foot = Array.from({ length: n }, () => []);
  for (const [a, b, m] of data.footpaths) {
    const sec = walkSec(m) + 60;
    net.foot[a].push(b, sec);
    net.foot[b].push(a, sec);
  }
  setDestination(null);
}

// Cieľ: null = domov, inak { name, lat, lon }. Pripraví zastávky, z ktorých sa do cieľa dôjde pešo.
function setDestination(dest) {
  const { data } = state;
  state.dest = dest;
  const d = currentDest();
  const all = data.stops.map(([, , lat, lon], i) => [i, distM(lat, lon, d.lat, d.lon)]).sort((a, b) => a[1] - b[1]);
  net.homeCands = all.filter(([, m], j) => m <= HOME_RADIUS_M || j < 3).map(([i, m]) => [i, walkSec(m), m]);
  $('destName').textContent = d.home ? '🏠 Domov' : `🏁 ${d.name}`;
  $('destHome').classList.toggle('hidden', d.home);
}
const currentDest = () => state.dest || { name: 'Domov', lat: state.data.home.lat, lon: state.data.home.lon, home: true };

// Spoje, ktoré jazdia v okne [teraz, teraz + WINDOW_H]; časy v sekundách od dnešnej polnoci.
function activeTrips(now) {
  const key = `${ymd(now)}-${now.getHours()}-${Math.floor(now.getMinutes() / 10)}`;
  if (net.cacheKey === key) return net.active;
  const { data } = state;
  const mid0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const nowRel = (now.getTime() - mid0) / 1000 - 600;
  const until = nowRel + WINDOW_H * 3600;
  const days = [-1, 0, 1].map((off) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + off);
    return { base: (date.getTime() - mid0) / 1000, runs: data.services.map((s) => serviceRuns(s, date)) };
  });
  net.active = data.patterns.map(([, , stops, profs, trips]) => {
    const out = [];
    for (const { base, runs } of days) {
      for (const [prof, start, svc] of trips) {
        if (!runs[svc]) continue;
        const st = base + start;
        if (st > until || st + profs[prof][stops.length - 1] < nowRel) continue;
        out.push([st, prof]);
      }
    }
    return out.sort((a, b) => a[0] - b[0]);
  });
  net.mid0 = mid0;
  net.cacheKey = key;
  return net.active;
}

// RAPTOR: najskorší príchod s 1..MAX_TRIPS vozidlami.
function raptor(origins, act) {
  const { patterns, stops } = state.data;
  const n = stops.length;
  const tau = [new Float64Array(n).fill(Infinity)];
  const lab = [new Map()];
  const best = new Float64Array(n).fill(Infinity);
  let marked = new Set();
  for (const [s, t, m] of origins) {
    if (t < tau[0][s]) { tau[0][s] = t; best[s] = t; lab[0].set(s, { o: m }); marked.add(s); }
  }
  for (let k = 1; k <= MAX_TRIPS && marked.size; k++) {
    const prev = tau[k - 1], prevLab = lab[k - 1];
    const cur = new Float64Array(n).fill(Infinity), curLab = new Map();
    tau.push(cur); lab.push(curLab);
    const Q = new Map();
    for (const s of marked) {
      const sr = net.stopRoutes[s];
      for (let j = 0; j < sr.length; j += 2) {
        const q = Q.get(sr[j]);
        if (q === undefined || sr[j + 1] < q) Q.set(sr[j], sr[j + 1]);
      }
    }
    marked = new Set();
    for (const [pi, pos] of Q) {
      const trips = act[pi];
      if (!trips.length) continue;
      const pStops = patterns[pi][2], profs = patterns[pi][3];
      let ti = -1, board = -1;
      for (let i = pos; i < pStops.length; i++) {
        const s = pStops[i];
        if (ti >= 0) {
          const arr = trips[ti][0] + profs[trips[ti][1]][i];
          if (arr < best[s]) {
            cur[s] = arr; best[s] = arr;
            curLab.set(s, { p: pi, t: ti, b: board, a: i });
            marked.add(s);
          }
        }
        if (prev[s] < Infinity) {
          const ready = prev[s] + (prevLab.get(s)?.p !== undefined ? TRANSFER_SLACK : 0);
          let bestDep = ti >= 0 ? trips[ti][0] + profs[trips[ti][1]][i] : Infinity;
          if (ready < bestDep) {
            for (let x = 0; x < trips.length; x++) {
              const dep = trips[x][0] + profs[trips[x][1]][i];
              if (dep >= ready && dep < bestDep) { bestDep = dep; ti = x; board = i; }
            }
          }
        }
      }
    }
    for (const s of [...marked]) {
      if (curLab.get(s)?.p === undefined) continue;
      const f = net.foot[s];
      for (let j = 0; j < f.length; j += 2) {
        const nb = f[j], arr = cur[s] + f[j + 1];
        if (arr < best[nb]) { cur[nb] = arr; best[nb] = arr; curLab.set(nb, { w: s }); marked.add(nb); }
      }
    }
  }
  return { tau, lab };
}

function bestJourney(origins, act) {
  const { tau, lab } = raptor(origins, act);
  let pick = null;
  for (let k = 1; k < tau.length; k++) {
    for (const [s, w, m] of net.homeCands) {
      if (!lab[k].has(s)) continue;
      const arr = tau[k][s] + w;
      const score = arr + TRANSFER_PENALTY * (k - 1);
      if (!pick || score < pick.score) pick = { k, s, arr, score, m };
    }
  }
  if (!pick) return null;

  const { patterns, stops } = state.data;
  const legs = [];
  let { k, s } = pick;
  while (k > 0) {
    const L = lab[k].get(s);
    if (L.w !== undefined) {
      legs.unshift({ walk: true, from: L.w, to: s });
      s = L.w;
      continue;
    }
    const pat = patterns[L.p], trip = act[L.p][L.t], prof = pat[3][trip[1]];
    legs.unshift({
      route: state.data.routes[pat[0]], headsign: pat[1],
      from: pat[2][L.b], to: pat[2][L.a], stopsCount: L.a - L.b,
      dep: trip[0] + prof[L.b], arr: trip[0] + prof[L.a],
    });
    s = pat[2][L.b];
    k--;
  }
  const originWalkM = lab[0].get(s).o;
  const first = legs.find((l) => !l.walk);
  return {
    origin: s, originWalkM, legs, home: pick.arr, homeStop: stops[pick.s], destWalkM: pick.m,
    transfers: pick.k - 1, leave: first.dep - walkSec(originWalkM),
  };
}

function originsFor(group, startRel) {
  if (group) return group.platforms.map((p) => [p.idx, startRel, 0]);
  const { stops } = state.data;
  const list = stops.map(([, , lat, lon], i) => [i, distM(state.pos.lat, state.pos.lon, lat, lon)]).sort((a, b) => a[1] - b[1]);
  const near = list.filter(([, d], j) => d <= ORIGIN_RADIUS_M || j < 3);
  return near.map(([i, d]) => [i, startRel + walkSec(d), d]);
}

function journeys(now) {
  const act = activeTrips(now);
  const group = state.manual ? state.groups.find((g) => g.name === state.manual) : null;
  let start = (now.getTime() - net.mid0) / 1000;
  const out = [];
  for (let i = 0; i < OPTIONS * 3 && out.length < OPTIONS; i++) {
    const j = bestJourney(originsFor(group, start), act);
    if (!j) break;
    const sig = j.legs.filter((l) => !l.walk).map((l) => `${l.route[0]}@${l.dep}`).join('|');
    const last = out.at(-1);
    // Rovnaký príchod domov, ale neskorší odchod = menej čakania → nahradí predchádzajúci
    if (last && j.home <= last.home && j.transfers <= last.transfers) out[out.length - 1] = Object.assign(j, { sig });
    else if (last && j.home <= last.home) { /* rovnako skoro, ale viac prestupov → nezobrazujeme */ }
    else if (!out.some((o) => o.sig === sig)) out.push(Object.assign(j, { sig }));
    start = j.leave + 60;
  }
  return out;
}

// ---------- vykreslenie ----------
function badge(route, small) {
  const [name, color, text] = route;
  return `<span class="badge${small ? ' sm' : ''}" style="background:#${esc(color)};color:#${esc(text)}">${esc(name)}</span>`;
}
const vehicle = (route) => ({ 0: 'električky', 11: 'trolejbusu', 800: 'trolejbusu' }[route[3]] || 'autobusu');
const stopLabel = (idx, withPlatform = true) => {
  const [name, platform] = state.data.stops[idx];
  return `<b>${esc(name)}</b>${withPlatform && platform ? ` <span class="sub">(nást. ${esc(platform)})</span>` : ''}`;
};

function renderSteps(j, now) {
  const rides = j.legs.filter((l) => !l.walk);
  let html = '<ol class="steps">';
  j.legs.forEach((l, i) => {
    if (l.walk) {
      html += `<li class="walk">🚶 Prejdi pešo na zastávku ${stopLabel(l.to)}</li>`;
      return;
    }
    const last = l === rides.at(-1);
    html += `<li>${badge(l.route, true)}<div>
      Nastúp do ${vehicle(l.route)} <b>${esc(l.route[0])}</b> o <b>${dayHhmm(relToDate(l.dep), now)}</b>
      na zastávke ${stopLabel(l.from)} <span class="sub">smer ${esc(l.headsign)}</span><br>
      Vystúp ${last ? '' : `o ${hhmm(relToDate(l.arr))} `}na zastávke ${stopLabel(l.to, false)} <span class="sub">po ${l.stopsCount} ${stopWord(l.stopsCount)}</span>
      ${last ? '' : '<div class="change">🔁 tu prestúp</div>'}</div></li>`;
  });
  const dest = currentDest();
  if (j.destWalkM > 150 && !dest.home) {
    const m = Math.max(1, Math.round(walkSec(j.destWalkM) / 60));
    html += `<li class="walk">🚶 Dôjdi pešo do cieľa – asi ${fmtDist(j.destWalkM)}, ${m} ${minWord(m)}</li>`;
  }
  return html + `<li class="homeStep">${dest.home ? '🏠 Doma' : `🏁 ${esc(dest.name)}`} o <b>${hhmm(relToDate(j.home))}</b></li></ol>`;
}

function render() {
  const main = $('main');
  const { data } = state;
  if (!data) return;
  const now = new Date();

  if (!state.manual && !state.pos) {
    main.innerHTML = state.locError ? locationCard()
      : `<section class="card"><p class="big">Hľadám, kde si… 📍</p>
        <p class="muted">Ak sa ťa telefón opýta na polohu, klikni na <b>Povoliť</b>.</p></section>`;
    return;
  }
  const dest = currentDest();
  const arriveTxt = dest.home ? 'doma o' : 'v cieli o';
  if (!state.manual && distM(state.pos.lat, state.pos.lon, dest.lat, dest.lon) < AT_HOME_M) {
    main.innerHTML = dest.home
      ? `<section class="card"><p class="big">Si doma alebo blízko domu 🏠</p>
        <p class="muted">Domov to máš pešo. Keď budeš ďalej, ukážem ti, ako sa dostaneš domov.</p></section>`
      : `<section class="card"><p class="big">Si blízko cieľa 🏁</p>
        <p class="muted">Do cieľa <b>${esc(dest.name)}</b> to máš pešo.</p></section>`;
    return;
  }

  const list = journeys(now);
  const first = list[0];
  if (!first) {
    main.innerHTML = `<section class="card"><p class="big">Teraz odtiaľto nejde nič ${dest.home ? 'domov' : 'do cieľa'} 😴</p>
      <p class="muted">Zavolaj mamine alebo ockovi.</p></section>`;
    return;
  }

  const nowRel = (now.getTime() - net.mid0) / 1000;
  const firstRide = first.legs.find((l) => !l.walk);
  const atStop = state.manual || first.originWalkM < AT_STOP_M;
  const depMin = Math.max(0, Math.round((firstRide.dep - nowRel) / 60));
  const leaveMin = Math.round((first.leave - nowRel) / 60);
  const walkMin = Math.max(1, Math.round(walkSec(first.originWalkM) / 60));

  const where = atStop
    ? `<p class="muted" style="margin:0">${state.manual ? 'Si na zastávke' : 'Si na zastávke ✅'}</p><p class="stop-name">${esc(data.stops[first.origin][0])}</p>`
    : `<p class="muted" style="margin:0">Choď na zastávku</p><p class="stop-name">${esc(data.stops[first.origin][0])}</p>
       <p class="stop-meta">${fmtDist(first.originWalkM)} · pešo asi ${walkMin} ${minWord(walkMin)}</p>`;

  const whenTxt = depMin <= 0 ? 'teraz!' : depMin < 60 ? `o ${depMin} min` : dayHhmm(relToDate(firstRide.dep), now);
  let pill;
  if (depMin >= 60) pill = ['warn', `Najbližší spoj ide až ${dayHhmm(relToDate(firstRide.dep), now)}`];
  else if (atStop) pill = depMin <= 1 ? ['bad', 'Už ide! Nastúp 🚌'] : ['ok', `Počkaj na zastávke, ide o ${depMin} ${minWord(depMin)}`];
  else if (leaveMin <= 1) pill = ['bad', 'Utekaj! 🏃 Musíš ísť hneď'];
  else if (leaveMin <= 5) pill = ['warn', `Vyraz o ${leaveMin} ${minWord(leaveMin)} ⏰`];
  else pill = ['ok', `Máš čas ešte ${leaveMin} ${minWord(leaveMin)} 😊`];

  const transfersTxt = first.transfers === 0 ? 'bez prestupu' : first.transfers === 1 ? '1 prestup' : `${first.transfers} prestupy`;
  let html = `<section class="card">${where}
    <div class="next">${badge(firstRide.route)}
      <div><div class="when">${whenTxt}</div>
      <div class="sub">odchod ${dayHhmm(relToDate(firstRide.dep), now)} · ${transfersTxt}</div>
      <div class="sub"><b>${arriveTxt} ${hhmm(relToDate(first.home))}</b></div></div></div>
    <div class="pill ${pill[0]}">${pill[1]}</div>
    ${renderSteps(first, now)}</section>`;

  const rest = list.slice(1);
  if (rest.length) {
    html += `<section class="card"><h2>Ďalšie možnosti</h2><ul class="later">` +
      rest.map((j) => {
        const rides = j.legs.filter((l) => !l.walk);
        const chain = rides.map((l) => badge(l.route, true)).join('<span class="arrow">→</span>');
        return `<li><span class="chain">${chain}</span>
          <span>z ${esc(state.data.stops[rides[0].from][0])}<br><span class="sub">${arriveTxt} ${hhmm(relToDate(j.home))}</span></span>
          <span class="t">${dayHhmm(relToDate(rides[0].dep), now)}</span></li>`;
      }).join('') + `</ul></section>`;
  }
  if (ymd(now) > data.validTo) {
    html += `<section class="card"><p class="pill warn">Cestovný poriadok je starý – treba ho aktualizovať.</p></section>`;
  }
  // Aj keď si vybral zastávku ručne, stále ho prosíme o povolenie polohy
  main.innerHTML = (state.locError && !state.pos ? locationCard() : '') + html;
}

function locationCard() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const edge = /Edg(e|A|iOS)?\//.test(ua);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const browser = edge ? 'Microsoft Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : ios ? 'Safari' : 'Chrome';
  const { code } = state.locError;
  let title, steps;
  if (code === 0) {
    title = 'Tento prehliadač nevie zistiť polohu';
    steps = ['Otvor stránku v <b>Chrome</b> alebo <b>Safari</b>'];
  } else if (ios) {
    title = code === 1 ? 'Povoľ, prosím, polohu 📍' : 'Neviem nájsť, kde si 📍';
    steps = [
      'Otvor <b>Nastavenia</b> v telefóne → <b>Súkromie a bezpečnosť</b> → <b>Polohové služby</b> a zapni ich',
      browser === 'Safari'
        ? 'V tom istom zozname ťukni na <b>Webové stránky Safari</b> → <b>Pri používaní apky</b>'
        : `V tom istom zozname nájdi <b>${browser}</b> → <b>Pri používaní apky</b>`,
      browser === 'Safari' && !standalone
        ? 'V Safari ťukni vľavo v adrese na <b>aA</b> → <b>Nastavenia webovej stránky</b> → <b>Poloha</b> → <b>Povoliť</b>'
        : 'Vráť sa sem a ťukni na tlačidlo nižšie',
    ];
  } else if (android) {
    title = code === 1 ? 'Povoľ, prosím, polohu 📍' : 'Neviem nájsť, kde si 📍';
    steps = [
      'Potiahni prstom zhora a zapni <b>Poloha</b>',
      `Otvor <b>Nastavenia</b> telefónu → <b>Aplikácie</b> → <b>${standalone ? `Bus domov</b> (alebo <b>${browser}` : browser}</b>) → <b>Povolenia</b> → <b>Poloha</b> → <b>Povoliť len pri používaní</b>`.replace(' ()', ''),
      edge
        ? 'V Edgi ťukni dole na <b>☰</b> (alebo <b>⋯</b>) → <b>Nastavenia</b> → <b>Ochrana osobných údajov a zabezpečenie</b> → <b>Povolenia lokality</b> → <b>Poloha</b> a povoľ ju (ak je tam <b>mhd.repka.sk</b> zablokovaná, ťukni na ňu a zmeň na <b>Povoliť</b>)'
        : 'V prehliadači ťukni na ikonku <b>vľavo od adresy</b> (🔒 alebo ⚙️) → <b>Povolenia</b> → <b>Poloha</b> → <b>Povoliť</b>',
      'Vráť sa sem a ťukni na tlačidlo nižšie',
    ];
  } else {
    // počítač (Windows / Mac)
    title = code === 1 ? 'Povoľ, prosím, polohu 📍' : 'Neviem nájsť, kde si 📍';
    steps = [
      'Ťukni na ikonku <b>vľavo od adresy</b> (🔒) → <b>Povolenia pre túto lokalitu</b> → <b>Poloha</b> → <b>Povoliť</b>',
      'Vo Windows otvor <b>Nastavenia</b> → <b>Ochrana osobných údajov a zabezpečenie</b> → <b>Poloha</b> a zapni <b>Služby určovania polohy</b> aj <b>Povoliť aplikáciám pre počítač prístup k polohe</b>',
      'Potom stránku obnov (F5) a ťukni na tlačidlo nižšie',
    ];
  }
  const again = state.locAttempts > 0 && !state.locTrying
    ? '<p class="pill warn">Stále to nejde 😕 Skús kroky vyššie – hlavne povolenie polohy pre prehliadač v nastaveniach zariadenia.</p>' : '';
  return `<section class="card locask"><p class="big">${title}</p>
    <p class="muted">Bez polohy neviem, ktorá zastávka je pri tebe najbližšie.</p>
    <ol class="ios-steps">${steps.map((x) => `<li>${x}</li>`).join('')}</ol>
    ${again}
    <button class="btn wide" data-act="loc" ${state.locTrying ? 'disabled' : ''}>${state.locTrying ? '⏳ Skúšam…' : '📍 Povoliť polohu'}</button>
    ${state.manual ? '' : '<p class="muted tiny">Alebo dole ťukni na <b>🚏 Som na inej zastávke</b> a vyber ju sám.</p>'}
    <p class="muted tiny">${esc(browser)} · kód ${code}${state.locError.msg ? ` · ${esc(state.locError.msg)}` : ''}</p></section>`;
}

// ---------- výber zastávky ----------
function buildGroups(data) {
  const byName = new Map();
  data.stops.forEach(([name, platform, lat, lon], idx) => {
    let g = byName.get(name);
    if (!g) byName.set(name, (g = { name, platforms: [] }));
    g.platforms.push({ idx, platform, lat, lon });
  });
  return [...byName.values()];
}

function groupDistance(g) {
  if (!state.pos) return null;
  return Math.min(...g.platforms.map((p) => distM(state.pos.lat, state.pos.lon, p.lat, p.lon)));
}

function renderPicker() {
  const q = fold($('search').value.trim());
  const items = state.groups
    .filter((g) => g.name !== state.data.home.name && (!q || fold(g.name).includes(q)))
    .map((g) => ({ g, d: groupDistance(g) }))
    .sort((a, b) => (a.d ?? 0) - (b.d ?? 0) || a.g.name.localeCompare(b.g.name, 'sk'))
    .slice(0, 60);
  $('stopList').innerHTML = items
    .map(({ g, d }) => `<li><button data-name="${esc(g.name)}"><span>${esc(g.name)}</span><span class="d">${d === null ? '' : fmtDist(d)}</span></button></li>`)
    .join('');
}

// ---------- výber cieľa ----------
const RECENT_KEY = 'recentDest';
function recentDests() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
}
function rememberDest(d) {
  const list = [d, ...recentDests().filter((x) => x.name !== d.name)].slice(0, 5);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* nevadí */ }
}

let placeTimer = null, placeSeq = 0;
function renderDestPicker() {
  const raw = $('destSearch').value.trim();
  const q = fold(raw);
  const items = [];
  if (!q) {
    items.push({ icon: '🏠', name: 'Domov', home: true });
    recentDests().forEach((d) => items.push({ icon: '🕘', ...d }));
  } else {
    state.groups
      .filter((g) => fold(g.name).includes(q))
      .sort((a, b) => fold(a.name).indexOf(q) - fold(b.name).indexOf(q) || a.name.localeCompare(b.name, 'sk'))
      .slice(0, 6)
      .forEach((g) => items.push({
        icon: '🚏', name: g.name, sub: 'zastávka',
        lat: g.platforms.reduce((a, p) => a + p.lat, 0) / g.platforms.length,
        lon: g.platforms.reduce((a, p) => a + p.lon, 0) / g.platforms.length,
      }));
  }
  state.destItems = items;
  const list = $('destList');
  list.innerHTML = items.map((it, i) => `<li><button data-i="${i}"><span>${it.icon} ${esc(it.name)}</span><span class="d">${esc(it.sub || '')}</span></button></li>`).join('');

  // Miesta a adresy (OpenStreetMap) – až keď dopíše aspoň 3 znaky
  clearTimeout(placeTimer);
  if (raw.length < 3) return;
  list.insertAdjacentHTML('beforeend', '<li class="muted" id="placeLoading">Hľadám miesta…</li>');
  const seq = ++placeSeq;
  placeTimer = setTimeout(async () => {
    let found = [];
    try {
      const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=sk&countrycodes=sk'
        + '&viewbox=16.94,48.27,17.36,47.98&bounded=1&q=' + encodeURIComponent(raw);
      found = await (await fetch(url)).json();
    } catch { /* bez internetu */ }
    if (seq !== placeSeq) return;
    $('placeLoading')?.remove();
    const base = state.destItems.length;
    const places = [];
    for (const r of found) {
      const parts = r.display_name.split(', ');
      const p = { icon: '📍', name: r.name || parts.slice(0, 2).join(' '), sub: parts.slice(r.name ? 1 : 2, 3).join(', '), lat: +r.lat, lon: +r.lon };
      // rovnaké miesto viackrát (napr. budova aj parkovisko) → stačí raz
      if (!places.some((x) => x.name === p.name && distM(x.lat, x.lon, p.lat, p.lon) < 400)) places.push(p);
    }
    state.destItems.push(...places);
    list.insertAdjacentHTML('beforeend', places.length
      ? places.map((it, i) => `<li><button data-i="${base + i}"><span>${it.icon} ${esc(it.name)}</span><span class="d">${esc(it.sub)}</span></button></li>`).join('')
      : (state.destItems.length ? '' : '<li class="muted">Nič som nenašiel. Skús napísať inak.</li>'));
  }, 600);
}

function openDestPicker() {
  $('destPicker').classList.remove('hidden');
  $('destSearch').value = '';
  renderDestPicker();
  $('destSearch').focus();
}

// ---------- poloha ----------
// Pri chybe "nedostupná" skúsime ešte menej presnú polohu (Wi-Fi / sieť) – pomáha na počítačoch a v Edgi.
function startLocation(highAccuracy = true) {
  if (!('geolocation' in navigator)) {
    state.locError = { code: 0 };
    render();
    return;
  }
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.locPending = true;
  const token = (state.locToken = (state.locToken || 0) + 1);
  state.watchId = navigator.geolocation.watchPosition(
    (p) => {
      state.locPending = false;
      state.locTrying = false;
      state.pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
      state.locError = null;
      render();
    },
    (e) => {
      if (token !== state.locToken) return; // starší pokus
      if (state.pos && e.code !== 1) return; // poloha už je, len chvíľu neprišla nová
      if (e.code !== 1 && highAccuracy) { startLocation(false); return; }
      state.locPending = false;
      // tlačidlo nech chvíľu ukazuje "Skúšam…", aby obrazovka len nepreblikla
      const show = () => { state.locTrying = false; state.locError = { code: e.code, msg: e.message }; render(); };
      if (state.locTrying) setTimeout(show, 1200); else show();
    },
    { enableHighAccuracy: highAccuracy, maximumAge: 60000, timeout: highAccuracy ? 15000 : 30000 }
  );
}

// ---------- inštalácia aplikácie ----------
function setupInstall() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let dismissed = false;
  try { dismissed = sessionStorage.getItem('installLater') === '1'; } catch { /* súkromné okno */ }
  if (standalone || dismissed) return;

  const box = $('install'), btn = $('installBtn'), later = $('installLater');
  const hide = () => box.classList.add('hidden');
  const showSteps = (steps) => {
    $('installText').innerHTML = `Budeš ju mať na ploche ako ostatné aplikácie:<ol class="ios-steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>`;
    btn.classList.add('hidden');
    later.textContent = 'Rozumiem';
    box.classList.remove('hidden');
  };
  later.onclick = () => {
    hide();
    try { sessionStorage.setItem('installLater', '1'); } catch { /* nevadí */ }
  };

  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    $('installText').textContent = 'Budeš ju mať na ploche ako ostatné aplikácie a pôjde aj bez internetu.';
    btn.classList.remove('hidden');
    later.textContent = 'Neskôr';
    box.classList.remove('hidden');
  });
  btn.onclick = async () => {
    if (!deferred) return;
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    deferred = null;
    if (outcome === 'accepted') hide();
  };
  window.addEventListener('appinstalled', hide);

  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) {
    showSteps(['Dole ťukni na <b>Zdieľať</b> (štvorček so šípkou ⬆️)', 'Vyber <b>Pridať na plochu</b>', 'Ťukni na <b>Pridať</b>']);
  } else if (matchMedia('(pointer: coarse)').matches) {
    // Prehliadač bez inštalačného okna (napr. Firefox) – návod cez menu
    setTimeout(() => {
      if (!deferred) showSteps(['Ťukni na menu prehliadača <b>⋮</b>', 'Vyber <b>Pridať na plochu</b> alebo <b>Inštalovať aplikáciu</b>']);
    }, 2500);
  }
}

// ---------- štart ----------
async function init() {
  setupInstall();
  $('pickBtn').onclick = () => { $('picker').classList.remove('hidden'); $('search').value = ''; renderPicker(); $('picker').scrollIntoView({ behavior: 'smooth' }); };
  $('closePicker').onclick = () => $('picker').classList.add('hidden');
  $('search').oninput = renderPicker;
  $('stopList').onclick = (e) => {
    const b = e.target.closest('button[data-name]');
    if (!b) return;
    state.manual = b.dataset.name;
    $('picker').classList.add('hidden');
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  $('locBtn').onclick = () => { state.manual = null; startLocation(); render(); };
  $('destBtn').onclick = openDestPicker;
  $('closeDest').onclick = () => $('destPicker').classList.add('hidden');
  $('destHome').onclick = () => { setDestination(null); render(); };
  $('destSearch').oninput = renderDestPicker;
  $('destList').onclick = (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    const it = state.destItems[+b.dataset.i];
    if (it.home) setDestination(null);
    else {
      const d = { name: it.name, sub: it.sub, lat: it.lat, lon: it.lon };
      setDestination(d);
      rememberDest(d);
    }
    $('destPicker').classList.add('hidden');
    render();
  };

  try {
    const res = await fetch('data/network.json');
    state.data = await res.json();
  } catch {
    $('main').innerHTML = '<section class="card"><p class="big">Nepodarilo sa načítať cestovný poriadok 😕</p><p class="muted">Skontroluj internet a skús znova.</p></section>';
    return;
  }
  prepareNetwork(state.data);
  state.groups = buildGroups(state.data);
  const v = state.data.validTo;
  $('dataInfo').textContent = `Cestovný poriadok DPB platí do ${+v.slice(6)}. ${+v.slice(4, 6)}. ${v.slice(0, 4)}. Časy sú podľa poriadku, bez meškaní.`;

  startLocation();
  render();
  setInterval(render, 15000);
  // Keď sa vráti do aplikácie (napr. z nastavení) bez polohy, opýtame sa znova
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (!state.pos && state.locError && !state.locPending) startLocation();
    render();
  });
  navigator.permissions?.query({ name: 'geolocation' }).then((p) => {
    p.onchange = () => { if (p.state === 'granted' && !state.pos) startLocation(); };
  }).catch(() => {});
  $('main').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="loc"]') && !state.locTrying) {
      state.locTrying = true;
      state.locAttempts = (state.locAttempts || 0) + 1;
      render();
      startLocation();
    }
  });
  setInterval(() => { if (state.locError && !state.pos && !state.locPending) startLocation(); }, 60000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
