# Kenwarf

**Your company knowledge, answering with a source. Owned by you.**

Kenwarf is a self-hostable knowledge folder for small businesses, firms and teams. You add documents, notes and web pages; Kenwarf answers questions only with quotes that are machine-checked against the source file. If nothing fits, it says "not in here" instead of guessing. Every model, local or cloud, and every agent works with your context over MCP, with permissions and provenance. Switching models costs nothing, because the knowledge lives in plain Markdown files with a git history, not in the model.

> **Status: Preview, under active development.** Not launched. APIs, data format details and UI can change. There is no managed service, no trial and no pricing yet. Do not use it for sensitive production data without your own review.

*Name:* from *ken* (what you know) and *warf*, the raised mound on the North Sea coast that stays dry when the flood comes.

Website (preview): https://kenwarf.heidrich-digital.de

## What it does today

This list describes the code in this repository as of internal commit `73c1c17` (24 October 2026).


- Add files (PDF, Word, Markdown, text), web pages and imports from Obsidian, Notion, Outline, Confluence and Markdown folders. Audio files can be uploaded; they are transcribed only if a local Whisper is set up (not included in the standard image)
- Answers with numbered sources; every quote is verified verbatim against the cited line range, unverified points are dropped
- Facts with validity (prices, deadlines, responsibilities), contradiction and due-date checks
- Inbox with human approval: agents and OAuth clients only ever write proposals, a person approves; every approval is a git commit
- Roles (reader, author, approver, admin), teams, per-file visibility; permissions are checked before search
- MCP server (Streamable HTTP, per-person keys) with 11 tools: `kern_suche`, `kern_lese`, `kern_frage`, `kern_fakten`, `kern_kontext`, `kern_wegweiser`, `kern_briefing`, `kern_eingang`, `kern_vorschlag`, `kern_gedaechtnis`, `kern_sammelfreigabe`. Agents and OAuth clients can only propose. Approving over MCP (`kern_sammelfreigabe`) needs a person's own key with the explicit scope `kern:freigeben`; agents and OAuth never get it. `kern_gedaechtnis` writes the agent's own working notes under `/memories/notizen/`, separate from the knowledge; changes to knowledge become proposals
- OAuth 2.1 for MCP clients (protected resource metadata, authorization server metadata, dynamic client registration) and local MCP over stdio (`kern mcp`, also as a bridge into a VPN) are built and tested; a field test with ChatGPT and Claude is still pending
- Setup wizard on first sign-in; a generated first password must be replaced by your own
- Test bench per model (`kern pruefbank`) with a gate before switching models, and an exit test (`kern ausstiegsprobe`) that exports, re-imports and compares
- Bring your own model: Claude, ChatGPT/Codex, Gemini (via its OpenAI-compatible endpoint), an EU provider or a local model (Ollama, llama.cpp, vLLM). Settings show which provider and endpoint receive which data
- Export at any time as ZIP with full history or in the open OKF folder format; import back with a round-trip test
- German web UI and CLI

## 5-minute start (Docker)

There is no published image yet, so build it from source first. Building takes several minutes and depends on your network. The five minutes count from `docker run` with the finished image: our stopwatch test measured about 10 seconds to the first answer with a source, using the test AI.

```sh
git clone https://github.com/tillheidrich/kenwarf && cd kenwarf
docker build -f deploy/Dockerfile -t kenwarf:preview .
docker run -d --name kenwarf -p 127.0.0.1:7480:7480 -v kenwarf-daten:/daten kenwarf:preview
docker logs kenwarf | grep ERSTZUGANG     # user "admin", one-time password
```

Open http://127.0.0.1:7480, sign in, add a document under "Hinzufügen", ask under "Fragen". Without an AI provider Kenwarf runs in test mode: search and verbatim excerpts with sources, no generated prose.

Demo company with made-up data (never for real data). Random passwords for the demo users are printed once in the log:

