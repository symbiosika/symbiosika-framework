/**
 * Knowledge Entries for Testing
 */
import fs from "fs";
const pathToEmbeddingFile = __dirname + "/files/test-knowledge-embedding.json";

export const TEST_KNOWLEDGE_TEXT = `
Strinz-Margarethä ist ein Ortsteil der Gemeinde Hohenstein im südhessischen Rheingau-Taunus-Kreis.
Strinz-Margarethä liegt im westlichen Hintertaunus am Mittellauf des Aubachs.
Die Gemarkungsfläche beträgt 890 Hektar, davon sind 424 Hektar bewaldet.
Der Höhenzug, auf dem die Eisenstraße verläuft, bildet die westliche und die von Hennethal nach Idstein führende,
als Hermannsweg bekannte Höhenstraße, die nördliche Gemarkungsgrenze.
In der Ortsmitte treffen sich die Landesstraßen L 3032 und L 3274.
`;

export const TEST_KNOWLEDGE_TEXT_EMBEDDING: {
  embedding: number[];
  model: string;
} = JSON.parse(fs.readFileSync(pathToEmbeddingFile, "utf8"));

export const TEST_KNOWLEDGE_TEXT_1 = `
Der Begriff Orphismus bzw. Orphischer Kubismus (abgeleitet vom mythischen Sänger und Lyra/Leier-Spieler Orpheus,
französisch orphique ‚geheimnisvoll‘) bezeichnet eine aus dem Kubismus entstandene Kunstrichtung,
bei der vor allem Kreisgebilde in bunten Farben auf der Grundlage der Farbtheorie des Chemikers
Michel Eugène Chevreul, beschrieben in dessen 1839 erschienenen Buch Gesetz der Simultankontraste bei den Farben,
geschaffen wurden. Den Begriff prägte Guillaume Apollinaire 1912 nach farbintensiven Werken von Robert Delaunay.
In den kubistischen Bildern von Pablo Picasso und Georges Braque herrschte zu dieser Zeit eine mehr monochrome Farbgebung vor.

Geschichte
Die Bezeichnung Orphismus wurde im Jahre 1912 für die Bilder Robert Delaunays von dem Schriftsteller Guillaume Apollinaire geprägt, der im selben Jahr eine Einführung zur Delaunay-Ausstellung in der Galerie Der Sturm von Herwarth Walden gab. Apollinaire sah im Orphismus eine Überwindung des Kubismus gegeben und pries die Malerei von Delaunay, František Kupka und anderen jungen Malern des späten deutschen Expressionismus als „poetische und musikalische“ Sprache.[1] Ziel des Orphismus war es, der reinen Musik eine reine Malerei entgegenzusetzen, die aufgelöst vom Gegenständlichen in eine rhythmische Farbharmonie darstellen sollte. Gestaltungsmittel sind die dynamischen Kräfte der Farbe, somit ist Farbe und ihre räumliche Wirkung wesentliches Kompositionselement. Licht ruft nicht nur Farbe hervor, sondern ist selbst Farbe.

Der Simultankontrast, die gleichzeitige Präsentation warmer und kalter, komplementärer und im Spektrum benachbarter Farben sind ein wesentliches Stilmittel des Orphismus. Sie sollen im Auge des Betrachters durch ihre optischen Effekte den Eindruck von Bewegung erzeugen.[2]

Robert Delaunay, der seinen 1912 entwickelten Stil Cubisme écartelé (zerteilter Kubismus) nannte[3], war der wichtigste Vertreter dieser Kunstbewegung. Delaunay sah und erläuterte dies in umfangreichen kunsthistorischen Schriften, in der Farbe sein eigentliches Bildmaterial, aus der die reine Malerei entstehen sollte, die „auf die Gegenstände verzichten“ und „vollkommen abstrakt sein konnte.“[4] Während Chevreul seine Theorie als eine Anleitung für Künstler verstand, so entwickelte Delaunay, der das Buch während seines Militärdienstes als Regimentsbibliothekar in Laon las, aus Chevreuls Theorie sein künstlerisches Konzept, das für ihn Ausdruck einer Weltanschauung war und von ihm als verbindlich angenommenen wurde. Die Idee der reinen Farbmalerei war für ihn die notwendige Vorstellung von einem Universum, und der damit verbundenen Vorstellung von Wirklichkeit, „die nur durch die optische Wahrnehmung angemessen erkannt werden kann und sich als simultane Bewegung der Farben im Licht zeigt.“[4]


Robert Delaunay: Fensterbild (Les Fenêtres simultanées sur la ville), 1912
Die Malerei sollte auf diese Weise als Mittel der Erkenntnis neu begründet und der Rang des Malers neu bewertet werden, denn nur der Maler sei in der Lage, diese Wirklichkeit nicht nur zu sehen, sondern auch zu vermitteln. Delaunay bemerkte zu seinen Fenster-Bildern, dass hinter jedem dieser Fenster eine neue Wirklichkeit liege, die das ABC der Ausdrucksmöglichkeiten ist, die sich der physikalischen Elemente der Farbe bediene und aus denen die neuen Formen gestaltet werden können.[4] „In dieser Malerei trifft man noch auf Andeutungen, die an die Natur erinnern, aber in einem allgemeinen Sinn, nicht in einem analytischen und beschreibenden wie in der vorhergehenden kubistischen Epoche.“[5]

Vor allem Sonia Delaunay-Terk und der US-Amerikaner Patrick Henry Bruce, ein Schüler von Henri Matisse, ließen sich in ihren Arbeiten vom Orphismus beeinflussen. Zudem sollen Arbeiten von Marc Chagall, Raymond Duchamp-Villon und von Mitgliedern des Blauen Reiters sowie der Section d’Or vom Orphismus inspiriert sein.[3]
`;

