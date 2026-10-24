# @kern/cli

Kommandozeile `kern`. Wirkt direkt auf den Datenordner (wer Dateizugriff hat, hat volle Rechte). Handelnder Benutzer: `--als <name>`, `KERN_ALS` oder der erste Admin.

```sh
kern init ./kern-data --betrieb "Tischlerei Beispiel" --admin chef     # Passwort per Eingabe oder KERN_PASSWORT
kern -d ./kern-data nutzer anlegen lisa --rollen leser,autor --teams buero
kern -d ./kern-data nutzer liste
kern -d ./kern-data token anlegen lisa -b "Claude Desktop"           # Token für /mcp, nur einmal sichtbar
kern -d ./kern-data token liste | kern token widerrufen <id>
kern -d ./kern-data add handbuch.pdf --sammlung betrieb --sichtbarkeit betrieb
kern -d ./kern-data add https://example.de/agb --beobachten
echo "Kaffee steht im Schrank." | kern -d ./kern-data add - --titel Küche
kern -d ./kern-data suche "Urlaub"
kern -d ./kern-data frage "Wie lange vorher Urlaub beantragen?"
kern -d ./kern-data fakten --art preis --gueltig-am 2026-11-01
kern -d ./kern-data eingang
kern -d ./kern-data freigeben <id> -b "geprüft"   |   kern ablehnen <id>
kern -d ./kern-data reindex
kern -d ./kern-data serve --port 7480
kern -d ./kern-data export sicherung.zip [--ohne-git]   # ZIP ohne .kern/
kern -d ./kern-data export --okf ./okf-ausgabe
kern -d ./kern-data import --okf ./okf-eingang        # auch --obsidian, --notion, --outline, --confluence, --markdown; wird zu Quellen und Vorschlägen
kern -d ./kern-data pruefen [--json]                  # Exit-Code 1 bei Fehlern
```

Alle Befehle haben `--help` (deutsch), Lesebefehle `--json`.

`kern pruefen` nutzt `pruefe()` aus core (v1.1) und ergänzt: Pflichtfelder im Kopf, Abgleich Dateien gegen das, was core liefert (`index_veraltet`). Ohne `pruefe()` prüft die CLI Fundstellen (Datei und Zeilenbereich) und Prüftermine selbst.

ZIP: eigener Schreiber ohne Abhängigkeit (Deflate, UTF-8-Namen), ohne ZIP64: höchstens 65.535 Dateien und je Datei unter 4 GB. Symbolische Links werden nicht verfolgt.
