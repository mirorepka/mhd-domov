# Bus domov 🚌

PWA aplikácia pre deti: podľa polohy telefónu vyhľadá najrýchlejšie spojenie MHD Bratislava
**domov** (zastávka Kaštieľ Rusovce) – aj s prestupmi – a povie, kedy treba vyraziť.

Web: https://mhd.repka.sk

## Ako to funguje
- `tools/update-feeds.mjs` stiahne oficiálne GTFS dáta DPB, odloží ich do `gtfs/` a zavolá
  `tools/build-data.mjs`, ktorý z nich vyrobí kompaktný `app/data/network.json` (celá sieť, ~300 kB gzip).
- V aplikácii (`app/app.js`) beží vyhľadávanie spojení algoritmom RAPTOR: pešo na niektorú
  z blízkych zastávok (do 1,2 km), max. 3 prestupy, prestupy pešo medzi zastávkami do 300 m.
  Spoj s menej prestupmi má prednosť, ak je najviac o 5 minút pomalší.
- GitHub Actions (`.github/workflows/deploy.yml`) každý deň skontroluje nový cestovný poriadok
  a nasadí aplikáciu na GitHub Pages.

## Lokálne
```
node tools/update-feeds.mjs     # stiahne dáta a vyrobí network.json (potrebuje unzip)
node tools/serve.mjs            # http://localhost:5173
```

Domácu zastávku mení `HOME_STOP_NAME` v `tools/build-data.mjs`.
