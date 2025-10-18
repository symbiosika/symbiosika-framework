import { describe, it, expect } from "bun:test";
import { compareTextVersions, formatTextDiffAsHtml } from ".";

describe("cleanText", () => {
  // Da diese Funktion nicht exportiert wird, testen wir sie indirekt
  // über die compareTextVersions Funktion

  it("should normalize whitespace through compareTextVersions", () => {
    const oldText = "This   has    multiple spaces";
    const newText = "This has multiple spaces";

    const result = compareTextVersions(oldText, newText);
    // Wenn cleanPolicyText korrekt funktioniert, sollten keine Unterschiede gefunden werden
    expect(result.some((part) => part.added || part.removed)).toBe(false);
  });

  it("should normalize line breaks through compareTextVersions", () => {
    const oldText = "Line one\r\nLine two";
    const newText = "Line one\nLine two";

    const result = compareTextVersions(oldText, newText);
    // Wenn cleanPolicyText korrekt funktioniert, sollten keine Unterschiede gefunden werden
    expect(result.some((part) => part.added || part.removed)).toBe(false);
  });
});

describe("compareTextVersions", () => {
  it("should detect added content", () => {
    const oldVersion = "This is the original text.";
    const newVersion = "This is the original text with added content.";

    const result = compareTextVersions(oldVersion, newVersion);

    // Prüfen, ob es mindestens ein Teil gibt, das als hinzugefügt markiert ist
    expect(result.some((part) => part.added)).toBe(true);
  });

  it("should detect removed content", () => {
    const oldVersion = "This is the original text with some content.";
    const newVersion = "This is the original text.";

    const result = compareTextVersions(oldVersion, newVersion);

    // Prüfen, ob es mindestens ein Teil gibt, das als entfernt markiert ist
    expect(result.some((part) => part.removed)).toBe(true);
  });

  it("should return unchanged content correctly", () => {
    const sameText = "This text remains the same.";

    const result = compareTextVersions(sameText, sameText);

    // Prüfen, ob es keine Änderungen gibt
    expect(result.length).toBe(1);
    expect(result[0].value).toBe(sameText);
  });

  it("should detect changes in a longer insurance policy text", () => {
    const oldVersion =
      "VERSICHERUNGSPOLICE NR. VS-2023-45678\n\n" +
      "ALLGEMEINE BEDINGUNGEN: Diese Versicherungspolice (nachfolgend 'Police' genannt) stellt einen rechtsgültigen Vertrag zwischen dem Versicherungsnehmer und der Versicherungsgesellschaft dar. Die Police, der Antrag, die Deklarationen, die Zusatzvereinbarungen und Anhänge bilden den gesamten Vertrag. Bitte lesen Sie alle Dokumente sorgfältig durch.\n\n" +
      "DECKUNGSUMFANG: Diese Police bietet Versicherungsschutz für Sachschäden an der versicherten Immobilie, die durch versicherte Gefahren wie Feuer, Sturm, Hagel und Vandalismus verursacht werden. Die Deckung unterliegt den in dieser Police festgelegten Ausschlüssen, Bedingungen und Begrenzungen. Die Versicherungsgesellschaft zahlt für direkte physische Verluste oder Schäden an versichertem Eigentum, die durch eine versicherte Gefahr während der Versicherungsperiode verursacht wurden.";

    const newVersion =
      "VERSICHERUNGSPOLICE NR. VS-2023-45678\n\n" +
      "ALLGEMEINE BEDINGUNGEN: Diese Versicherungspolice (nachfolgend 'Police' genannt) stellt einen rechtsgültigen Vertrag zwischen dem Versicherungsnehmer und der Versicherungsgesellschaft dar. Die Police, der Antrag, die Deklarationen, die Zusatzvereinbarungen und Anhänge bilden den gesamten Vertrag. Bitte lesen Sie alle Dokumente sorgfältig durch.\n\n" +
      "DECKUNGSUMFANG: Diese Police bietet Versicherungsschutz für Sachschäden an der versicherten Immobilie, die durch versicherte Gefahren wie Feuer, Sturm, Hagel, Wasserschäden und Vandalismus verursacht werden. Die Deckung unterliegt den in dieser Police festgelegten Ausschlüssen, Bedingungen und Begrenzungen. Die Versicherungsgesellschaft zahlt für direkte physische Verluste oder Schäden an versichertem Eigentum, die durch eine versicherte Gefahr während der Versicherungsdauer entstanden sind.";

    const result = compareTextVersions(oldVersion, newVersion);

    // Prüfen, ob Änderungen erkannt wurden
    expect(result.some((part) => part.added || part.removed)).toBe(true);

    // Prüfen, ob der erste Absatz unverändert ist
    const unchangedParts = result.filter(
      (part) => !part.added && !part.removed
    );
    expect(
      unchangedParts.some((part) =>
        part.value.includes("ALLGEMEINE BEDINGUNGEN")
      )
    ).toBe(true);

    // Prüfen, ob die Änderungen im zweiten Absatz erkannt wurden
    expect(
      result.some((part) => part.added && part.value.includes("Wasserschäden"))
    ).toBe(true);

    expect(
      result.some(
        (part) => part.removed && part.value.includes("Versicherungsperiode")
      )
    ).toBe(true);

    expect(
      result.some(
        (part) => part.added && part.value.includes("Versicherungsdauer")
      )
    ).toBe(true);

    // check also the formatTextDiffAsHtml result for this two texts
    const formatted = formatTextDiffAsHtml(result);
    expect(formatted).toBe(
      'VERSICHERUNGSPOLICE NR. VS-2023-45678 ALLGEMEINE BEDINGUNGEN: Diese Versicherungspolice (nachfolgend \'Police\' genannt) stellt einen rechtsgültigen Vertrag zwischen dem Versicherungsnehmer und der Versicherungsgesellschaft dar. Die Police, der Antrag, die Deklarationen, die Zusatzvereinbarungen und Anhänge bilden den gesamten Vertrag. Bitte lesen Sie alle Dokumente sorgfältig durch. <span class="removed">DECKUNGSUMFANG: Diese Police bietet Versicherungsschutz für Sachschäden an der versicherten Immobilie, die durch versicherte Gefahren wie Feuer, Sturm, Hagel und Vandalismus verursacht werden.</span><span class="added">DECKUNGSUMFANG: Diese Police bietet Versicherungsschutz für Sachschäden an der versicherten Immobilie, die durch versicherte Gefahren wie Feuer, Sturm, Hagel, Wasserschäden und Vandalismus verursacht werden.</span> Die Deckung unterliegt den in dieser Police festgelegten Ausschlüssen, Bedingungen und Begrenzungen. <span class="removed">Die Versicherungsgesellschaft zahlt für direkte physische Verluste oder Schäden an versichertem Eigentum, die durch eine versicherte Gefahr während der Versicherungsperiode verursacht wurden.</span><span class="added">Die Versicherungsgesellschaft zahlt für direkte physische Verluste oder Schäden an versichertem Eigentum, die durch eine versicherte Gefahr während der Versicherungsdauer entstanden sind.</span>'
    );
  });
});

