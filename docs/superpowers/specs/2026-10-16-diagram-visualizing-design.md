# Diagram Studio - design

Status: approved by the user on 2026-10-16.
Date: 2026-10-16.
Branch: `hiinguyen/feat-diagram-visualizing`.

## Goal

A Napkin-style tool that turns text into editable diagrams.
The user gives it typed text, a `.txt`, `.md`, `.docx`, `.pptx` file, or a web page URL.
An AI agent reads it, asks clarifying questions with ready-made options when the text lacks meaning, and proposes diagrams for the passages worth visualizing.
The user picks a proposal, switches styles, edits it directly, and can ask the agent to "finish" it again.
The result is exported as SVG, PNG, PDF, or put back into the original `.docx` / `.pptx`.

On a personal machine the agent is the local Claude Code CLI.
On a server the agent is a Hermes Agent API server.
The server deployment is single-user, protected by one token.

UI language is Vietnamese.
Diagram text keeps the language of the source text.

## Non-goals

- No free-form canvas (no dragging shapes to arbitrary positions, no hand-drawn arrows).
  Layout always comes from the template.
- No multi-user accounts, sharing, or collaboration.
- No PDF input and no OCR in v1.
- No integration into the Friday HUD in v1.
  A voice command can open the web app later.

## 1. Architecture

A new, self-contained Node app in `diagram/` at the repo root, independent of `app/` (Electron).
It is an ES module package (`"type": "module"`), Node 22 or newer.

```
diagram/
  package.json
  server/            Fastify HTTP API, ingest, agent adapters, export, storage
  shared/            isomorphic code used by both the browser and the server
    spec/            DiagramSpec schema, validation, normalization, edit operations
    render/          text measurement, templates, themes, scene -> SVG
    fonts/           bundled Be Vietnam Pro TTF files (400, 500, 600, 700) and their OFL licence
    icons/           curated icon set generated from lucide-static
  web/               browser UI (vanilla ES modules, no build step)
  test/              node:test unit + integration tests, fixtures, golden SVGs
  e2e/               Playwright tests against a server running the fake agent
```

The server serves `web/`, `shared/` and the few browser-side npm modules as static files, so the browser imports exactly the same renderer the server uses for export.
There is no bundler.

### Agent adapters

One interface, three implementations, chosen by `DIAGRAM_AGENT`:

```js
// every adapter
async run({ task, system, user, schema, signal }) // -> parsed JSON object matching schema
```

| Adapter       | Where             | How |
| ------------- | ----------------- | --- |
| `claude-code` | personal machine  | spawns `claude -p --output-format json --json-schema <schema> --tools "" --no-session-persistence [--model M]` with the prompt on stdin, reads `structured_output` from the result |
| `hermes`      | server            | `POST {URL}/v1/chat/completions` (non-streaming) with the bearer key and system + user messages, extracts the first JSON object from the reply |
| `fake`        | tests, E2E, demos | returns fixtures from `test/fixtures/agent/` keyed by task; never touches the network or spawns a process |

All adapter output is validated with Ajv against the task schema.
On a validation failure the adapter is called once more with the validation errors appended to the user message; a second failure is an error shown to the user.
Agent output is only ever parsed as data: it is never executed, and SVG is never taken from the agent.

### Flow

1. **Ingest.** The server turns the input into a `Document`: an ordered list of `Block { id, kind: heading|paragraph|list|table|slide, text, level? }`, plus the source location needed to put diagrams back later.
2. **Segment** (agent task `segment`).
   The agent reads the blocks and returns either clarifying questions or a list of `Section { id, blockIds, title, summary, suggestedKinds }`: contiguous passages worth a diagram.
3. **Clarify.** Questions are shown as option chips (single or multi choice, plus an optional free-text answer).
   The answers are stored on the project and sent with every later agent call.
4. **Generate** (agent task `generate`, lazily per section when the user opens it).
   The agent returns either questions or 3 candidate `DiagramSpec`s that use different templates.
5. **Edit.** The user picks a candidate, switches theme / template, and edits nodes directly.
   Every edit is an immutable operation on the spec, with undo / redo.
6. **Finish** (agent task `refine`).
   The agent receives the edited spec, the fields the user locked by editing them, and an optional instruction ("thêm một bước kiểm thử", "rút gọn chữ").
   It returns a revised spec that keeps every locked field unchanged.
