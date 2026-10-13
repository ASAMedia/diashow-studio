# Handbuch

## Erste Schritte {#start}

Diashow Studio macht aus Fotos, Videos und Musik eine Diashow und speichert sie als MP4-Video. Alles läuft auf deinem PC, ohne Internet.

Am schnellsten geht es mit dem **Assistenten**: Er öffnet sich beim ersten Start, später über **Neue Diashow mit Assistent** auf der Startseite.

1. **Fotos und Videos:** einzelne Dateien oder einen ganzen Ordner wählen. Unterordner werden mitgenommen.
2. **Thema und Musik:** ein Thema anklicken und, wenn du magst, eigene Musik hinzufügen.
3. **Zeigen oder exportieren:** die Diashow abspielen oder als Video speichern.

![Der Assistent: Thema und Musik wählen](wizard.jpg)

Andere Wege zur neuen Diashow:

- Fotos, Videos oder Ordner einfach ins Fenster ziehen.
- **Neue Diashow** wählt Dateien aus; **Ordner abspielen** zeigt einen Ordner sofort als Diashow.
- **Projekt öffnen…** lädt eine `.dshow`-Datei, z. B. ein gepacktes Projekt von einem anderen PC.

Projekte werden automatisch gespeichert, in `Dokumente\Diashow Studio`. Neue Fotos werden im Hintergrund vorbereitet; du kannst sofort weiterarbeiten.

![Die Startseite mit deinen Diashows](home.jpg)

## Bearbeiten {#edit}

Der Editor hat drei Bereiche: die **Vorschau** in der Mitte, rechts die Reiter **Themen**, **Musik**, **Dauer** und **Folie**, und unten den **Filmstreifen** mit allen Folien.

![Der Editor](editor.jpg)

- **Reihenfolge:** Folien im Filmstreifen ziehen. Eine Folie auf die Mitte einer anderen ziehen fasst beide zu einer Folie zusammen.
- **Mehrere Folien:** [[Strg]]+Klick, [[Umschalt]]+Klick oder [[Strg+A]]. Der Reiter **Folie** ändert dann alle zusammen.
- **Anzeigedauer:** am rechten Rand einer Karte ziehen; Doppelklick dort stellt wieder „automatisch“ ein.
- **Ausschnitt:** im Vorschaubild ziehen verschiebt das Foto, das Mausrad zoomt, Doppelklick setzt zurück.
- **Texte:** **Text hinzufügen** erzeugt eine Textfolie. Im Reiter **Folie** fügst du Textfelder auf ein Foto ein.
- **Kapitel:** im Menü **⋯** gibt es **Tagestitel aus Aufnahmedatum** und **Kapitel aus Ordnernamen**, außerdem **Nach Aufnahmedatum sortieren** und **Abspann hinzufügen**.
- **Videos:** im Reiter **Folie** kürzen, Tempo ändern (Zeitlupe/Zeitraffer) und **Verwacklung beruhigen**.
- **Rückgängig:** [[Strg+Z]], wiederholen mit [[Strg+Y]]. Das geht auch nach einem Neustart: Jede Diashow behält ihre letzten 100 Schritte.

> Tipp: Mit [[Leertaste]] spielst du die Vorschau ab, mit [[←]] und [[→]] springst du von Folie zu Folie.

### Filmstreifen: Zoom, Suche und Kapitel

- **Zoom:** Mit − und + oder dem Regler rechts über dem Filmstreifen werden die Folien kleiner oder größer, ebenso mit [[Strg]]+Mausrad über dem Filmstreifen (dann bleibt die Stelle unter der Maus stehen). **Ganze Diashow zeigen** passt alle Folien in die Breite. Kleine Karten zeigen nur noch Bilder; eine dünne blaue Linie markiert jedes Kapitel. Die Tonspur darunter passt bei jeder Größe.
- **Suche:** [[Strg+F]] oder die Lupe. Gesucht wird in Dateinamen, Kapiteln und Tagestiteln, Bildtexten, Textfolien, Textfeldern, Namen aus der Personenliste und im Aufnahmedatum: „12.5.“, „12. Mai“, „Dienstag“, „Mai 2025“, auch englisch („May 12“, „Tuesday“). „Video“ und „Live“ finden Videos und Live Photos. Bei mehreren Wörtern muss jedes passen.
- Die Treffer stehen in einer Liste über dem Suchfeld und sind im Filmstreifen gelb markiert. [[↑]] / [[↓]] und [[Enter]] springen zu einem Treffer: Die Folie wird ausgewählt und in der Vorschau gezeigt. [[Enter]] / [[Umschalt+Enter]] oder [[F3]] / [[Umschalt+F3]] gehen zum nächsten / vorigen Treffer, [[Esc]] schließt die Suche.
- **Kapitel:** Das Menü **Kapitel** listet Titel, Kapitel und Textfolien mit ihrer Zeit; ein Klick springt hin.