export const TEST_KNOWLEDGE_TEXT_2 = `
Der sogenannte „französische“ Stadtbrand in Prag verwüstete am 21. Juni 1689 die Judenstadt und die nördlichen Teile der Prager Alt- und Neustadt. Da die österreichischen Habsburger zu dieser Zeit gegen Frankreich unter Ludwig XIV. kämpften, wurde der Brand französischen Agenten zugeschrieben, von denen einige verurteilt und hingerichtet wurden. Obwohl die Theorie der vorsätzlichen Brandstiftung sich als Fortsetzung der damaligen französischen Taktik der verbrannten Erde interpretieren lässt, wird die Schuld der Franzosen heute in Frage gestellt. Der Brand wurde auch als der größte Terroranschlag in der Geschichte Prags bezeichnet.[1][2]

Politische Situation

General Ezéchiel du Mas, Comte de Mélac, gilt als Urheber des Planes, feindliche Städte niederzubrennen
Nach dem Ende des Holländischen Krieges (1678) setzte Frankreich unter dem „Sonnenkönig“ Ludwig XIV. seine aggressive Expansionspolitik fort und beanspruchte Gebiete in der Pfalz. Im September 1688 drangen französische Truppen mit etwa 40.000 Mann ins Rheinland ein, belagerten die Festung Philippsburg und eroberten sie nach über einem Monat. Die französische Armee setzte ihren Vormarsch fort und nahm in rascher Folge zahlreiche weitere Städte ein. Dieser Konflikt wird als Pfälzischer Erbfolgekrieg oder Neunjähriger Krieg bezeichnet.

Auf Anraten seines Kriegsministers Louvois zog sich Ludwig XIV. im Winter 1688/1689 zurück und wählte die Taktik der verbrannten Erde, bei der die geräumten Gebiete verwüstet wurden. Zwischen Dezember 1688 und Juni 1689 zerstörten die Franzosen rund 20 Städte, darunter Speyer, Mannheim und Worms, sowie zahlreiche kleinere Siedlungen im Rheinland und in der Pfalz. Diese systematischen Zerstörungen, Brandschatzungen und die Gräueltaten an der Bevölkerung wurden vor allem dem französischen General Ezéchiel de Mélac zugeschrieben und als Ausdruck schlimmster Barbarei empfunden. In Deutschland, Österreich und Böhmen wuchs die antifranzösische Stimmung und der Franzose wurde für viele zum Inbegriff des Barbaren und Brandstifters. Zeitgenössische tschechische Flugblätter warnten vor der Bedrohung durch französische Agenten oder tschechische Agenten im Dienst der Franzosen. Im heißen Frühjahr und Sommer 1689 kam es in mehreren böhmischen Städten zu Bränden, die oft französischen Agenten zugeschrieben wurden. Die Prager Ordinari Post Zeitung bezeichnete die Franzosen als „Mordbrenner“ und machte den französischen General Mélac, den sie als „Mordbrenner Mélac“ titulierte, für die Pläne verantwortlich, nicht nur deutsche, sondern auch böhmische Städte in Brand zu stecken.[3][4]
`;

export const TEST_KNOWLEDGE_TEXT_3 = `
Down by the River ist ein Rocksong von Neil Young und seiner neu formierten Band Crazy Horse. Der Titel erschien 1969 auf dem ersten gemeinsamen Studioalbum Everybody Knows This Is Nowhere.

Entstehung
Wie sich Young im 49. Kapitel seiner Autobiografie erinnert, entstand Down by the River am selben Tag wie Cinnamon Girl und Cowgirl in the Sand. Seine neue Band Crazy Horse war damals gerade erst seit zwei Wochen zusammen. Neil lag mit einer Grippe im Bett und hatte Fieberträume; im Begleittext zur Kompilation Decade hielt er fest: „wrote this with 103° fever in bed in Topanga“. In lichten Momenten probierte er verschiedene Gitarrenstimmungen aus: D-modal führte zu Cinnamon Girl, e-Moll zu Down by the River und a-Moll zu Cowgirl in the Sand: „Das war ziemlich einmalig, drei Songs in einem Rutsch, und ich bin ziemlich sicher, dass mein rauschhafter Zustand eine Menge damit zu tun hatte.“[1]

Die Grundlage für Down by the River war angeblich der Soulhit Sunny von Bobby Hebb, den Neil beim Kauf eines Grippemittels im Drugstore an der Ecke Fairfax Avenue/Sunset Boulevard aufgeschnappt hatte. Die gängige Melodie wurde in seinem Kopf zu einer Endlosschleife und entwickelte ein Eigenleben. Wieder im Bett, nahm Young die Gitarre zur Hand, änderte die Akkordfolge „und schon wurde Down by the River daraus.“[1]

Billy Talbot, Bassist bei der Rockband The Rockets, aus denen Crazy Horse hervorgegangen ist, nennt eine andere Vorlage für den Song: „Man braucht sich bloß Let Me Go auf dem Album der Rockets anzuhören, und schon hat man den Ursprung von Down by the River.“[2]
`;

/*
 await extractKnowledgeFromText({
    organisationId: TEST_ORGANISATION_1.id,
    title: "Orphismus",
    text: TEST_KNOWLEDGE_TEXT_1,
  });
*/