describe("formatTextDiffAsHtml", () => {
  it("should format added content with 'added' class", () => {
    const diffResult = [
      { value: "Common text. ", added: false, removed: false },
      { value: "Added text.", added: true, removed: false },
    ];

    const formatted = formatTextDiffAsHtml(diffResult);

    expect(formatted).toBe(
      'Common text. <span class="added">Added text.</span>'
    );
  });

  it("should format removed content with 'removed' class", () => {
    const diffResult = [
      { value: "Common text. ", added: false, removed: false },
      { value: "Removed text.", added: false, removed: true },
    ];

    const formatted = formatTextDiffAsHtml(diffResult);

    expect(formatted).toBe(
      'Common text. <span class="removed">Removed text.</span>'
    );
  });

  it("should handle mixed changes correctly", () => {
    const diffResult = [
      { value: "Common start. ", added: false, removed: false },
      { value: "Removed part.", added: false, removed: true },
      { value: " Middle part. ", added: false, removed: false },
      { value: "Added part.", added: true, removed: false },
      { value: " Common end.", added: false, removed: false },
    ];

    const formatted = formatTextDiffAsHtml(diffResult);

    expect(formatted).toBe(
      'Common start. <span class="removed">Removed part.</span>' +
        ' Middle part. <span class="added">Added part.</span> Common end.'
    );
  });

  it("should return empty string for empty diff", () => {
    const formatted = formatTextDiffAsHtml([]);
    expect(formatted).toBe("");
  });
});
