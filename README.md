# Spilletid – lagstyring for barnefotball

Progressiv webapp (PWA) som holder styr på hvor mange minutter hver spiller har
spilt, og foreslår bytter så alle får omtrent like mye spilletid.
Ingen backend, ingen database – alt ligger i nettleseren (`localStorage`).

## Slik virker den

1. **Tropp** – legg inn navn og nummer på spillerne. Du kan lime inn flere
   linjer på én gang (`7 Ola`, `Kari 9`, eller bare `Ola`).
2. **Ny kamp** – sett kamplengde, hvor mange som er på banen, antall omganger,
   hvor ofte appen skal foreslå bytte, og hvor mange bytter per runde.
   Marker hvem som er med i dag, og velg startoppstilling (eller la appen velge
   de som har spilt minst så langt).
3. **Kamp** – start klokka. Appen regner hele tiden ut hvem som har spilt for
   mye og for lite, og viser et konkret forslag:
   *«4 Cato → 10 Ivar»*, *«5 Dina → 3 Bo»*.
   **Klokka går videre mens forslaget står.** Byttet gjelder fra det sekundet du
   trykker **Bekreft bytte** – da starter klokka til de som kommer inn.
4. **Statistikk** – spilletid per spiller for hele turneringen, kamp for kamp.

## Slik jevner den ut

For hvert sekund som går fordeles «bør spille»-tid på alle tilgjengelige
spillere etter andelen deres. Saldoen (`spilt − bør`) følger spilleren gjennom
**hele turneringen**, ikke bare én kamp. Spilte noen mye i kamp 1, kommer de
automatisk bak i køen i kamp 2.

- **Andel 100/75/50/25 %** – for de som vil eller kan spille mindre.
- **Ute / skadet** – teller ikke med i fordelingen i det hele tatt.
- **Låst** (f.eks. keeper) – blir aldri foreslått byttet, og tiden teller ikke
  i fordelingen, så resten av laget rullerer riktig seg imellom.
- **Slingringsmonn** – hvor stor forskjell appen godtar før den foreslår bytte.

Alt kan endres midt i kampen: trykk **⋯** på en spiller for å sette ned andelen,
melde skade, låse, ta av banen eller rette opp spilletiden manuelt.

## Kjøre lokalt

En PWA må serveres over http (ikke `file://`) for at offline-modus skal virke:

```bash
cd fotball-manager
python3 -m http.server 8000
# åpne http://localhost:8000
```

## Legge den på mobilen

Legg filene på et hvilket som helst statisk webhotell med https – GitHub Pages,
Netlify, Cloudflare Pages. Åpne siden på telefonen og velg
«Legg til på Hjem-skjerm». Da virker den offline, uten nettdekning på banen.

## Filer

| Fil | Innhold |
|-----|---------|
| `index.html` | skjelett for alle fire skjermene |
| `app.js` | tidsregnskap, byttealgoritme og all visning |
| `styles.css` | mobilførst, lys og mørk modus |
| `sw.js` | service worker (offline-cache) |
| `manifest.webmanifest` | app-navn, farger, ikoner |
| `icons/` | app-ikoner (192, 512, maskable) |

## Godt å vite

- Data ligger bare i denne nettleseren på denne telefonen. Ta **backup** fra
  Statistikk-skjermen før du sletter nettleserdata eller bytter telefon.
- **Ny turnering** nullstiller spilletiden, men beholder troppen.
- Lukker du appen mens klokka går, settes klokka på pause ved neste oppstart, og
  du får varsel om å sjekke tiden. Juster med **⋯** → *Rett opp klokka*.
- Skjermen holdes våken mens klokka går (der nettleseren støtter det).
