# Diagram Studio

Diagram Studio turns text into editable diagrams, in the spirit of Napkin AI.
Paste text, upload a `.txt`, `.md`, `.docx` or `.pptx` file, or give a web address.
The AI splits the content into sections, asks when the meaning is unclear, and proposes three diagrams per section.
You pick one, switch template, theme and density, and edit labels, icons, colours and order directly on the canvas.
"Hoàn thiện với AI" then polishes the diagram while keeping every field you edited.
Export to PNG, SVG, PDF and Markdown, or put the diagrams back into the original Word or PowerPoint file.

The interface is in Vietnamese; diagram text stays in the language of the input.
It is a single-user app: projects are JSON files on disk, protected by one optional access token.

## Run locally

```sh
cd diagram
npm install
npm start
```

Open http://127.0.0.1:8790.
By default the AI is the local Claude Code CLI (`claude` must be on `PATH` and signed in).
For UI work without any AI calls, use the built-in fake agent:

```sh
DIAGRAM_AGENT=fake npm start
```

The server also reads the repository's root `.env`; a variable set in the real environment wins.

## Run on a server with Hermes

On a server the AI is a [Hermes Agent](https://hermes-agent.nousresearch.com/) API server, reached over its OpenAI-compatible API:

```sh
DIAGRAM_AGENT=hermes
DIAGRAM_HERMES_URL=https://hermes.example.com
DIAGRAM_HERMES_KEY=<the API_SERVER_KEY of that Hermes>
DIAGRAM_HOST=0.0.0.0
DIAGRAM_TOKEN=<a long random secret>
DIAGRAM_PUBLIC_ORIGIN=https://diagrams.example.com
```

- Put it behind an HTTPS reverse proxy; the token travels as a bearer header.
- `DIAGRAM_TOKEN` is required whenever `DIAGRAM_HOST` is not a loopback address, and the server refuses to start without it.
- The server only answers to the Host names it knows (`localhost`, `127.0.0.1`, `[::1]`, `DIAGRAM_HOST`, all on `DIAGRAM_PORT`), which blocks DNS rebinding.
  To reach it under any other name, such as a LAN address or the proxy's domain, set `DIAGRAM_PUBLIC_ORIGIN` to exactly the address in the browser.
- With `DIAGRAM_PUBLIC_ORIGIN` set, `X-Forwarded-For` from a proxy on the same machine is trusted, so failed-token limits apply per real client.
- `DIAGRAM_HERMES_URL` must be https, or http only on a loopback host, whenever a key is set.
- The Hermes key gives the agent's full toolset, so use a dedicated Hermes profile with a narrow toolset, as the root README's "Agent bridge" section explains.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DIAGRAM_AGENT` | `claude-code` | `claude-code`, `hermes` or `fake` |
| `DIAGRAM_HOST` / `DIAGRAM_PORT` | `127.0.0.1` / `8790` | listen address |
| `DIAGRAM_TOKEN` | unset | access token; required when the host is not loopback |
| `DIAGRAM_PUBLIC_ORIGIN` | unset | public `https://host` behind a reverse proxy |
| `DIAGRAM_DATA_DIR` | `diagram/data` | projects folder (git-ignored), relative to the repository root |
| `DIAGRAM_AGENT_TIMEOUT_S` | `180` | limit per agent call |
| `DIAGRAM_CLAUDE_MODEL` | unset | passed to `claude` as `--model` |
| `DIAGRAM_HERMES_URL` / `DIAGRAM_HERMES_KEY` / `DIAGRAM_HERMES_MODEL` | `FRIDAY_AGENT_URL` / `FRIDAY_AGENT_KEY` / `FRIDAY_AGENT_MODEL`, model `hermes-agent` | Hermes API server |
| `DIAGRAM_MAX_PROJECTS` | `500` | projects kept before new ones are refused |
| `DIAGRAM_AUTH_ATTEMPTS_PER_MINUTE` | `10` | failed tokens per client before `429` |
| `DIAGRAM_AGENT_CALLS_PER_MINUTE` | `20` | segment, generate and refine calls per client |
| `DIAGRAM_FAKE_DELAY_MS` | `0` | delay of each fake agent call, for testing progress and cancel |

## Checks

```sh
npm test       # unit and API tests (node:test), no network
npm run e2e    # Playwright, desktop 1440x900 and mobile 390x844, with the fake agent
```

The E2E run saves screenshots to `test-results/screens/`; look at them after UI changes.
Neither suite calls any AI: the Claude Code and Hermes adapters are tested with a fake process and a fake fetch.
`npm run golden:update` regenerates the golden SVGs and their previews in `test/golden/` after a deliberate renderer change.

## Architecture

- **Ingest** (`server/ingest/`) turns text, Markdown, Word, PowerPoint or a web page into a document of blocks.
  Office files are read with a hard cap on the inflated size, and web pages through an SSRF guard that checks every address at connection time.
- **Agent** (`server/agent/`) runs three tasks, `segment`, `generate` and `refine`, through one interface with three adapters: Claude Code (a child process), Hermes (HTTP) and a fake for tests.
  The AI only ever returns JSON, which is validated and normalised into a `DiagramSpec`.
- **Renderer** (`shared/render/`) is shared by browser and server: `layoutSpec` places the spec into a scene, and `paintScene` paints the scene as SVG with one of six themes.
  Each of the twelve templates is one file in `shared/render/templates/`.
- **Edits** (`shared/spec/ops.js`) are pure functions; every field you change is locked, so a later refine keeps it.
- **Export** (`server/export/`) renders the same SVG with text as paths, rasterises it with resvg, builds PDFs with pdfkit, and inserts PNGs into the original DOCX or PPTX.
- **Web** (`web/`) is plain ES modules without a build step: a store, a hash router and four panes (source, canvas, pickers, inspector).
