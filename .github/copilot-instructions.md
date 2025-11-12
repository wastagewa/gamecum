## Purpose
Provide concise, repository-specific guidance so AI coding agents can be productive quickly.

## Big picture (what this app is)
- A small Flask-based image gallery and memory game served from `app.py`.
- Uploaded images are stored under `static/uploads/` with optional collections as subfolders (default collections: `Real`, `AI`).
- Templates: `templates/index.html` (gallery) and `templates/game.html` (memory game). JS files under `static/js` implement client behavior.

## Key entry points and data flows
- `app.py` — main Flask app and most important file:
  - Routes: `/collection/<name>` (gallery view), `/collection/<name>/game` (game view), `/upload[/<collection>]` (POST upload), `/delete-image/<filename>` and `/delete-image/<collection>/<filename>` (DELETE), `/api/images` and `/api/collections` (JSON), `/get-quote` (returns random quote from `static/quotes.txt`).
  - Uploads: saved to `static/uploads/` (UUID filename + original extension via `secure_filename`). `ALLOWED_EXTENSIONS` and `MAX_CONTENT_LENGTH` enforced in the app.
  - Collection names are sanitized by `_safe_collection_name()` (only A-Za-z0-9_- allowed).

## Front-end conventions & integration points
- `templates/index.html` and `templates/game.html` inject server data:
  - `index.html` exposes `window.CURRENT_COLLECTION` via templating.
  - `game.html` injects `SERVER_IMAGES` as JSON (array of image URLs) — the game reads `SERVER_IMAGES` directly.
- `static/js/gallery.js` expects `window.CURRENT_COLLECTION` and calls `/upload` and `/delete-image` endpoints. It fetches `/get-quote` for modal captions.
- `static/js/game.js` expects `SERVER_IMAGES` and may call `/api/collections` when mixing collections.
- Local UI persistence keys use the pattern `imgur.size.<collection>` and `imgur.fit.<collection>` in `localStorage`.

## Security and file handling notes (important for edits)
- Filenames are generated as `uuid + secure_filename(ext)`; do not assume original filenames are preserved.
- Collection names are strictly validated; adding new collections consists of creating a directory under `static/uploads/<Name>`.
- Upload size limit: 16MB (see `app.config['MAX_CONTENT_LENGTH']`). Allowed extensions are defined in `ALLOWED_EXTENSIONS`.

## Developer workflows (how to run & debug)
- Run locally (development mode):
```powershell
# from workspace root
python .\app.py
```
  - `app.py` currently calls `app.run(debug=True)` when executed directly.
  - Logs/errors surface in the console (Flask stdout). JS prints helpful debugging messages (see `console.log` calls in `gallery.js`).

## Patterns & examples to follow when contributing
- When adding an API endpoint that returns images, follow the `/api/collections` shape: return a JSON object `{ "collections": { name: [url, ...], ... } }`.
- When adding client-side features, prefer server-injected variables (`SERVER_IMAGES`, `CURRENT_COLLECTION`) rather than additional API calls unless dynamic behavior (mixing collections) is required.
- Use `_safe_collection_name()` semantics for any collection path handling to avoid injection or invalid paths.

## Files to inspect for concrete examples
- `app.py` — routes, upload/delete, APIs, sanitization, and startup behavior.
- `templates/index.html` — gallery rendering, how image URLs are composed (`url_for('static', filename='uploads/...')`).
- `templates/game.html` — `SERVER_IMAGES` injection and game options UI.
- `static/js/gallery.js` and `static/js/game.js` — client-side expectations, localStorage keys, endpoint usage, and UX flows (upload, delete, modal, game setup).

## When you need to change behavior
- If changing upload storage layout, update `app.config['UPLOAD_FOLDER']`, templates that build `uploads/` URLs, and the `/api/*` endpoints so client code continues to receive the same URL shapes.
- If you add a new collection name UI, ensure directory exists under `static/uploads/` (app startup creates `Real` and `AI`).

## Quick examples for common edits
- To add an API that returns images for a single collection: mirror `api_collections()` and return `{ 'images': ["/static/uploads/<collection>/<file>", ...] }`.
- To trigger a new client-side behavior on upload success, `gallery.js` calls `addImageToGallery(data.url)`; return `url` in the upload JSON.

If anything above is unclear or you want more detail in a specific section (endpoints, running tests, or deployment notes), tell me which area to expand.  