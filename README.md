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

## Flere lag

Trener du to lag, holder appen dem helt adskilt: egen tropp, egne kamper, egne
kampinnstillinger og egen spilletidsbalanse. Ingenting blandes.

Lagvelgeren ligger øverst i **Tropp**. Har du bare ett lag, står det bare
«＋ Legg til lag» der, og resten av appen ser ut som før. Fra og med lag nummer
to vises navnet på det aktive laget øverst i Kamp, Ny kamp og Statistikk, så du
ikke fører spilletid på feil lag.

Bytter du lag mens klokka går, blir kampen satt på pause – den hører til det
andre laget.

## Omganger og tilleggstid

Kamplengden deles i like mange deler som du velger omganger (1–10). Klokka
**stopper ikke** av seg selv ved omgangsslutt – dommeren avgjør når omgangen er
over, ikke appen. I stedet:

- ett tydelig lydsignal + vibrasjon når omgangstida er ute,
- et nytt signal hvert minutt så lenge klokka får gå videre,
- klokka blir gul og pulserer, og viser `+2:14` – synlig også på lydløs telefon.

Du pauser når dommeren blåser. Merket du det først et par minutter for seint,
får du opp **«Klokka gikk 2:14 forbi 1. omgang»** med knapper for å trekke fra
igjen. Tida trekkes bare fra dem som står på banen, og fra «bør spille»-kvoten,
slik at balansen blir riktig. Trekk fra det som var pause – behold det som var
reelt spill.

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
cd spilletid
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
| `icons/logo.svg` | kilden til ikonene – stoppeklokke med fotball som urskive |

## Godt å vite

- Data ligger bare i denne nettleseren på denne telefonen. Ta **backup** fra
  Statistikk-skjermen før du sletter nettleserdata eller bytter telefon.
  Backupen inneholder alle lag.
- Møter appen lagrede data den ikke kjenner formatet på, overskriver den dem
  ikke – den tar vare på dem, og tilbyr **Gjenopprett berget data** i
  Statistikk.
- **Ny turnering** nullstiller spilletiden for det aktive laget, men beholder troppen.
- Lukker du appen mens klokka går, settes klokka på pause ved neste oppstart, og
  du får varsel om å sjekke tiden. Juster med **⋯** → *Rett opp klokka*.
- Navn og nummer kan endres når som helst: trykk på spilleren i **Tropp**.
- Lyd krever at du har trykket **Start** minst én gang (nettleserkrav).
  Vibrasjon og den gule klokka virker uansett.
- Skjermen holdes våken mens klokka går (der nettleseren støtter det).
