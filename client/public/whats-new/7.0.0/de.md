## Ihre Musikbibliothek
![Albumseite](music.webp)
Musik gesellt sich zu Filmen, Serien und Büchern, von der Beschaffung bis zur Wiedergabe.

### Alben, wie sie erschienen sind
- Ein Album ist eine MusicBrainz-Veröffentlichung, mit seinem Cover aus dem Cover Art Archive und Künstlerbildern von Fanart.tv. Beides kommt über mit Fliks installierte Plugins. Andere Versionen desselben Albums werden auf seiner Seite in einer Zeile zusammengefasst.
- Folgen Sie einem Künstler, um die neuen Alben seiner Diskografie zu erhalten, gefiltert nach den Typen, die Ihre Bibliothek akzeptiert (Alben, EPs, Singles, Live...).
- Folgen Sie Listen von ListenBrainz, Last.fm, Spotify, Deezer oder MusicBrainz mit dem Plugin Music lists aus dem Katalog.

### Importieren Sie, was Sie schon haben
- Fliks liest Ihre Tags: Der Ordner ist das Album, Disc-Ordner werden zusammengeführt, und MusicBrainz-IDs entscheiden über die Zuordnung.
- Das Zurückschreiben von Tags in Ihre Dateien ist optional. Eine Lidarr-Bibliothek kann importiert werden.

### Songtexte
- Aus Ihren Dateien (eingebettet oder .lrc, .elrc, .ttml, .srt, .txt neben dem Titel), von LRCLIB (ein mit Fliks installiertes Plugin) oder von Ihnen selbst geschrieben mit einem Editor, in dem Sie per Tippen synchronisieren.
- Wort für Wort getimte Songtexte, wenn die Quelle sie hat. Ordnen Sie die Songtext-Quellen neu oder schalten Sie sie aus.

## Suchen, hören, mitnehmen
![Musiksuche](music-search.webp)

### Eine Suche
- Ein Top-Ergebnis, dann Titel, Alben und Künstler, mit den Trends von heute und dieser Woche.
- Fügen Sie einen einzelnen Titel oder ein ganzes Album hinzu, oder senden Sie eine Anfrage: Nutzer fragen an, Admins genehmigen.
- Die Vorschau beim Hinzufügen zeigt die Titelliste, bevor etwas heruntergeladen wird.

### Player
- Ein Mini-Player, der sich zum Vollbild-Player öffnet, mit Warteschlange, Songtexten und Lautstärkeausgleich pro Titel oder Album (ReplayGain).
- Intelligente Playlists und m3u-Import.
- Behalten Sie Titel, Alben, Playlists oder Künstler offline.

### Ihre Lieblings-Apps
- Fliks spricht OpenSubsonic: Verbinden Sie eine kompatible Musik-App mit einem Token aus Ihrem Konto.

## Karaoke
Singen Sie jeden Titel Ihrer Bibliothek. Ein Admin aktiviert Karaoke und installiert auf der Seite Karaoke ein Modell zur Stimmtrennung.

### Von Fliks vorbereitet
- Die Stimme wird von der Musik getrennt, auf Abruf beim Öffnen eines Titels oder im Hintergrund in Ihren Musikbibliotheken.
- Ohne wortgenau getimte Songtexte richtet Fliks den vorhandenen Text Wort für Wort aus. Vermutete Backing-Wörter erscheinen abgedunkelt.
- Eine Referenzmelodie wird gezeichnet, damit Sie den Noten folgen können.
- Die Arbeit kann auf einer GPU, auf dem Prozessor oder auf Ihren Optimierungs-Workern laufen.

### Auf der Bühne
- Eine Wertung pro Sänger, von Leicht bis Schwer, mit goldenen Noten, die doppelt zählen, und einer Bestenliste.
- Duette und überlappende Stimmen zeigen, welcher Sänger welche Zeile singt.
- Ändern Sie die Tonart passend zu Ihrer Stimme.

## Karaoke-Partys

### Alle singen
- In einer Party werden Handys zu Mikrofonen: Es wird nur die Tonhöhe gesendet, nie Ihre Stimme.
- Das Party-Programm ist die Sänger-Warteschlange, mit einem Schalter, damit die Sänger abwechselnd dran sind.

### Auf jedem Bildschirm
- Songtexte und getrennte Spuren laufen auf einem Chromecast.

### Bringen Sie Ihre Songs mit
- Importieren Sie UltraStar-Songs, einschließlich getrennter Spuren, und MP3+G-Discs mit ihrer CD+G-Grafik.

## Bibliotheksoptimierung
![Optimierungsverfolgung](optimize.webp)
Kodieren Sie Ihre Videodateien neu oder remuxen Sie sie, um Platz zu sparen oder sie direkt auf Ihren Geräten abzuspielen.

### Ein Profil pro Bibliothek
- Beginnen Sie mit Ausgewogen, Nur bereinigen oder Direkte Wiedergabe und passen Sie dann Video, Audio, Untertitel und Sicherungen an.
- Video wird nur dann in HEVC oder AV1 neu kodiert, wenn das wirklich effizienter ist als die Quelle. Schwarze Balken können beschnitten werden, HDR10+- und Dolby-Vision-Dateien können unangetastet bleiben.
- Audio- und Untertitelspuren werden nach Sprache sortiert und gekürzt. Kommentarspuren entfallen, unbekannte Sprachen bleiben immer erhalten.
- Sehen Sie die Wirkung pro Datei und pro Bibliothek in der Vorschau, bevor Sie starten. Neue Dateien können automatisch eingereiht werden, sobald sie alt genug sind.

### Sicherer Austausch
- Jede Ausgabe wird geprüft, bevor sie das Original ersetzt, das in einen Papierkorb wandert, aus dem Sie es bis zur Bereinigung wiederherstellen können.
- Eine Datei, die gerade abgespielt wird, wird nie ausgetauscht: Der Auftrag wartet.
- Geplante Prüfungen können Ihre gesamte Bibliothek lesen, um beschädigte Dateien zu finden.

### Mehr Maschinen
- Fügen Sie entfernte Worker mit einem Token hinzu und nutzen Sie mehrere GPUs pro Maschine, mit einer für die Wiedergabe freigehaltenen Reserve.
- Verfolgen Sie Warteschlange, Fehler und abgeschlossene Aufträge auf der Seite Optimierung, mit Zeitfenster, Pause und Priorität.
