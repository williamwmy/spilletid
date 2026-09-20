# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Hva dette er

Spilletid er en PWA for barnefotball som holder spilletidsregnskap og foreslår
bytter. Ingen backend, ingen byggesteg, ingen avhengigheter, ingen tester og
ingen linter – fem statiske filer som serveres som de er. `app.js` er hele
applikasjonen (~1400 linjer vanilla JS, `'use strict'`, ingen moduler).

Kommentarer, UI-tekst, commit-meldinger og variabelnavn i domenet er på norsk
(bokmål). Skriv nye kommentarer og all brukervendt tekst på norsk.

## Kjøre lokalt

```bash
python3 -m http.server 8000   # http://localhost:8000
```

Service worker og «Legg til på Hjem-skjerm» krever http(s), ikke `file://`.
Under utvikling lever `sw.js` sin cache-først-strategi i veien: hard reload,
eller slå på «Update on reload» i DevTools → Application → Service Workers.

Syntakssjekk før commit: `node --check app.js && node --check sw.js`.

## Versjonering

`APP_VERSION` øverst i `app.js` vises nederst på Statistikk-fanen. `CACHE` i
`sw.js` er samme streng med `spilletid-v`-prefiks. **Bump begge sammen** når
filene endres – ellers serverer service workeren gammel kode, og
versjonsnummeret på skjermen lyver.

## Arkitektur

### Én global state, lagret som én JSON-blob

Alt ligger i `S`, som skrives til `localStorage` under nøkkelen `fm.v1`
(nøkkelen er arvet fra da appen het fotball-manager – **endres den, mister alle
eksisterende brukere dataene sine**).

```
S = { v:2, teams:[Team], teamId, tab, countdown }
Team = { id, name, squad:[{id,name,number}], settings, matches:[Match], currentId }
Match = { id, name, durationSec, onFieldCount, periods, period, interval,
          maxSwaps, threshold,
          lineup:{ id:{share,locked} },   // hvem er med i denne kampen
          onField:[id],                   // hvem står på banen nå
          sec:{id:sek},                   // spilt
          lock:{id:sek},                  // spilt mens låst (keeper)
          tgt:{id:sek},                   // «bør spille»
          elapsed, running, lastTick, finished, overChime, lastSub, nudged, log }
```

`T()` returnerer det aktive laget og `cur()` den pågående kampen; nesten all
kode går gjennom disse to. Lag er helt adskilte – spilletidsbalanse blandes
aldri på tvers.

All innlesing går gjennom `migrate()` → `normTeam()`, som klamper og typer hvert
felt, slik at resten av koden kan stole på at de finnes. `migrate()` håndterer
både v1 (én tropp på rota) og v2, og brukes også på backup-filer ved import.
Kjenner den ikke formatet, kopieres rådataene til `fm.v1-berget` i stedet for å
bli overskrevet, og Statistikk tilbyr «Gjenopprett berget data».

### Tidsregnskapet

Én regel: **all tid legges til i `flush()`**, som regner ut `dt` siden
`m.lastTick` og kaller `accrue()`. Alt som endrer kampen – bytte, pause,
justering, faneskift – kaller `flush()` *først*. Derfor gjelder et bytte fra
akkurat det sekundet det bekreftes, og ingen operasjon kan «spise» tid.

`accrue(m, dt)` gjør tre ting per tick: øker `elapsed`, gir `dt` til alle på
banen (`sec`, og `lock` for de låste), og fordeler `dt * slots` på «bør
spille»-kvoten (`tgt`) vektet etter `share` blant tilgjengelige, ulåste
spillere. `rollback()` er den eksakte inversen, brukt når klokka fikk gå etter
at dommeren blåste.

Klokka stopper aldri av seg selv ved omgangsslutt – `overrun()` måler hvor langt
forbi man er, og `flush()` varsler én gang ved skillet og så hvert minutt
(`overChime` teller varsler; `syncChime()` resynker den etter manuelle
korreksjoner).

`balances()` summerer `sec`, `lock` og `tgt` over **alle** kamper i laget:
`bal = (sec − lock) − tgt`. Positiv = har spilt for mye. Denne saldoen er hele
appens hjerne – den driver byttforslag, automatisk startoppstilling og
fargekodingen (`balClass()` mot `threshold`).

`suggest(m, b)` parer mest spilte på banen mot minst spilte på benken, hopper
over låste og de med `share === 0`, fyller først opp tomme plasser
(`{out:null, in:id}`), stopper når `gap < threshold`, og slutter å foreslå
ordentlige bytter siste minuttet (oppfylling skjer fortsatt). `nudgeDue()` avgjør når appen piper (`interval` minutter siden
`lastSub`).

### Visning

Fire `<section class="view">` i `index.html` som vises/skjules av `go(tab)`;
`paintAll()` tegner den aktive. HTML bygges med strengkonkatenering – **all
brukerdata må gjennom `esc()`**.

Kampskjermen tegnes 4 ganger i sekundet fra `setInterval` i `init()` og er delt
i to for å ikke ødelegge scroll og trykk:

- `matchHTML()` bygger hele DOM-en på nytt, men bare når `matchSig()` – en
  strengsignatur av alt strukturelt (oppstilling, forslag, valgt spiller,
  status) – har endret seg siden `lastSig`.
- `paintMatch()` kjører hver gang og oppdaterer bare tekst: klokka,
  `[data-pt]` (spilt tid) og `[data-pb]` (saldo).

Legger du til noe i kampskjermen som avhenger av ny state, må det inn i
`matchSig()`, ellers oppdateres det ikke. Sett `lastSig = ''` for å tvinge
full ny tegning.

To modulvariabler holder UI-tilstand utenfor `S`: `sel` (spiller valgt for
manuelt bytte) og `setup` (utkastet i Ny kamp, materialiseres først i
`startMatch()`). `resetView()` nullstiller begge – kall den når dataene byttes
under føttene på visningen (import, lagbytte, sletting).

### Handlinger

Én delegert `click`-lytter på `document` med en `switch` på `data-act`
(`app.js` ~1071). Nye knapper får `data-act="..."` og eventuelt
`data-id`/`data-tab`; ingen lyttere per element. Modaler er én delt
`#sheet`-div fylt av `openSheet(html)`; `data-close` lukker.

### Plattform-særegenheter

- Lyd via `AudioContext` må låses opp av et brukertrykk – `unlockAudio()`
  kalles fra `toggleRun()` og `nextPeriod()`. Derfor følges hvert lydsignal av
  `navigator.vibrate` og en synlig gul klokke.
- `navigator.wakeLock` slippes av nettleseren i bakgrunnen; `requestWake()`
  nullstiller `wake` på `release` så neste kall faktisk ber om en ny.
- `visibilitychange` og `beforeunload` kaller `flush()` + `save(true)`.
  Var appen lukket mens klokka gikk, settes kampen på pause ved oppstart og
  brukeren varsles med `banner()` – appen gjetter aldri på tid den ikke har målt.
- `save()` er debouncet 800 ms; `save(true)` skriver umiddelbart.

## CSS

Alle farger er CSS-variabler på `:root` med et mørk-modus-sett i
`prefers-color-scheme`. Bruk variablene (`--brand`, `--muted`, `--hot`,
`--cold`, `--ok`, `--line`) – ingen hardkodede farger. Mobilførst; `--safe-b`
holder innhold klar av hjemmeindikatoren.
