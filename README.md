# Todo

A personal todo and notes app, built as an installable PWA. Vanilla JavaScript with Firebase — no framework, no build step.

## Pages

- **Todo** — calendar view from yesterday to six days ahead. Unfinished tasks automatically move forward each day, and the more often a task gets carried over, the more urgently it is colored.
- **Notes** — a lightweight notes page with rich text (bold, italic, underline, color) and nestable, collapsible toggle lists.
- **Soon** — mid-term tasks, colored by age so old entries slowly demand attention.
- **Long run** — long-term goals.

## Features

- Works offline — Firestore persistence plus a cache-first service worker; updates install silently in the background
- Real-time sync across devices
- Drag & drop reordering (drag handle on desktop, long-press on mobile)
- Drag across rows to select them, delete or copy the whole range at once (desktop)
- Undo for structural changes — 50 steps, via the header button or Cmd/Ctrl+Z
- Productivity charts: completed todos bucketed by how often they were postponed
- Theming: light/dark, accent color, background shade, patterns, and a custom banner photo
- English and German interface
- Small touches: typing animation on first open of the day, particle bursts on completion, a cascade when the whole day is done

## Tech

- Plain ES modules, served statically — open `index.html` behind any static file server
- Firebase Auth (email/password) and Cloud Firestore
- Chart.js for the productivity charts
- Service worker with versioned precache; the version is bumped automatically by a pre-push hook

```
index.html          entry point, modals, splash
styles.css          all styles
sw.js               service worker (cache-first app shell)
firestore.rules     security rules
src/
  app.js            lifecycle, auth flow, update poke
  auth.js           sign in / sign up UI
  firebase.js       Firebase initialization
  todoService.js    Firestore reads/writes
  render.js         DOM-diffing renderer, keyboard handling, drag & drop
  selection.js      cross-row selection and multi-delete
  history.js        undo stack
  settings.js       theme, colors, patterns, banner (localStorage)
  i18n.js           EN/DE strings
  charts.js         productivity charts
  animations.js     checkbox and particle animations
```

## Running locally

```
npx serve .
```

Any static server works. You'll need your own Firebase project (Auth + Firestore) and its config in `src/firebase.js`; deploy `firestore.rules` to it via the Firebase console or `npx firebase-tools deploy --only firestore:rules`.

## Data

Each account only ever sees its own data — Firestore security rules isolate users and validate every write. Todos and notes are stored in Firestore under your account; appearance settings and the banner photo never leave the device (localStorage). Data is not end-to-end encrypted.