```sh
docker run -d --name kenwarf-demo -p 127.0.0.1:7481:7480 -e KERN_DEMO=1 -v kenwarf-demo:/daten kenwarf:preview
docker logs kenwarf-demo | grep -A9 DEMO-ZUG
```

## Three ways to run it

| Way | For | Data lives |
|---|---|---|
| Local (`docker run`, Compose with Ollama) | trying it out, single user, law firm with a local model | on your machine |
| Your own EU cloud (Hetzner cloud-init, Docker Compose, Coolify) | businesses with IT or a managed service provider, schools, associations | at your hoster |
| Managed by Heidrich Digital | people who do not want to run anything | one instance per customer at an EU hoster (in preparation, not available yet) |

Details: [`deploy/README.md`](deploy/README.md) (German).

## Repository

| Package | Purpose |
|---|---|
| `packages/core` | engine: folder, index, search, facts, inbox, quote check, export/import |
| `packages/server` | REST API and MCP server |
| `packages/cli` | command line `kern` |
| `packages/web` | web UI (German) |
| `packages/import-outline` | importer for Outline wikis |
| `packages/betrieb` | operator console for the planned managed service (preview) |
| `deploy/` | Dockerfile, Compose, Caddy, cloud-init, backup and migration scripts |

> The package scope `@kern/*`, the CLI name `kern`, environment variables `KERN_*` and parts of the UI still use the former working title "Kern". They will be renamed to Kenwarf.

Build and test (Node 22):

```sh
npm ci
npm run build
npm test
```

## Security

Kenwarf is preview software. Please report vulnerabilities privately, see [SECURITY.md](SECURITY.md). Design notes: passwords with scrypt, `__Host-` session cookies over HTTPS, CSRF header for writes, CSP `self`, MCP keys stored as SHA-256 and revocable. Agents and OAuth clients can only propose; approving over MCP needs a person's own key with the scope `kern:freigeben`. CI runs build, tests, `npm audit` on runtime dependencies, a license check (only permissive licenses compatible with AGPL-3.0, such as MIT, BSD, ISC, Apache-2.0, Zlib) and a CycloneDX SBOM.

## Known issues

- No published container image yet; build from source.
- Internal names still say `kern` (see above).
- OAuth 2.1 and local MCP are built; a field test with ChatGPT and Claude is pending.
- Test bench and prompt-injection checks so far run with the test AI only, not yet with a real model.
- Audio transcription needs a local Whisper that is not part of the image.
- Managed service, trial and billing (Mollie) are not live.

## License

[AGPL-3.0-only](LICENSE). Self-hosting is free. If you offer a modified version as a service to others, you must publish your changes.

---

## Deutsch

**Kenwarf ist ein Wissensordner für Betriebe, der nur mit Beleg antwortet und dir gehört.** Quellen hinein, Fragen stellen, Antworten mit wörtlich geprüftem Zitat. Steht nichts drin, sagt Kenwarf „steht nicht drin“. Das Wissen liegt als Markdown-Dateien mit git-Verlauf bei dir, jede KI und jeder Agent arbeitet über MCP damit, mit Rechten und Herkunft. Claude, ChatGPT/Codex, Gemini (über OpenAI-kompatible Schnittstelle), ein EU-Anbieter oder ein lokales Modell: du entscheidest. Kenwarf zeigt dir ehrlich, wohin die Daten dabei gehen.

**Stand: Vorschau, in aktiver Entwicklung, noch nicht gestartet.** Managed-Dienst, Testphase und Preise gibt es noch nicht.

Start in fünf Minuten: siehe „5-minute start“ oben (Docker, Bau aus dem Quellcode). Betrieb, Sicherung und Umzug: [`deploy/README.md`](deploy/README.md). Sicherheitslücken bitte vertraulich an info@tillheidrich.de melden ([SECURITY.md](SECURITY.md)).

Website (Vorschau): https://kenwarf.heidrich-digital.de

Ein Projekt von Heidrich Digital, einem Angebot von Till Heidrich – Content Creation, Tostedt.
