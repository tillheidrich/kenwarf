# @kern/import-outline

Import-Art `outline` für Kern. Übernimmt ein Outline-Wiki als **Quellen plus Vorschläge im Eingang**. Ins Wissen kommt nur, was ein Mensch freigibt.

## Eingaben

| Eingabe | Erkennung | Kennungen | Rechte | Kommentare | Anhänge |
|---|---|---|---|---|---|
| Outline-API (`OUTLINE_URL`, `OUTLINE_API_TOKEN`) | ohne Pfad | ja | ja (`permission`) | ja | Download über `attachments.redirect` |
| JSON-Export (ZIP oder Ordner) | `metadata.json` + `<Sammlung>.json` | ja | ja | nein | im Archiv |
| OKF-Export (Outline ≥ 1.10.1) | `index.md` mit `okf_version` | urlId aus `resource` | nein | nein | im Archiv |
| Markdown-Export | sonst | nein (Pfad) | nein | nein | im Archiv |
| MCP-Abzug | Ordner mit `sammlungen.json` und `dokumente/` | ja | ja | ja | nur Verweise |

Der API-Leser ruft nur lesende Methoden auf (`collections.list`, `collections.documents`, `documents.list`, `documents.info`, `documents.archived`, `comments.list`, `attachments.redirect`). Der Schlüssel steht nie im Code, in Berichten oder in Dateien.

## Was entsteht

* je Dokument eine Quelle (`quellen/<jahr>/<titel>.md`, Original mit Outline-Kopf daneben als `.orig.md`), Sammlung `outline-<gruppe>`
* je Dokument ein Vorschlag `wissen/<gruppe>/<titel>.md` mit Kopf (Kurzfassung, Stand, Verantwortlich, Sichtbarkeit, Fundstelle auf die Quelle, `outline_schluessel`, `outline_url`, `eltern`) und umgeschriebenen Links
* Kommentare als eigene Quelle `Kommentare: <Titel>`
* PDF, DOCX, Markdown, Text und HTML als Quelle; Bilder und andere Dateien bleiben vorerst auf Outline verlinkt und stehen im Bericht

Sichtbarkeit: Outline-Sammlungen für den ganzen Arbeitsbereich werden `betrieb`, private Sammlungen `ich` (sicherste Wahl, weil die Mitgliederliste nicht übertragbar ist). Abweichungen über `--rechte rechte.yaml`.

## Aufruf

```sh
kern-import-outline export.zip --daten ./kern-data --trockenlauf      # planen, nichts schreiben
kern-import-outline export.zip --daten ./kern-data --rechte rechte.yaml
OUTLINE_URL=https://wiki.example.de OUTLINE_API_TOKEN=… kern-import-outline --daten ./kern-data --sammlung "Marke & Branding"
kern-import-outline export.zip --bestand                              # nur zählen
```

Wiederholte Läufe sind sicher: Gleiches bleibt unverändert, Geändertes wird neue Quellfassung plus Änderungsvorschlag mit Diff, nichts doppelt.

Als Bibliothek: `lese()`, `importiereOutline(kern, user, buendel, optionen)`, `berichtAlsMarkdown()`.

## Tests

`npm test -w packages/import-outline`. Der Probeimport (`test/probe.test.ts`) erzeugt einen erfundenen MCP-Abzug und läuft immer mit.