### Fotos an einer Stelle einfügen

- **Aus dem Explorer ziehen:** Fotos, Videos oder Ordner zwischen zwei Karten des Filmstreifens ziehen; eine blaue Linie zeigt, wo sie landen. Sie werden wie beim Hinzufügen eingelesen (Live Photos und RAW+JPEG als ein Foto) und nach Aufnahmezeit geordnet. Auf die Mitte einer Karte gezogen, kommen sie mit auf diese Folie, wenn das Thema mehrere Fotos pro Folie zeigt und Platz ist. Woanders im Fenster abgelegt, landen sie wie bisher hinter der Auswahl.
- **Kopieren und einfügen:** Im Explorer kopierte Dateien ([[Strg+C]]) fügt [[Strg+V]] hinter der ausgewählten Folie ein, ohne Auswahl am Ende. Ein kopiertes Bild ohne Datei, etwa ein Bildschirmfoto mit [[Win+Umschalt+S]], speichert die App als PNG in `Dokumente\Diashow Studio\Eingefügt\<Diashow>` und fügt es ein. **Nach dem Projekt aufräumen** kann diese Bilder wieder löschen.
- **Einfügen…** im Menü einer Folie wählt Dateien aus und setzt sie hinter diese Folie.

Die eingefügten Folien sind danach ausgewählt; [[Strg+Z]] nimmt das ganze Einfügen in einem Schritt zurück. In Themen mit mehreren Fotos pro Folie (Magazin, Origami, …) bleiben alle anderen Folien, wie sie sind: Die neuen Fotos bilden eigene Folien. Sollen die Folien wieder nach dem Muster des Themas gemischt werden, klicke über dem Filmstreifen auf **Automatisch gruppieren** (siehe [Themen](#themes)).

### Fotos, die schon in der Diashow sind

Was schon in der Diashow ist, kommt nicht noch einmal hinein – beim Hinzufügen von Fotos oder Ordnern, beim Ziehen ins Fenster oder in den Filmstreifen, mit [[Strg+V]], **Einfügen…**, im Assistenten und bei Uploads aus dem WLAN. Als „schon da“ zählt:

- dieselbe Datei, auch wenn ihre Folie herausgenommen ist;
- eine Kopie unter anderem Namen oder in einem anderen Ordner, die Byte für Byte gleich ist;
- dieselbe Datei zweimal in einer Auswahl: nur die erste kommt hinein;
- dasselbe Foto als HEIC und als JPEG vom selben Handy (gleiche Kamera, Bildgröße und Aufnahmezeit auf die Millisekunde). Serienbilder sind verschiedene Fotos und kommen alle hinein.

Ein Hinweis unten rechts sagt, wie viele übersprungen wurden. **Zeigen** wählt die vorhandenen Folien im Filmstreifen aus, **Trotzdem einfügen** fügt sie doch hinzu ([[Strg+Z]] nimmt das in einem Schritt zurück). Verkleinerte Kopien, etwa aus WhatsApp, findet **Ausschuss prüfen…** (siehe [Sichten](#cull)).

### Fotos bearbeiten

Schiefe oder liegende Handyfotos richtest du wie in Fotos auf dem Mac: Foto auswählen und im Reiter **Folie** unter **Bild** auf **Bearbeiten** klicken (oder **Bearbeiten** im Menü der Folie). Über der Vorschau erscheint das Werkzeug **Zuschneiden**:

- **Drehen:** Die Pfeile drehen um 90° nach links oder rechts. [[Strg+R]] dreht alle ausgewählten Fotos nach links, auch auf mehreren Folien.
- **Begradigen:** Der Regler neigt das Bild um bis zu 45°. Es wird dabei so weit vergrößert, dass keine leeren Ecken entstehen.
- **Zuschneiden:** Ecken und Kanten des Rahmens ziehen oder den Rahmen verschieben. **Format** hält ein Seitenverhältnis fest (Frei, Original, 1:1, 4:3, 3:2, 16:9, 9:16); der Knopf daneben tauscht Hoch- und Querformat.
- **Zurücksetzen** nimmt Drehen, Begradigen und Zuschnitt zurück, **Abbrechen** ([[Esc]]) verwirft die Änderungen, **Fertig** ([[Enter]]) übernimmt sie. Jeder Schritt lässt sich mit [[Strg+Z]] rückgängig machen.

Das zweite Werkzeug, **Licht und Farbe**, hilft bei dunklen Handyfotos, orangem Kunstlicht und flauen Bildern. Dieselben Regler stehen auch im Reiter **Folie** unter **Bild**:

- **Helligkeit** hellt Schatten und Mitteltöne auf, ohne helle Stellen abzuschneiden.
- **Kontrast** setzt Schatten und Lichter weiter auseinander oder näher zusammen.
- **Wärme** macht das Bild wärmer oder kühler, ohne seine Helligkeit zu ändern. Gegen orangefarbenes Kunstlicht ziehst du sie nach links.
- **Sättigung** macht die Farben kräftiger oder blasser.

Jeder Regler reicht von −100 bis +100; der Pfeil daneben oder ein Doppelklick setzt ihn auf 0. Sind mehrere Folien ausgewählt, gilt ein Regler für alle ihre Fotos und Videos. Der Look der Diashow kommt danach obendrauf und wirkt so auf alle Fotos gleich. Bearbeitete Folien zeigen im Filmstreifen ein kleines Regler-Zeichen.

![Licht und Farbe in der Bearbeitungsansicht](edit.jpg)

Das bearbeitete Foto erscheint überall: in jeder Folie, beim Ken-Burns-Effekt, im Filmstreifen, beim Sichten und im Export. Den Ausschnitt in der Folie verschiebst du danach wie gewohnt. Verpixelte Gesichter bleiben auf denselben Gesichtern und bleiben verpixelt, auch wenn du das Bild aufhellst. Videos bearbeitest du genauso.

> Mit der Tastatur: Die Pfeiltasten verschieben den Rahmen, mit [[Umschalt]] ändern sie seine Größe. Die Regler für Licht und Farbe bewegst du mit den Pfeiltasten, mit [[Umschalt]] in Zehnerschritten.

## Themen und Looks {#themes}

Das **Thema** bestimmt, wie die Folien aussehen und wechseln. Es gibt 11 Themen, z. B. **Ken Burns** (langsame Fahrten über das Foto), **Magazin** (mehrere Fotos im Raster) oder **Schnappschüsse** (Sofortbilder auf einem Tisch).

- Themen mit mehreren Fotos pro Folie ordnen die Fotos selbst an. Im Reiter **Folie** wählst du ein anderes Layout oder **Frei** für eine eigene Collage.
- **Automatisch gruppieren:** Folien, die du zusammengefasst oder geteilt hast, und Folien, die beim Einfügen festgehalten wurden, behalten ihre Fotos, auch nach einem Themenwechsel. Über dem Filmstreifen steht dann, wie viele es sind, z. B. **3 feste Folien · Automatisch gruppieren**; ein Klick darauf lässt das Thema alle Fotos wieder nach seinem Muster verteilen. Für einzelne Folien steht **Automatisch gruppieren** im Menü der Folie. **Nach Aufnahmedatum sortieren** gruppiert immer neu. [[Strg+Z]] macht es rückgängig.
- Der **Look** (Natürlich, Lebendig, Warm, Kühl, Dramatisch, Verblasst, Schwarzweiß, Noir) färbt nur die Fotos und Videos, nicht den Hintergrund.
- **Fotos bildfüllend zuschneiden** gilt für die ganze Show; jedes Foto kann mit **Ganzes Bild** eine Ausnahme sein.
- **Titel:** Titeltext, Schrift, Größe, Farbe und eine Animation (Handschrift, Schreibmaschine, großes Datum) stellst du im Reiter **Themen** ein.
- Im Thema **Klassisch** wählst du den Übergang (Überblenden, Schieben, Würfel …) im Reiter **Dauer**.

### Panoramen

Sehr breite Fotos, z. B. Panoramen vom Handy, zeigt die Diashow wie Fotos auf dem Mac: Sie bekommen eine eigene Folie, füllen deren Höhe, und die Ansicht fährt in ruhigem, gleichmäßigem Tempo von einem Ende zum anderen. Sehr hohe Fotos fahren von oben nach unten. Als Panorama gilt ein Foto ab doppelt so breit wie hoch, das deutlich breiter als die Diashow ist (bei 16:9 ab etwa 2,5:1). Seine Folie dauert länger, je breiter es ist, höchstens zweieinhalbmal so lange wie ein Foto; eine eigene Dauer gilt trotzdem. Im Filmstreifen tragen solche Folien einen Doppelpfeil.

- Im Reiter **Folie** wählst du unter **Panorama** für ein oder mehrere Panoramen **Schwenk**, **Ganzes Bild** oder **Zuschneiden** und die **Richtung** (links → rechts oder rechts → links, oben → unten oder unten → oben).
- In **Ken Burns** ist der Schwenk der Start- und Endausschnitt; einen eigenen Ausschnitt legst du wie gewohnt fest.
- **Magazin** zeigt das Panorama auf der ganzen Seite, **Reflexionen** als breite Karte, **Vintage-Abzüge**, **Sammelalbum** und **Schnappschüsse** als breiten Abzug, in dem das Bild wandert.
- Verpixelte Gesichter bleiben beim Schwenken verpixelt.

## Musik {#music}

Im Reiter **Musik** fügst du eigene Musikdateien hinzu (MP3, M4A, WAV, FLAC und mehr). Mehrere Songs bilden eine Wiedergabeliste, die du per Ziehen ordnest.

Jedes Thema hat eigene Musik (CC0 oder gemeinfrei, frei nutzbar, auch in geteilten Videos); deine eigene Musik ersetzt sie. Unter **Themenmusik** wählst du einen anderen Song des Themas, eines anderen Themas oder aus der **Musikbibliothek**, die du nach **Stimmung** filterst (z. B. **Feierlich** für eine Zeugnisausgabe oder **Weihnachtlich**). **Zur eigenen Musik hinzufügen** übernimmt den gewählten Song in die Wiedergabeliste, wo du ihn kürzen oder einem Kapitel geben kannst.

![Musik mit Wellenform und Taktmarken](music.jpg)

- **An Musik anpassen** (Reiter **Dauer**): Die Diashow dauert genau so lange wie die Musik. Alternativ legst du eine eigene Gesamtdauer fest.
- **Folienwechsel im Takt der Musik** legt jeden Wechsel auf einen Schlag.
- Die **Schere** neben einem Song wählt Anfang und Ende, z. B. um ein langes Intro zu überspringen.
- **Musik ab hier:** Ein Song kann ab einer Kapitel-Folie spielen, etwa eigene Musik für jeden Tag einer Klassenfahrt.
- Bei Videos mit Ton wird die Musik automatisch leiser. **Lautstärke angleichen** bringt Songs und Videoton auf denselben Pegel.

## Sichten {#cull}

**Sichten** (oben rechts) zeigt alle Fotos und Videos als Raster. So gehst du einen großen Import schnell mit der Tastatur durch.

![Sichten: aussortieren und bewerten](cull.jpg)

- [[X]] nimmt ein Bild aus der Diashow (es bleibt im Projekt) und holt es zurück.
- [[1]] bis [[5]] vergibt Sterne, [[Leertaste]] zeigt das Bild groß.
- Filter zeigen z. B. nur **Herausgenommen**, nur Bilder mit Sternen oder **Unscharf & Doppelte**.
- **Nur ab 3 ★ in die Diashow** (oder eine andere Zahl) behält nur die besten.
- **Ausschuss prüfen…** im Menü **⋯** findet unscharfe Fotos und Doppelte, auch dasselbe Video zweimal (z. B. aus WhatsApp).

## Datenschutz: Gesichter verpixeln {#privacy}

Für Schülerinnen und Schüler ohne Fotoerlaubnis kannst du Gesichter verpixeln. Die Gesichtserkennung läuft offline auf deinem PC; kein Bild verlässt ihn.

![Gesichter verpixeln](privacy.jpg)

1. Folie auswählen, im Reiter **Folie** auf **Gesichter verpixeln…** klicken.
2. Ein erkanntes Gesicht anklicken, oder mit der Maus einen Bereich aufziehen.
3. Mit dem Personen-Knopf (**Diese Person überall verpixeln**) an einem Gesicht wird diese Person in **allen** Fotos und Videos der Show gesucht und verpixelt. Die Personenliste zeigt die Treffer; einen falschen Treffer entfernst du mit ✕.

- In Videos wird ein angeklicktes Gesicht durch den ganzen Clip verfolgt.
- Vor dem Export zeigt **Gesichter prüfen …** (Menü **⋯** oder im Export-Dialog) alle Folien mit Gesichtern, die noch nicht verpixelt sind.

> Prüfe das Ergebnis immer selbst: Die Erkennung findet nicht jedes Gesicht, z. B. im Profil oder sehr klein.

## Exportieren und Warteschlange {#export}

**Exportieren** (oben rechts) speichert die Diashow als MP4-Video. Wähle eine Vorgabe wie **YouTube 1080p**, **WhatsApp / E-Mail (klein)** oder **Fernseher / Beamer** – oder stelle Auflösung, Bildrate und Qualität selbst ein.

![Der Export-Dialog](export.jpg)

- Exporte laufen im Hintergrund, nacheinander. Du kannst währenddessen weiterarbeiten; die Titelleiste zeigt den Fortschritt.
- Jeder Export ist eine Momentaufnahme: spätere Änderungen verändern ihn nicht.
- Nach einem Absturz oder Neustart geht es mit **Fortsetzen** in der Liste **Exporte** weiter.
- Grafikkarten (NVIDIA, Intel, AMD) machen den Export deutlich schneller. Der PC geht währenddessen nicht in den Ruhezustand.

![Die Liste der Exporte](queue.jpg)

## Im WLAN teilen {#share}

Über **⋯ → Im WLAN teilen** tauschst du Fotos und Videos mit Handys aus – nur im lokalen Netz, ohne Internet und ohne App.

![Fotos von Handys einsammeln](share.jpg)

- **Fotos einsammeln:** Der Laptop zeigt einen QR-Code. Die Schülerinnen und Schüler öffnen damit eine Seite und laden Fotos und Videos hoch. Sie landen in `Dokumente\Diashow Studio\Uploads` und direkt in der Show. Schicken zwei dasselbe Foto, kommt es nur einmal in die Show; die Liste zählt das zweite als „schon vorhanden“.
- **Video verteilen:** Ein fertiger Export kann auf den Handys angesehen und gespeichert werden. Für Handys gibt es eine kleine 720p-Fassung.
- Der Server läuft nur, solange der Dialog offen ist, und antwortet nur auf Links mit einem Zufallsschlüssel.

> Beim ersten Mal fragt Windows, ob die App ins Netzwerk darf: **Zulassen** (privates Netzwerk). In Gäste-WLANs, die Geräte voneinander trennen, hilft der mobile Hotspot von Windows.

## Nach dem Projekt aufräumen {#cleanup}

Ist die Diashow fertig, entfernst du an einer Stelle, was die App zu ihr gespeichert hat: **⋯ → Nach dem Projekt aufräumen…**, der Radiergummi an der Diashow auf der Startseite oder **Einstellungen → Datenschutz**. Der Dialog zeigt jeden Teil mit seiner Größe:

- **Gesichtsdaten:** erkannte Gesichter, Gesichtsmerkmale und die Personenliste mit den Namen, auch in älteren Versionen und im Zwischenspeicher. Was verpixelt ist, bleibt verpixelt, in der Vorschau und in jedem späteren Export. Neue Fotos werden danach aber nicht mehr automatisch erkannt.
- **Hochgeladene Fotos und Videos** der Klasse (`Dokumente\Diashow Studio\Uploads`) und mit [[Strg+V]] eingefügte Bilder (`Dokumente\Diashow Studio\Eingefügt`): alle oder nur die, die nicht in der Show sind. Folien mit gelöschten Fotos verschwinden aus der Show; exportiere vorher.
- **Zwischenspeicher** (Vorschaubilder, Videokopien, Ton): entsteht bei Bedarf neu.
- **Ältere Versionen** und **Export-Aufträge** (Momentaufnahmen in der Warteschlange).
- **Rückgängig-Verlauf:** frühere Stände der Diashow, damit [[Strg+Z]] auch nach einem Neustart geht. Löschst du Gesichtsdaten oder hochgeladene Fotos, wird er immer mitgelöscht, weil die früheren Stände sie noch enthalten. In **Einstellungen → Datenschutz** löschst du ihn auch für eine oder alle Diashows.

![Nach dem Projekt aufräumen](cleanup.jpg)

Deine eigenen Fotos, Videos und Musik und die exportierten Videos bleiben unberührt. Gelöscht wird endgültig, nicht in den Papierkorb.

**Löschfrist:** Im selben Dialog (oder nach dem Export) legst du fest, wann aufgeräumt werden soll: in 1, 3, 6 oder 12 Monaten oder an einem Datum. Ist der Tag da, zeigt die Startseite einen Hinweis an der Diashow und **Löschfrist erreicht: aufräumen?**; **In einem Monat erinnern** verschiebt sie.

> Beim **Löschen** einer Diashow fragt die App, ob ihr Zwischenspeicher, die hochgeladenen Fotos und die Export-Aufträge mitgehen sollen.

Ein [ZIP-Archiv der Diashow](#projects) ist eine Kopie, die das Aufräumen nicht erreicht; lösche es selbst.

## Vorführen {#present}

- **Abspielen** zeigt die Diashow im Vollbild ([[Esc]] beendet).
- **Präsentieren** (Menü **⋯**) zeigt die Show auf dem Beamer und auf dem Laptop die aktuelle und die nächste Folie mit Zeit und Steuerung.
- Der **Kioskmodus** (Einstellungen) startet die App direkt mit einer Diashow in Endlosschleife, z. B. für den Tag der offenen Tür.

## Projekte sichern und mitnehmen {#projects}

- **Ältere Version wiederherstellen…** (Menü **⋯**): Vor dem Speichern wird die vorige Version aufgehoben (die letzten 20).
- **Projekt packen…** kopiert das Projekt mit allen Fotos, Videos und Musik in einen Ordner, z. B. für einen USB-Stick. Am anderen PC öffnest du die `.dshow`-Datei.
- Wurden Originale verschoben (anderer Ordner, neuer Laufwerksbuchstabe), findet **Ordner durchsuchen…** im gelben Hinweis sie wieder.

### Diashow als ZIP archivieren

Ist die Diashow fertig, legt **⋯ → Als ZIP archivieren…** (oder das Archiv-Symbol an der Diashow auf der Startseite) alles in eine einzige ZIP-Datei, z. B. für das Schularchiv oder einen USB-Stick: das Projekt, die Original-Fotos und -Videos, deine Musik oder die Themenmusik, auf Wunsch die fertigen Exporte und eine kurze Anleitung (`LIESMICH.txt`).

![Diashow als ZIP archivieren](archive.jpg)

- Der Dialog zeigt jeden Teil mit seiner Größe, die Summe und den freien Platz am Ziel. Aussortierte Fotos kommen nur mit, wenn du es ankreuzt; **Gesichtsdaten weglassen** ist voreingestellt, verpixelt bleibt verpixelt.
- Fehlende Originale werden genannt und übersprungen. Nach dem Schreiben liest die App das Archiv noch einmal und prüft es.
- **Öffnen:** das ZIP entpacken (Rechtsklick → **Alle extrahieren…**) und die `.dshow`-Datei doppelklicken oder **Projekt öffnen…** wählen. Direkt aus dem ZIP öffnet die App die Diashow nicht.

> Das Archiv enthält Fotos der Schülerinnen und Schüler. Es ist eine Kopie, die das [Aufräumen](#cleanup) nicht erreicht: Bewahre es sicher auf und lösche es selbst bis zur Löschfrist; sie steht auch in der Anleitung im Archiv.

### Beschädigte Projekte reparieren

Wurde eine Projektdatei beim Speichern unterbrochen (z. B. durch einen Stromausfall), steht sie auf der Startseite rot umrandet mit **Reparieren…**. Der Dialog bietet zwei Wege:

- **Aus der Datei retten:** Alles, was noch lesbar ist, wird übernommen. Eine Liste sagt, was fehlte oder repariert wurde.
- **Automatische Sicherungen:** eine ältere, vollständige Fassung öffnen.

Die beschädigte Datei bleibt in jedem Fall erhalten. Kleinere Schäden behebt die App beim Öffnen selbst und zeigt dann, was sich geändert hat.

## Einstellungen und Systemcheck {#settings}

Die **Einstellungen** öffnest du mit dem Zahnrad oben rechts (oder im Menü **⋯**).

![Die Einstellungen](settings.jpg)

- **Erscheinungsbild:** System, Hell oder Dunkel (siehe unten).
- **Vorschauqualität:** Hoch, Mittel oder Niedrig für langsamere Laptops. Exporte sind davon nicht betroffen.
- **Grafikchip** (nur auf Laptops mit zwei Grafikchips): **Leistung** zeichnet Vorschau und Export auf der stärkeren Grafikkarte, 4K-Exporte sind dann etwa ein Drittel schneller. **Stromsparend** schont den Akku. Die Wahl gilt ab dem nächsten Start.
- **Speicher:** zeigt, wie viel Platz Vorschaubilder und Video-Fassungen belegen, und räumt auf.
- **Endlos-/Kioskmodus:** siehe [Vorführen](#present).
- **Updates:** Auf Wunsch fragt die App einmal am Tag bei GitHub nach einer neuen Version und zeigt dann einen Hinweis. Installiert wird nichts automatisch.
- **Fehlersuche:** Der **Systemcheck** prüft einen fremden PC (z. B. im Computerraum): Grafikkarte, Video-Encoder, Speicher und einen kurzen Export-Test. **Bericht kopieren** kopiert alles als Text. Dazu kommt das **Diagnosepaket** (siehe unten).

### Hell oder dunkel

Unter **Erscheinungsbild** wählst du **System**, **Hell** oder **Dunkel**. **System** folgt dem App-Modus von Windows (Einstellungen → Personalisierung → Farben). Die Vorschau, der Vollbild-Player und die große Ansicht beim Sichten bleiben immer dunkel, damit die Fotos gut wirken.

### Diagnosepaket

Klappt etwas nicht, hilft ein **Diagnosepaket** der Person, die dir hilft: **Einstellungen → Fehlersuche → Diagnosepaket erstellen…**. Vor dem Speichern siehst du jede Datei des Pakets; ein Klick zeigt ihren Inhalt. Enthalten sind Fehlerprotokoll, Systemcheck, Einstellungen, Versionen und vom geöffneten Projekt nur Anzahlen, Formate und Größen – keine Fotos, Videos, Namen oder Gesichtsdaten. **Speichern…** legt eine ZIP-Datei ab, die du per E-Mail schicken kannst.

## Tastenkürzel {#shortcuts}

| [[Leertaste]] | Vorschau abspielen / anhalten |
| [[←]] / [[→]] | Vorige / nächste Folie |
| [[Strg+Z]] / [[Strg+Y]] | Rückgängig / Wiederholen |
| [[Entf]] | Ausgewählte Folien löschen |
| [[Strg]]+Klick, [[Umschalt]]+Klick | Mehrere Folien auswählen |
| [[Strg+A]] | Alle Folien auswählen |
| [[Strg+R]] | Ausgewählte Fotos nach links drehen |
| [[Strg+F]] | Folien suchen (Name, Kapitel, Datum, Person) |
| [[F3]] / [[Umschalt+F3]] | Nächster / voriger Treffer der Suche |
| [[Strg+V]] | Kopierte Fotos, Videos oder ein Bildschirmfoto hinter der ausgewählten Folie einfügen |
| [[Strg]]+Mausrad | Filmstreifen vergrößern / verkleinern |
| [[Alt+Enter]] | Vollbild abspielen |
| [[Esc]] | Vollbild, Präsentation oder Dialog beenden |
| [[F1]] | Dieses Handbuch |
| [[Alt+←]] / [[Alt+→]] | Folie im Filmstreifen verschieben |
| [[Umschalt+F10]] | Menü der Folie öffnen |

[Alle Tastenkürzel und Maus-Tipps](app:shortcuts)

## Mit der Tastatur bedienen {#keyboard}

Alles in Diashow Studio geht auch ohne Maus:

- [[Tab]] und [[Umschalt+Tab]] springen von Bedienelement zu Bedienelement; das aktive ist blau umrandet. [[Leertaste]] oder [[Enter]] drücken einen Knopf.
- In der rechten Leiste wechseln [[↑]] und [[↓]] zwischen den Reitern **Themen**, **Musik**, **Dauer** und **Folie**.
- Der Filmstreifen ist ein einziger Halt für [[Tab]]: Dort gehen [[←]] und [[→]] von Folie zu Folie und wählen sie aus ([[Umschalt]] wählt einen Bereich), [[Alt+←]] / [[Alt+→]] verschieben die Folie, [[Umschalt+F10]] öffnet ihr Menü.
- [[Strg+F]] öffnet die Suche im Filmstreifen; [[↑]] / [[↓]] wählen einen Treffer, [[Enter]] springt hin. [[Strg+V]] fügt kopierte Fotos hinter der ausgewählten Folie ein.
- Menüs bedienst du mit den Pfeiltasten und [[Enter]]; [[Esc]] schließt sie.
- [[Esc]] schließt jeden Dialog; danach steht der Fokus wieder dort, wo du vorher warst.
- Bei Songs verschieben [[↑]] und [[↓]] auf der Nummer den Song in der Liste. Die Griffe zum Kürzen von Videos und Songs bewegen sich mit [[←]] und [[→]], mit [[Umschalt]] in größeren Schritten.
- Solange du in ein Textfeld schreibst, reagieren die Tastenkürzel nicht.

> Ist in Windows „Animationseffekte“ ausgeschaltet, verzichtet auch die App auf Bewegungen in der Oberfläche. Die Diashow selbst läuft unverändert.

## Wenn etwas nicht klappt {#trouble}

- **Windows warnt beim Installieren** („Der Computer wurde durch Windows geschützt“): **Weitere Informationen** und **Trotzdem ausführen** wählen. Die App ist nicht kostenpflichtig signiert.
- **Die Vorschau ruckelt:** in den Einstellungen die **Vorschauqualität** senken. Der Export wird dadurch nicht schlechter.
- **Ein Video bleibt „in Vorbereitung“:** Manche Handy-Videos (HEVC, HDR) werden erst umgewandelt. Das dauert, ist aber einmalig.
- **Der Export ist sehr langsam:** im [Systemcheck](#settings) nachsehen, ob ein Hardware-Encoder gefunden wird. Ohne Grafikkarte hilft eine kleinere Auflösung (720p).
- **Dateien fehlen:** Originale wurden verschoben – im gelben Hinweis **Ordner durchsuchen…** wählen.
- **Dateien auf einem Netzlaufwerk bleiben gesperrt:** Ein Projekt von einem anderen PC verweist auf Freigaben wie `\\server\fotos`. Weil sich Windows dort mit deinem Konto anmeldet, fragt die App oben im Editor erst nach. Wähle **Zugriff erlauben** nur, wenn du dem Projekt vertraust; Freigaben, aus denen du selbst importierst, gelten automatisch als vertrauenswürdig.
- **Handys erreichen den Laptop nicht:** Laptop und Handys müssen im selben WLAN sein; die Windows-Firewall muss die App zulassen. Sonst den mobilen Hotspot von Windows nutzen.
- **Etwas anderes:** Unter **Einstellungen → Fehlersuche** ein [Diagnosepaket](#settings) erstellen und mit einer Beschreibung an die Person schicken, die dir hilft.
- **Einen Fehler melden:** **Problem melden…** (unter **Einstellungen → Fehlersuche** oder in [Über Diashow Studio](app:about)) öffnet ein Formular auf GitHub, in dem App-Version, Windows-Version und Grafikkarte schon eingetragen sind; dafür brauchst du ein kostenloses GitHub-Konto. Der Bericht ist öffentlich: Häng höchstens das Diagnosepaket an, keine Fotos von Schülerinnen und Schülern.

## Über, Lizenzen und Updates {#about}

Diashow Studio ist freie Software (MIT-Lizenz). Es enthält FFmpeg (GPL), Schriften, Modelle zur Gesichtserkennung und weitere Bibliotheken; deren Lizenzen und den Quellcode von FFmpeg findest du unter [Über Diashow Studio](app:about). Dort kannst du auch **Nach Updates suchen**.