7. **Export.** SVG, PNG, PDF, or the original `.docx` / `.pptx` with each chosen diagram inserted after its section.

### Security (server mode)

- `DIAGRAM_TOKEN` is required whenever `DIAGRAM_HOST` is not a loopback address; the server refuses to start otherwise.
  Requests carry it as `Authorization: Bearer`; the web UI asks for it once and keeps it in `localStorage`.
  Comparison uses `crypto.timingSafeEqual`.
- Uploads are capped at 20 MB; text sent to the agent is capped at 60,000 characters per call.
- URL ingest only allows `http` / `https`, resolves the host first and refuses loopback, private, link-local, CGNAT and cloud metadata addresses, follows at most 3 redirects (each re-checked), times out after 15 s, and caps the body at 5 MB.
  It resolves IPv4 first because IPv6 is broken on the user's network.
- The Hermes key and the token live only in the root `.env` (git-ignored), read at startup.
- The Hermes system prompt tells the agent not to call tools; the Hermes host should still run a narrow profile, as documented for the Friday bridge in `README.md`.

## 2. DiagramSpec, templates and styles

### DiagramSpec (version 1)

```json
{
  "version": 1,
  "id": "d_k3x9",
  "sectionId": "s2",
  "template": "timeline",
  "title": "Lộ trình ra mắt sản phẩm",
  "subtitle": "Q1 - Q4 2027",
  "lang": "vi",
  "nodes": [
    { "id": "n1", "label": "Nghiên cứu", "detail": "Phỏng vấn 30 khách hàng", "icon": "search", "parent": null, "value": null, "emphasis": false, "color": null },
    { "id": "n2", "label": "Thiết kế", "detail": "", "icon": "pen-tool", "parent": null, "value": null, "emphasis": true, "color": null }
  ],
  "edges": [{ "from": "n1", "to": "n2", "label": "" }],
  "style": { "theme": "classic", "density": "normal" },
  "locks": ["n2.label", "title"]
}
```

- `nodes` is the single content list for every template.
  Hierarchy-shaped templates use `parent`; quantity templates use `value`; graph templates use `edges`.
- `label` is at most 60 characters and `detail` at most 160.
  The renderer wraps text; if a box is still too small it shrinks the font down to a floor (75 %), then ellipsizes.
- `icon` must be a name from the curated icon list; unknown names fall back to `circle`.
- `color` is an optional palette slot (`accent1`..`accent6`), never a raw hex value, so themes stay consistent.
- `locks` lists field paths (`title`, `subtitle`, `<nodeId>.label`, `<nodeId>.detail`, `<nodeId>.icon`, `<nodeId>.color`, `nodes.order`) the user edited by hand.
  The editor adds them automatically.
  `refine` is told to return them unchanged, and the server re-applies them after `refine` as a safety net.
- `normalize(spec)` repairs what it can (missing or duplicate ids, dangling edges and parents, parent cycles, too many nodes truncated to the template maximum, labels over the limit truncated) and returns the list of repairs; `validate` rejects the rest.

### Templates (v1: 12)

Each template is one module in `shared/render/templates/` exporting:

```js
export default { id, kind, label, minNodes, maxNodes, uses: { parent, edges, value }, layout(spec, ctx) /* -> Scene */ };
```

| id          | kind         | Shape                                                              | Nodes |
| ----------- | ------------ | ------------------------------------------------------------------ | ----- |
| `cards`     | list         | grid of cards with icon, label, detail                             | 2-9   |
| `icon-row`  | list         | large icons in a row, label under each                             | 2-6   |
| `timeline`  | sequence     | horizontal axis, items alternating above and below                 | 3-8   |
| `steps`     | sequence     | chevron arrows left to right                                       | 3-6   |
| `flowchart` | relationship | boxes and arrows, layered layout with `@dagrejs/dagre`             | 3-12  |
| `cycle`     | cycle        | nodes on a circle joined by curved arrows                          | 3-8   |
| `tree`      | hierarchy    | top-down org-chart tree                                            | 3-15  |
| `mindmap`   | hierarchy    | radial: root in the centre, branches around it                     | 3-15  |
| `compare`   | comparison   | 2-4 columns; a column is a root node, its rows are the children    | 4-16  |
| `funnel`    | proportion   | narrowing stacked bands, optional value per band                   | 3-6   |
| `pyramid`   | hierarchy    | stacked triangle layers, first node on top                         | 3-6   |
| `venn`      | relationship | 2-3 overlapping circles; a circle's children list its points       | 2-3 circles |

