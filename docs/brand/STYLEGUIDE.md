# rekord-lib — Styleguide

Visuelle Identität und UI-Konventionen für die Desktop-App (Tauri + React +
Tailwind). Diese Datei ist bewusst so geschrieben, dass sie an **Claude Code**
übergeben werden kann: Sie enthält konkrete Tokens, Klassen-Rezepte und Regeln.

> Kurzfassung für Claude Code: Nutze `tokens.css` (Tailwind v4) als einzige
> Quelle der Wahrheit. Dark-Mode ist Default. Akzentfarbe ist Violett
> (`accent-*`). Logo-/Display-Text in `font-mono` (JetBrains Mono), Fließtext
> in `font-sans` (Inter). Status-Farben sind an App-Zustände gekoppelt (siehe
> unten). Keine Neon-/Gradient-Effekte.

---

## 1. Marke in einem Satz

`rekord-lib` bereitet Audiodateien so auf, dass sie fehlerfrei auf Pioneer
CDJ/XDJ laufen. Der Ton der Marke ist **technisch, präzise, ruhig** — ein
Werkzeug für DJs, kein verspieltes Consumer-Produkt. Das spiegelt sich in
Monospace-Typo, dunkler Oberfläche und einem einzigen kräftigen Akzent.

---

## 2. Logo

### Aufbau
Eckige Klammern `[ ]` (= Code-Library, das `-lib`) umschließen eine
Wellenform aus vier Balken (= Audio). Zweifarbig: `rekord` in Vorder­grund­farbe,
`-lib` und die Wellenform im Akzent-Violett.

### Dateien (`/logo`)
| Datei | Einsatz |
|---|---|
| `rekord-lib-mark.svg` | Nur Mark, farbig, transparent |
| `rekord-lib-mark-mono.svg` | Mark einfarbig (`currentColor`) — erbt Textfarbe |
| `rekord-lib-logo-horizontal.svg` | Wortmarke, helle Hintergründe |
| `rekord-lib-logo-horizontal-dark.svg` | Wortmarke, dunkle Hintergründe |
| `rekord-lib-logo-stacked.svg` / `-dark.svg` | Gestapelt (quadratische Flächen) |
| `rekord-lib-app-icon.svg` | Squircle-App-Icon (Quelle aller Raster-Icons) |
| `/logo/png/*` | Vorgerenderte PNGs für README/Docs |

Die Wortmarke ist in Pfade konvertiert — die SVGs rendern überall identisch,
auch ohne installierte Schrift.

### Regeln
- **Schutzraum:** mindestens die Höhe eines Klammer-Fußes (≈ 1/6 der Markhöhe) rundum frei halten.
- **Mindestgröße:** Mark ab 24 px, Wortmarke ab 120 px Breite.
- **Farbwahl:** auf hellen Flächen die Standardvariante, auf dunklen die `-dark`-Variante.
- **Nicht:** verzerren, Farben tauschen, Effekte/Schatten hinzufügen, Klammern und Wellenform trennen.
- Für sehr kleine UI (16–20 px, z. B. Menubar) `rekord-lib-mark-mono.svg` verwenden; die Wellenform verschmilzt dort optisch, was akzeptabel ist.

---

## 3. Farben

Ramps sind in `tokens.css` als Tailwind-Utilities verfügbar
(`bg-accent-500`, `text-graphite-300`, …).

### Akzent — Violett (Marke)
`accent-500 #6A5FD6` ist die Basis. Primäre Aktionen: `accent-600`, Hover
`accent-500`. Auf Dunkel für Text/Icons eher `accent-300/400` (Kontrast).

### Graphite — Neutraltöne (dark-first)
`graphite-900 #100F14` App-Hintergrund → `graphite-0 #FFFFFF`. Kühl abgestimmt
auf das Violett.

### Semantische Oberflächen-Tokens (theme-abhängig)
Nicht die Ramps direkt für Flächen/Text nehmen, sondern diese Tokens — sie
schalten automatisch zwischen Dark/Light:

| Utility | Bedeutung |
|---|---|
| `bg-bg` | App-Hintergrund |
| `bg-surface` | Panels, Cards |
| `bg-surface-2` | erhöhte Fläche (Menü, Popover, aktive Zeile) |
| `border-border` / `border-border-strong` | Trennlinien |
| `text-fg` | primärer Text |
| `text-fg-muted` | sekundärer Text |
| `text-fg-subtle` | Hinweise, Platzhalter |

### Status — an App-Zustände gekoppelt
Das ist der wichtigste Teil für diese App. Farbe kodiert **Kompatibilität**:

| Zustand | Farbe | Beispiel-UI |
|---|---|---|
| **kompatibel / bereit** | `success` (grün) | „Läuft auf CDJ", Häkchen |
| **Konvertierung nötig / Hinweis** | `warning` (amber) | „>48 kHz → wird resampled", FLAC/ALAC nur NXS2/3000 |
| **inkompatibel / Fehler-Risiko** | `danger` (rot) | „E-8305-Risiko", „kein PCM" |
| **Marke / Aktion / Fortschritt** | `accent` (violett) | Konvertieren-Button, Waveform, Progress |

