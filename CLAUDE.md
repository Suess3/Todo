# Todo App — Kontext für Claude

## Projekt
Persönliche Todo-App als PWA. Vanilla JS + Firebase (Firestore + Auth). Kein Build-Step, kein Framework.
Lokaler Pfad: `/Users/johannes/Projects/Todo`
GitHub: `https://github.com/Suess3/Todo` (Account: Suess3)

## Wie wir arbeiten
- **Immer auf GitHub pushen** wenn Änderungen fertig sind — ohne extra zu fragen
- Commits auf Englisch, kein "Co-Authored-By Claude" in der Message
- Vor größeren Änderungen kurz fragen / Ansatz erklären
- Clarifying questions stellen bis man sicher ist was gemeint ist
- Kommentare nur für das "Warum", nicht das "Was"
- Keine unnötigen Abstraktionen, keine Features die nicht gefragt wurden

## App-Architektur

### Dateien
```
index.html          # Entry point, Modal-HTML (Settings, Charts)
styles.css          # Alle Styles, CSS-Variablen für Theming
manifest.json       # PWA Metadata
sw.js               # Service Worker (Cache-First, v45+)
firestore.rules     # Firestore Security Rules
src/
  app.js            # Lifecycle, Auth-Flow, visibilitychange, pagehide
  firebase.js       # Firebase Init (Projekt: todo-28d2e)
  auth.js           # Email/Password Login UI
  todoService.js    # Firestore CRUD + recordProductivity
  render.js         # DOM-Diffing Renderer (kein innerHTML = '')
  settings.js       # Theme, Accent, Banner, Pattern etc. (localStorage)
  charts.js         # Produktivitäts-Charts (Chart.js 4.4.0)
  animations.js     # Checkbox-Bounce + Particle Burst
  version.js        # VERSION constant (wird vom pre-commit hook gebumpt)
```

### Datenmodell Firestore
```
/users/{uid}/todos/{todoId}
  text, isDone, dateEpochDay, sortOrder, moveCount, page, createdAt, completedAt

/users/{uid}/productivity/{YYYY-MM-DD}
  { "0": n, "1": n, ... "5": n }   ← Buckets nach moveCount (0=same day, 5=6+ days)
```

### 4 Seiten
- **todo** — Kalender-View (gestern bis +6 Tage), Auto-Move täglich
- **keepInMind** — Notizen, auto-delete nach 24h wenn abgehakt
- **soon** — Mittelfristig, age-based coloring
- **longRun** — Langfristig

## Wichtige Implementierungs-Details

### DOM-Diffing (render.js)
`renderApp()` macht **kein** `innerHTML = ''` mehr. Stattdessen werden Rows per `data-id` wiederverwendet. `reconcileRows()` ist der zentrale Diffing-Helper. Focus geht nie verloren.

### Save-Mechanismus
- 2s debounce nach Tippen (`scheduleSave`)
- Blur → sofort speichern (`attachBlurSave`)
- `flushDirty()` alle 60s + bei `pagehide` + bei `visibilitychange → hidden`
- `dirtyIds.delete()` erst **nach** erfolgreichem Write, bei Fehler re-add

### Urgency-Coloring
`moveCount` = wie oft ein Todo verschoben wurde. Farbpalette:
- 0: neutral (weiß/schwarz)
- 1-4: PASTEL_COLORS
- 5+: VIVID_COLORS

### Animations
- **Bounce**: CSS keyframe `checkbox-bounce` auf `.checkbox` div
- **Particles**: 12 Partikel auf shared Canvas overlay (`animations.js`), Accent-Farbe aus localStorage
- `updateCheckbox()` nutzt `classList.toggle` damit Bounce-Animation nicht unterbrochen wird

### Produktivitäts-Chart
- Öffnet sich via ◑ Button neben ⚙︎
- Zwei Pie Charts: "This Week" (letzte 7 Tage) + "All Time"
- Farben: Same day = `#6ee7a0` (grün), dann Urgency-Palette
- Data source: `/users/{uid}/productivity/{datum}` — wird real-time beim Checken geschrieben via `recordProductivity()`
- Nur Todo-Page wird getrackt (nicht Soon/Notes/LongRun)
- Chart.js 4.4.0 via CDN, im SW gecacht

### Service Worker
- Cache-Name: `todo-v{N}` — wird automatisch vom pre-commit hook gebumpt
- Cache-First für App Shell, Network-Only für Firebase APIs
- **Wichtig**: SW-Updates sind für User nicht sofort sichtbar — sie müssen SW in DevTools unregistrieren oder "Clear site data" machen. TODO: Auto-reload Banner einbauen wenn neuer SW verfügbar

### Firestore Rules
Müssen manuell deployed werden (`firebase deploy --only firestore:rules` oder Firebase Console). Aktuell erlaubt: todos + productivity Subcollection.

## Offene TODOs / Nächste Schritte
- [ ] Auto-reload Banner wenn neuer Service Worker verfügbar ist
- [ ] DOM-Diffing: Keyboard-Logik noch dupliziert zwischen Calendar + Flat (mittlere Priorität)
- [ ] sortOrder float-Präzision: bei vielen Splits degradiert (low priority)
- [ ] Fehler-Feedback wenn Firestore-Write fehlschlägt (kein UI momentan)
- [ ] Banner-Foto: localStorage ist fragil bei großen Bildern → IndexedDB wäre besser

## Settings (localStorage Keys)
```
todo-theme              → 'dark' | 'light'
todo-urgency-intensity  → 0-100
todo-accent-hue         → 0-360
todo-bg-brightness      → 0-100
todo-bg-pattern         → none|grain|dots|grid|diagonal|scan
todo-bg-pattern-opacity → 0-100
todo-banner-photo       → Base64 JPEG
todo-banner-pos         → {x, y}
todo-badge-enabled      → true|false
todo-animated-day       → Epoch-Tag (verhindert tägl. Animation)
```