Templates of the same `kind` are freely interchangeable in the editor.
Switching to another kind is allowed when the node shape fits (`uses` and node count); otherwise the option is disabled with the reason as a tooltip.

### Rendering pipeline

`layout(spec, ctx)` returns a `Scene`: plain data with a `viewBox` and a flat list of primitives (`rect`, `circle`, `path`, `line`, `text`, `icon`, `group`), each tagged with the `nodeId` and `role` it belongs to.
`sceneToSvg(scene, theme)` paints it.
Splitting geometry from paint means:

- switching theme only re-paints, layout runs again only when the spec or density changes,
- the editor hit-tests clicks against scene boxes by `nodeId`,
- tests assert geometry (no overlapping node boxes, text inside its box, everything inside the viewBox) without parsing SVG.

Text is measured with `opentype.js` on the bundled font files in both the browser and Node, so layout is identical on screen and in every export.
The only font in v1 is Be Vietnam Pro (full Vietnamese coverage), bundled as static TTF files in four weights.
A second family is left out on purpose: Inter only ships as a variable font, which `opentype.js` does not measure reliably.

### Themes (v1: 6)

A theme is a token object: `background`, `surface`, `text`, `mutedText`, `stroke`, `accent1`..`accent6`, `onAccent`, `font`, `radius`, `strokeWidth`, `iconStyle` (`outline` | `filled-circle`), `shadow` (bool).

- `classic`: white, blue and teal accents.
- `ocean`: deep blue bands.
- `sunset`: warm orange and pink.
- `pastel`: soft fills, dark text.
- `mono`: black and white, print friendly.
- `midnight`: dark background, neon accents.

`density` (`compact` | `normal` | `airy`) scales spacing independently of the theme.
Every theme must pass WCAG AA contrast (4.5:1) between each text colour and every fill it can sit on; a unit test enforces this.

### Editor (web UI)

Three-pane layout:

- **Left: source.** The document blocks; sections are highlighted and clicking one opens it.
  Selecting text and pressing "Vẽ đoạn này" creates a section by hand.
- **Centre: canvas.** The diagram SVG; above it the 3 candidates as thumbnails; below it the template and theme pickers as thumbnail strips rendered from the current spec.
- **Right: inspector.** For the selected node: label and detail (also editable inline by double-clicking on the canvas), icon picker with search, colour slot, emphasis toggle, add sibling, add child, delete, move up, move down.
  With nothing selected: title, subtitle, theme, density, and the "Hoàn thiện" box (optional instruction plus button).
- Undo / redo (Ctrl+Z / Ctrl+Shift+Z); Enter edits the selected node, Delete removes it, arrow keys move the selection.
- Questions from the agent appear as a modal card with option chips; the request continues once answered.
- Long agent calls show a progress state with a cancel button that aborts the adapter.
- Below 900 px wide the panes stack (source collapses into a drawer); there is no horizontal page scroll.

### Persistence

Single user, so projects are JSON files: `DIAGRAM_DATA_DIR/projects/<id>/project.json` (document, sections, answers, specs with their history) plus `source.<ext>` (the original upload, needed for docx / pptx export).
Writes are atomic (write a temp file, then rename).
The start screen lists recent projects.

## 3. Export, ingest, errors, testing

### Export

| Format | How |
| ------ | --- |
| SVG    | `sceneToSvg` with text converted to paths via `opentype.js`, so it looks the same on machines without the fonts |
| PNG    | `@resvg/resvg-js` on that SVG at 2x scale; transparent or theme background (user choice) |
| PDF    | `pdfkit` + `svg-to-pdfkit` on the same SVG; one vector page per diagram, sized to the diagram |
| DOCX   | edit the original with `jszip` + `@xmldom/xmldom`: after the last body paragraph of each section insert a centred paragraph with an inline PNG (`w:drawing`), adding the media file, relationship and content type; width capped to the page text width from `w:sectPr` |
| PPTX   | edit the original: after the last slide of each section insert a new slide that uses the blank layout of that slide's master, holding only the diagram PNG fitted to the slide (the diagram carries its own title), updating `ppt/presentation.xml`, its rels, the new slide's rels and `[Content_Types].xml` |

DOCX and PPTX export are only offered for projects ingested from that format.
Text, Markdown and URL projects can also export a zip with a Markdown file that links the diagrams as PNG files.