Flächen jeweils mit `bg-*`/`fg-*`-Paar (in tokens.css): z. B. Warn-Pill
`background: var(--bg-warning); color: var(--fg-warning)`.

---

## 4. Typografie

| Rolle | Font | Einsatz |
|---|---|---|
| Display / Logo / Labels / Daten | **JetBrains Mono** (`font-mono`) | Dateinamen, kHz/bit, Format-Tags, Zahlen, Buttons |
| Fließtext / UI-Beschreibung | **Inter** (`font-sans`) | Erklärungen, Dialoge, Hilfetexte |

Monospace ist bewusst prominent — es passt zum Werkzeug-Charakter und lässt
technische Werte (`44.1 kHz`, `24-bit`, `AIFF`) sauber ausrichten. Nicht für
lange Fließtexte verwenden.

**Skala** (Tailwind-Defaults): Titel `text-xl`/`text-2xl` (500), Body
`text-sm`/`text-base` (400), Meta `text-xs` (`text-fg-subtle`). Zwei Gewichte:
400 regular, 500 medium. Kein 600/700 in der UI. **Sentence case** überall,
kein Title Case, kein ALL CAPS.

Schriften einbinden (empfohlen):
```
npm i @fontsource/inter @fontsource/jetbrains-mono
```
```ts
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
```

---

## 5. Form & Layout

- **Radius:** Controls `rounded-md` (8 px), Cards `rounded-lg` (12 px), Pills `rounded-full`. Einseitige Border-Akzente (nur `border-l`) → `rounded-none`.
- **Border:** Standard `border border-border` (Haarlinie). Kein doppelter Rahmen + Schatten auf derselben Fläche.
- **Elevation:** dezent, `shadow-md` für Popover/Dialog, sonst flach. Tiefe entsteht über `surface`-Stufen, nicht über Schatten.
- **Dichte:** kompakt (Power-User-Tool). Zeilenhöhe in Listen knapp, Padding `px-3 py-2` für Zeilen, `px-4 py-2.5` für Buttons.
- **Icons:** Strich-Icons `stroke-width 2`, Glyph 18–20 px. Icon-only-Buttons in ein **mindestens 32 px großes Klickziel** setzen (`h-8 w-8`, zentriert), nie nur ein nacktes Glyph. Sehr kleine Deko-Icons (16 px) nur ohne Klickfunktion.
- **Fenster:** dunkle Titelleiste; falls Custom-Titlebar, `bg-surface` + `border-b border-border`.

---

## 6. Komponenten-Rezepte (Tailwind)

Primär-Button
```html
<button class="font-mono text-sm rounded-md px-4 py-2.5 bg-accent-600 hover:bg-accent-500 text-white transition-colors">
  Konvertieren
</button>
```

Sekundär-Button
```html
<button class="font-mono text-sm rounded-md px-4 py-2.5 bg-surface-2 hover:bg-graphite-700 text-fg border border-border transition-colors">
  Abbrechen
</button>
```

Status-Pill (Beispiel: Warnung)
```html
<span class="font-mono text-xs rounded-full px-2.5 py-1"
      style="background:var(--bg-warning);color:var(--fg-warning)">
  resample 48 kHz
</span>
```

Track-Zeile (Liste)
```html
<div class="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-surface-2">
  <span class="font-mono text-sm text-fg truncate">artist – title.wav</span>
  <span class="font-mono text-xs text-fg-subtle ml-auto">96 kHz · 24-bit</span>
  <span class="font-mono text-xs rounded-full px-2 py-0.5"
        style="background:var(--bg-warning);color:var(--fg-warning)">→ AIFF</span>
</div>
```

Drop-Zone
```html
<div class="rounded-lg border-2 border-dashed border-border-strong bg-surface
            p-10 text-center text-fg-muted font-sans">
  Dateien hierher ziehen oder <span class="text-accent-400">auswählen</span>
</div>
```

Card
```html
<section class="rounded-lg border border-border bg-surface p-5 shadow-md">…</section>
```

Waveform (Canvas/SVG): Balken in `accent-500`, Grundlinie/Raster in
`graphite-700`. Farben aus `theme.ts` (`accent[500]`) beziehen, damit UI und
Waveform konsistent bleiben.

---

## 7. Dark / Light

Dark ist Default. Umschalten über das Attribut am `<html>`:
```html
<html data-theme="dark">   <!-- oder "light" -->
```
Alle semantischen Tokens (`bg`, `surface`, `fg`, …) und Status-Flächen
schalten automatisch. Ramps (`accent-*`, `graphite-*`) sind fix — deshalb für
Flächen/Text die semantischen Tokens verwenden, nicht die Ramps.

---

## 8. Do / Don't

**Do:** dunkle ruhige Fläche, ein Akzent, Monospace für Daten, Status-Farbe =
Kompatibilität, viel Kontrast bei kleinem Text.

**Don't:** mehrere Akzentfarben mischen, Gradients/Glow, Status-Farben
dekorativ (nur semantisch!) einsetzen, Fließtext in Monospace, Title Case.
