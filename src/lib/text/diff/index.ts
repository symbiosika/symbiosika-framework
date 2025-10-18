import * as diff from "diff";

/**
 * Bereinigt den Text einer Versicherungspolice für den Vergleich
 */
function cleanText(text: string): string {
  // Entfernen von überflüssigen Leerzeichen
  let cleaned = text.replace(/\s+/g, " ");
  // Normalisieren von Zeilenumbrüchen
  cleaned = cleaned.replace(/\r\n|\r/g, "\n");
  // Weitere Bereinigungen je nach Bedarf...
  return cleaned;
}

/**
 * Vergleicht zwei Versionen einer Versicherungspolice und gibt die Unterschiede zurück
 */
export function compareTextVersions(
  oldVersion: string,
  newVersion: string
): {
  count?: number;
  value: string;
  added?: boolean;
  removed?: boolean;
}[] {
  // Texte bereinigen
  const cleanedOld = cleanText(oldVersion);
  const cleanedNew = cleanText(newVersion);

  // Vergleich auf Absatzebene für grobe Unterschiede
  const paragraphDiff = diff.diffSentences(cleanedOld, cleanedNew, {
    ignoreCase: true,
  });

  // Für detailliertere Unterschiede innerhalb von Absätzen
  // könnte man auch diffWords oder diffSentences verwenden

  return paragraphDiff;
}

/**
 * Formatiert die Unterschiede für die Anzeige
 */
export function formatTextDiffAsHtml(
  diff: {
    value: string;
    added?: boolean;
    removed?: boolean;
  }[]
): string {
  let result = "";

  diff.forEach((part) => {
    // Markiere Hinzufügungen und Löschungen
    if (part.added) {
      result += `<span class="added">${part.value}</span>`;
    } else if (part.removed) {
      result += `<span class="removed">${part.value}</span>`;
    } else {
      result += part.value;
    }
  });

  return result;
}