### Ingest

| Input | Parser |
| ----- | ------ |
| text  | blocks split on blank lines; consecutive lines starting with `-`, `*` or `1.` grouped into one list block |
| .txt  | as text, decoded as UTF-8 with the BOM stripped |
| .md   | `marked` lexer: headings, paragraphs, lists; code blocks kept as paragraphs |
| .docx | `word/document.xml`: each `w:body` paragraph with text is a block (heading level from `w:pStyle` `Heading1`..`Heading6` / `Title`), each table one block; the block keeps its index among the `w:body` children |
| .pptx | one block per slide in presentation order (from `sldIdLst` in `ppt/presentation.xml`), text from `a:t` runs, the slide title first; the block keeps its slide part name |
| URL   | fetched under the URL rules above, `@mozilla/readability` on a `linkedom` document, then the article HTML mapped to blocks |

### Error handling

All API responses use one envelope: `{ ok: true, data }` or `{ ok: false, error: { code, message } }`, with a Vietnamese `message` for the UI and the detail logged on the server.

| Situation | Code | Behaviour |
| --------- | ---- | --------- |
| `claude` not on PATH, or Hermes URL / key missing | `agent_unavailable` | startup warning; the UI says which env var to set |
| agent call over `DIAGRAM_AGENT_TIMEOUT_S` | `agent_timeout` | request aborted, child process killed, retry button |
| agent output invalid twice | `agent_bad_output` | first 2,000 characters of the raw output logged, retry button |
| Claude Code or Hermes reports an error (usage limit, HTTP error) | `agent_error` | its message shown |
| unsupported file type, too large, or corrupt | `bad_input` | rejected before anything is stored |
| URL refused / unreachable | `url_blocked` / `url_failed` | reason shown |
| missing or wrong token | `unauthorized` | HTTP 401, the UI asks for the token again |
| export failure | `export_failed` | logged with the project id; other formats still work |
| a second agent call on a project while one runs | `busy` | HTTP 409 |

### Configuration (root `.env`)

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `DIAGRAM_AGENT` | `claude-code` | `claude-code`, `hermes` or `fake` |
| `DIAGRAM_HOST` / `DIAGRAM_PORT` | `127.0.0.1` / `8790` | listen address |
| `DIAGRAM_TOKEN` | unset | bearer token; required when the host is not loopback |
| `DIAGRAM_DATA_DIR` | `diagram/data` | projects folder (git-ignored) |
| `DIAGRAM_AGENT_TIMEOUT_S` | `180` | limit per agent call |
| `DIAGRAM_CLAUDE_MODEL` | unset | passed as `--model` when set |
| `DIAGRAM_HERMES_URL` / `DIAGRAM_HERMES_KEY` / `DIAGRAM_HERMES_MODEL` | fall back to `FRIDAY_AGENT_URL` / `FRIDAY_AGENT_KEY` / `FRIDAY_AGENT_MODEL` | Hermes API server |

### Testing

- **Unit (node:test):** spec validation and normalization; every edit operation (immutability, undo / redo, lock tracking); every template's layout invariants on fixture specs at its minimum and maximum node counts with long Vietnamese text; theme contrast; icon fallback; ingest of each format from small fixtures built inside the tests; the URL guard (private addresses, redirects, size cap); adapter argument building and output parsing against a fake child process and a fake HTTP server.
- **Golden SVGs:** one snapshot per template and theme in `test/golden/`, regenerated only with `npm run golden:update`, and looked at as PNGs when they change.
- **Integration:** the HTTP API end to end with the `fake` agent: upload, segment, clarify, generate, edit, refine with locks, every export format; exported docx / pptx are re-ingested and checked, and when `soffice` is installed converted to PDF headlessly to prove Office can open them.
- **E2E (Playwright):** the real browser UI against the server with `DIAGRAM_AGENT=fake`: paste text, answer a question, pick a candidate, change theme and template, edit a label inline, undo, finish, export PNG and DOCX; editor screenshots at 1440 px and 390 px are inspected for visual defects.
- **One live run:** a single scripted run of the `claude-code` adapter on a short Vietnamese paragraph confirms the real CLI flags and output shape.
  No other test or development step may call Claude Code, Hermes or any paid API.
- Checks: `cd diagram && npm test && npm run e2e`.
  JS style follows `app/`: 2 spaces, single quotes, semicolons.
