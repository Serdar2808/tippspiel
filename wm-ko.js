/**
 * wm-ko.js — KO-Phasen-Engine für das WM-2026 Tippspiel.
 * ===========================================================================
 * Wird – wie wm-autosync.js – mit einer Zeile aus server.js eingebunden.
 * Stellt zwei Admin-Routen bereit:
 *   GET  /api/admin/ko/preview  → berechnet (schreibt NICHT) Gruppentabellen,
 *        Ranking der 8 besten Dritten, die komplette R32-Zuordnung (Annex C)
 *        und alle bereits feststehenden Folgepaarungen (AF/VF/HF/Finale).
 *   POST /api/admin/ko/apply    → schreibt die (ggf. vom Admin editierte)
 *        Zuordnung in die KO-Spiele. Schreibt NUR teamA/teamB, niemals
 *        Ergebnisse; rührt beendete Spiele (finished=1) nie an; idempotent.
 *
 * Grundsätze:
 *   • Gruppentabellen-Tiebreaker: Punkte → (direkter Vergleich der
 *     punktgleichen Teams: Punkte→Tordiff→Tore) → Tordiff → Tore → Name.
 *     Mehrdeutige Plätze (alle Kriterien gleich) werden als ambiguous
 *     markiert, damit der Admin sie in der Vorschau prüfen/überschreiben kann.
 *   • Dritten-Ranking gruppenübergreifend: Punkte → Tordiff → Tore → Name.
 *   • Annex-C-Lookup (alle 495 möglichen Kombinationen, offiziell, gegen die
 *     FIFA-Constraints verifiziert) bestimmt, welcher Dritte in welches Match.
 *   • KO-Remis nach 90 Min: für die Bracket-Weiterleitung wird der Aufsteiger
 *     aus ko_advancers gelesen (vom Admin in der Vorschau gewählt), da der
 *     90-Minuten-Stand allein den Sieger nicht verrät.
 *
 * @param {object} deps { app, db }
 * @param {object} opts { adminPass }
 */
module.exports = function initWmKo(deps, opts = {}) {
    const { app, db } = deps;
    const ADMIN_PASS = opts.adminPass || 'GEHEIM123';
    const TAG = '[WM-KO]';
    const GROUPS = 'ABCDEFGHIJKL'.split('');

    // ── Annex-C-Lookup ───────────────────────────────────────────────────────
    // key   = die 8 Gruppen, aus denen die weitergekommenen Dritten stammen
    //         (alphabetisch sortiert, z. B. "EFGHIJKL")
    // value = die zugeordneten Dritten in Spaltenreihenfolge COLS,
    //         z. B. "EJIFHGLK"  →  1A bekommt 3E, 1B bekommt 3J, ...
    const COLS = ['1A','1B','1D','1E','1G','1I','1K','1L'];
    const ANNEXC = {
  "ABCDEFGH":"HGBCAFDE","ABCDEFGI":"CGBDAFEI","ABCDEFGJ":"CGBDAFEJ","ABCDEFGK":"CGBDAFEK","ABCDEFGL":"CGBDAFLE","ABCDEFHI":"HEBCAFDI",
  "ABCDEFHJ":"HJBCAFDE","ABCDEFHK":"HEBCAFDK","ABCDEFHL":"HFBCADLE","ABCDEFIJ":"CJBDAFEI","ABCDEFIK":"CEBDAFIK","ABCDEFIL":"CEBDAFLI",
  "ABCDEFJK":"CJBDAFEK","ABCDEFJL":"CJBDAFLE","ABCDEFKL":"CEBDAFLK","ABCDEGHI":"HGBCADEI","ABCDEGHJ":"HGBCADEJ","ABCDEGHK":"HGBCADEK",
  "ABCDEGHL":"HGBCADLE","ABCDEGIJ":"EGBCADIJ","ABCDEGIK":"EGBCADIK","ABCDEGIL":"EGBCADLI","ABCDEGJK":"EGBCADJK","ABCDEGJL":"EGBCADLJ",
  "ABCDEGKL":"EGBCADLK","ABCDEHIJ":"HJBCADEI","ABCDEHIK":"HEBCADIK","ABCDEHIL":"HEBCADLI","ABCDEHJK":"HJBCADEK","ABCDEHJL":"HJBCADLE",
  "ABCDEHKL":"HEBCADLK","ABCDEIJK":"EJBCADIK","ABCDEIJL":"EJBCADLI","ABCDEIKL":"EIBCADLK","ABCDEJKL":"EJBCADLK","ABCDFGHI":"HGBCAFDI",
  "ABCDFGHJ":"HGBCAFDJ","ABCDFGHK":"HGBCAFDK","ABCDFGHL":"CGBDAFLH","ABCDFGIJ":"CGBDAFIJ","ABCDFGIK":"CGBDAFIK","ABCDFGIL":"CGBDAFLI",
  "ABCDFGJK":"CGBDAFJK","ABCDFGJL":"CGBDAFLJ","ABCDFGKL":"CGBDAFLK","ABCDFHIJ":"HJBCAFDI","ABCDFHIK":"HFBCADIK","ABCDFHIL":"HFBCADLI",
  "ABCDFHJK":"HJBCAFDK","ABCDFHJL":"CJBDAFLH","ABCDFHKL":"HFBCADLK","ABCDFIJK":"CJBDAFIK","ABCDFIJL":"CJBDAFLI","ABCDFIKL":"CIBDAFLK",
  "ABCDFJKL":"CJBDAFLK","ABCDGHIJ":"HGBCADIJ","ABCDGHIK":"HGBCADIK","ABCDGHIL":"HGBCADLI","ABCDGHJK":"HGBCADJK","ABCDGHJL":"HGBCADLJ",
  "ABCDGHKL":"HGBCADLK","ABCDGIJK":"CJBDAGIK","ABCDGIJL":"CJBDAGLI","ABCDGIKL":"IGBCADLK","ABCDGJKL":"CJBDAGLK","ABCDHIJK":"HJBCADIK",
  "ABCDHIJL":"HJBCADLI","ABCDHIKL":"HIBCADLK","ABCDHJKL":"HJBCADLK","ABCDIJKL":"IJBCADLK","ABCEFGHI":"HGBCAFEI","ABCEFGHJ":"HGBCAFEJ",
  "ABCEFGHK":"HGBCAFEK","ABCEFGHL":"HGBCAFLE","ABCEFGIJ":"EGBCAFIJ","ABCEFGIK":"EGBCAFIK","ABCEFGIL":"EGBCAFLI","ABCEFGJK":"EGBCAFJK",
  "ABCEFGJL":"EGBCAFLJ","ABCEFGKL":"EGBCAFLK","ABCEFHIJ":"HJBCAFEI","ABCEFHIK":"HEBCAFIK","ABCEFHIL":"HEBCAFLI","ABCEFHJK":"HJBCAFEK",
  "ABCEFHJL":"HJBCAFLE","ABCEFHKL":"HEBCAFLK","ABCEFIJK":"EJBCAFIK","ABCEFIJL":"EJBCAFLI","ABCEFIKL":"EIBCAFLK","ABCEFJKL":"EJBCAFLK",
  "ABCEGHIJ":"HJBCAGEI","ABCEGHIK":"EGBCAHIK","ABCEGHIL":"EGBCAHLI","ABCEGHJK":"HJBCAGEK","ABCEGHJL":"HJBCAGLE","ABCEGHKL":"EGBCAHLK",
  "ABCEGIJK":"EJBCAGIK","ABCEGIJL":"EJBCAGLI","ABCEGIKL":"EGBAICLK","ABCEGJKL":"EJBCAGLK","ABCEHIJK":"EJBCAHIK","ABCEHIJL":"EJBCAHLI",
  "ABCEHIKL":"EIBCAHLK","ABCEHJKL":"EJBCAHLK","ABCEIJKL":"EJBAICLK","ABCFGHIJ":"HGBCAFIJ","ABCFGHIK":"HGBCAFIK","ABCFGHIL":"HGBCAFLI",
  "ABCFGHJK":"HGBCAFJK","ABCFGHJL":"HGBCAFLJ","ABCFGHKL":"HGBCAFLK","ABCFGIJK":"CJBFAGIK","ABCFGIJL":"CJBFAGLI","ABCFGIKL":"IGBCAFLK",
  "ABCFGJKL":"CJBFAGLK","ABCFHIJK":"HJBCAFIK","ABCFHIJL":"HJBCAFLI","ABCFHIKL":"HIBCAFLK","ABCFHJKL":"HJBCAFLK","ABCFIJKL":"IJBCAFLK",
  "ABCGHIJK":"HJBCAGIK","ABCGHIJL":"HJBCAGLI","ABCGHIKL":"IGBCAHLK","ABCGHJKL":"HJBCAGLK","ABCGIJKL":"IJBCAGLK","ABCHIJKL":"IJBCAHLK",
  "ABDEFGHI":"HGBDAFEI","ABDEFGHJ":"HGBDAFEJ","ABDEFGHK":"HGBDAFEK","ABDEFGHL":"HGBDAFLE","ABDEFGIJ":"EGBDAFIJ","ABDEFGIK":"EGBDAFIK",
  "ABDEFGIL":"EGBDAFLI","ABDEFGJK":"EGBDAFJK","ABDEFGJL":"EGBDAFLJ","ABDEFGKL":"EGBDAFLK","ABDEFHIJ":"HJBDAFEI","ABDEFHIK":"HEBDAFIK",
  "ABDEFHIL":"HEBDAFLI","ABDEFHJK":"HJBDAFEK","ABDEFHJL":"HJBDAFLE","ABDEFHKL":"HEBDAFLK","ABDEFIJK":"EJBDAFIK","ABDEFIJL":"EJBDAFLI",
  "ABDEFIKL":"EIBDAFLK","ABDEFJKL":"EJBDAFLK","ABDEGHIJ":"HJBDAGEI","ABDEGHIK":"EGBDAHIK","ABDEGHIL":"EGBDAHLI","ABDEGHJK":"HJBDAGEK",
  "ABDEGHJL":"HJBDAGLE","ABDEGHKL":"EGBDAHLK","ABDEGIJK":"EJBDAGIK","ABDEGIJL":"EJBDAGLI","ABDEGIKL":"EGBAIDLK","ABDEGJKL":"EJBDAGLK",
  "ABDEHIJK":"EJBDAHIK","ABDEHIJL":"EJBDAHLI","ABDEHIKL":"EIBDAHLK","ABDEHJKL":"EJBDAHLK","ABDEIJKL":"EJBAIDLK","ABDFGHIJ":"HGBDAFIJ",
  "ABDFGHIK":"HGBDAFIK","ABDFGHIL":"HGBDAFLI","ABDFGHJK":"HGBDAFJK","ABDFGHJL":"HGBDAFLJ","ABDFGHKL":"HGBDAFLK","ABDFGIJK":"FJBDAGIK",
  "ABDFGIJL":"FJBDAGLI","ABDFGIKL":"IGBDAFLK","ABDFGJKL":"FJBDAGLK","ABDFHIJK":"HJBDAFIK","ABDFHIJL":"HJBDAFLI","ABDFHIKL":"HIBDAFLK",
  "ABDFHJKL":"HJBDAFLK","ABDFIJKL":"IJBDAFLK","ABDGHIJK":"HJBDAGIK","ABDGHIJL":"HJBDAGLI","ABDGHIKL":"IGBDAHLK","ABDGHJKL":"HJBDAGLK",
  "ABDGIJKL":"IJBDAGLK","ABDHIJKL":"IJBDAHLK","ABEFGHIJ":"HJBFAGEI","ABEFGHIK":"EGBFAHIK","ABEFGHIL":"EGBFAHLI","ABEFGHJK":"HJBFAGEK",
  "ABEFGHJL":"HJBFAGLE","ABEFGHKL":"EGBFAHLK","ABEFGIJK":"EJBFAGIK","ABEFGIJL":"EJBFAGLI","ABEFGIKL":"EGBAIFLK","ABEFGJKL":"EJBFAGLK",
  "ABEFHIJK":"EJBFAHIK","ABEFHIJL":"EJBFAHLI","ABEFHIKL":"EIBFAHLK","ABEFHJKL":"EJBFAHLK","ABEFIJKL":"EJBAIFLK","ABEGHIJK":"EJBAHGIK",
  "ABEGHIJL":"EJBAHGLI","ABEGHIKL":"EGBAIHLK","ABEGHJKL":"EJBAHGLK","ABEGIJKL":"EJBAIGLK","ABEHIJKL":"EJBAIHLK","ABFGHIJK":"HJBFAGIK",
  "ABFGHIJL":"HJBFAGLI","ABFGHIKL":"HGBAIFLK","ABFGHJKL":"HJBFAGLK","ABFGIJKL":"IJBFAGLK","ABFHIJKL":"HJBAIFLK","ABGHIJKL":"HJBAIGLK",
  "ACDEFGHI":"HGECAFDI","ACDEFGHJ":"HGJCAFDE","ACDEFGHK":"HGECAFDK","ACDEFGHL":"HGFCADLE","ACDEFGIJ":"CGJDAFEI","ACDEFGIK":"CGEDAFIK",
  "ACDEFGIL":"CGEDAFLI","ACDEFGJK":"CGJDAFEK","ACDEFGJL":"CGJDAFLE","ACDEFGKL":"CGEDAFLK","ACDEFHIJ":"HJECAFDI","ACDEFHIK":"HEFCADIK",
  "ACDEFHIL":"HEFCADLI","ACDEFHJK":"HJECAFDK","ACDEFHJL":"HJFCADLE","ACDEFHKL":"HEFCADLK","ACDEFIJK":"CJEDAFIK","ACDEFIJL":"CJEDAFLI",
  "ACDEFIKL":"CEIDAFLK","ACDEFJKL":"CJEDAFLK","ACDEGHIJ":"HGJCADEI","ACDEGHIK":"HGECADIK","ACDEGHIL":"HGECADLI","ACDEGHJK":"HGJCADEK",
  "ACDEGHJL":"HGJCADLE","ACDEGHKL":"HGECADLK","ACDEGIJK":"EGJCADIK","ACDEGIJL":"EGJCADLI","ACDEGIKL":"EGICADLK","ACDEGJKL":"EGJCADLK",
  "ACDEHIJK":"HJECADIK","ACDEHIJL":"HJECADLI","ACDEHIKL":"HEICADLK","ACDEHJKL":"HJECADLK","ACDEIJKL":"EJICADLK","ACDFGHIJ":"HGJCAFDI",
  "ACDFGHIK":"HGFCADIK","ACDFGHIL":"HGFCADLI","ACDFGHJK":"HGJCAFDK","ACDFGHJL":"CGJDAFLH","ACDFGHKL":"HGFCADLK","ACDFGIJK":"CGJDAFIK",
  "ACDFGIJL":"CGJDAFLI","ACDFGIKL":"CGIDAFLK","ACDFGJKL":"CGJDAFLK","ACDFHIJK":"HJFCADIK","ACDFHIJL":"HJFCADLI","ACDFHIKL":"HFICADLK",
  "ACDFHJKL":"HJFCADLK","ACDFIJKL":"CJIDAFLK","ACDGHIJK":"HGJCADIK","ACDGHIJL":"HGJCADLI","ACDGHIKL":"HGICADLK","ACDGHJKL":"HGJCADLK",
  "ACDGIJKL":"IGJCADLK","ACDHIJKL":"HJICADLK","ACEFGHIJ":"HGJCAFEI","ACEFGHIK":"HGECAFIK","ACEFGHIL":"HGECAFLI","ACEFGHJK":"HGJCAFEK",
  "ACEFGHJL":"HGJCAFLE","ACEFGHKL":"HGECAFLK","ACEFGIJK":"EGJCAFIK","ACEFGIJL":"EGJCAFLI","ACEFGIKL":"EGICAFLK","ACEFGJKL":"EGJCAFLK",
  "ACEFHIJK":"HJECAFIK","ACEFHIJL":"HJECAFLI","ACEFHIKL":"HEICAFLK","ACEFHJKL":"HJECAFLK","ACEFIJKL":"EJICAFLK","ACEGHIJK":"EGJCAHIK",
  "ACEGHIJL":"EGJCAHLI","ACEGHIKL":"EGICAHLK","ACEGHJKL":"EGJCAHLK","ACEGIJKL":"EJICAGLK","ACEHIJKL":"EJICAHLK","ACFGHIJK":"HGJCAFIK",
  "ACFGHIJL":"HGJCAFLI","ACFGHIKL":"HGICAFLK","ACFGHJKL":"HGJCAFLK","ACFGIJKL":"IGJCAFLK","ACFHIJKL":"HJICAFLK","ACGHIJKL":"HJICAGLK",
  "ADEFGHIJ":"HGJDAFEI","ADEFGHIK":"HGEDAFIK","ADEFGHIL":"HGEDAFLI","ADEFGHJK":"HGJDAFEK","ADEFGHJL":"HGJDAFLE","ADEFGHKL":"HGEDAFLK",
  "ADEFGIJK":"EGJDAFIK","ADEFGIJL":"EGJDAFLI","ADEFGIKL":"EGIDAFLK","ADEFGJKL":"EGJDAFLK","ADEFHIJK":"HJEDAFIK","ADEFHIJL":"HJEDAFLI",
  "ADEFHIKL":"HEIDAFLK","ADEFHJKL":"HJEDAFLK","ADEFIJKL":"EJIDAFLK","ADEGHIJK":"EGJDAHIK","ADEGHIJL":"EGJDAHLI","ADEGHIKL":"EGIDAHLK",
  "ADEGHJKL":"EGJDAHLK","ADEGIJKL":"EJIDAGLK","ADEHIJKL":"EJIDAHLK","ADFGHIJK":"HGJDAFIK","ADFGHIJL":"HGJDAFLI","ADFGHIKL":"HGIDAFLK",
  "ADFGHJKL":"HGJDAFLK","ADFGIJKL":"IGJDAFLK","ADFHIJKL":"HJIDAFLK","ADGHIJKL":"HJIDAGLK","AEFGHIJK":"EGJFAHIK","AEFGHIJL":"EGJFAHLI",
  "AEFGHIKL":"EGIFAHLK","AEFGHJKL":"EGJFAHLK","AEFGIJKL":"EJIFAGLK","AEFHIJKL":"EJIFAHLK","AEGHIJKL":"EJIAHGLK","AFGHIJKL":"HJIFAGLK",
  "BCDEFGHI":"CGBDHFEI","BCDEFGHJ":"HGBCJFDE","BCDEFGHK":"CGBDHFEK","BCDEFGHL":"CGBDHFLE","BCDEFGIJ":"CGBDJFEI","BCDEFGIK":"CGBDEFIK",
  "BCDEFGIL":"CGBDEFLI","BCDEFGJK":"CGBDJFEK","BCDEFGJL":"CGBDJFLE","BCDEFGKL":"CGBDEFLK","BCDEFHIJ":"CJBDHFEI","BCDEFHIK":"CEBDHFIK",
  "BCDEFHIL":"CEBDHFLI","BCDEFHJK":"CJBDHFEK","BCDEFHJL":"CJBDHFLE","BCDEFHKL":"CEBDHFLK","BCDEFIJK":"CJBDEFIK","BCDEFIJL":"CJBDEFLI",
  "BCDEFIKL":"CEBDIFLK","BCDEFJKL":"CJBDEFLK","BCDEGHIJ":"HGBCJDEI","BCDEGHIK":"EGBCHDIK","BCDEGHIL":"EGBCHDLI","BCDEGHJK":"HGBCJDEK",
  "BCDEGHJL":"HGBCJDLE","BCDEGHKL":"EGBCHDLK","BCDEGIJK":"EGBCJDIK","BCDEGIJL":"EGBCJDLI","BCDEGIKL":"EGBCIDLK","BCDEGJKL":"EGBCJDLK",
  "BCDEHIJK":"EJBCHDIK","BCDEHIJL":"EJBCHDLI","BCDEHIKL":"EIBCHDLK","BCDEHJKL":"EJBCHDLK","BCDEIJKL":"EJBCIDLK","BCDFGHIJ":"HGBCJFDI",
  "BCDFGHIK":"CGBDHFIK","BCDFGHIL":"CGBDHFLI","BCDFGHJK":"HGBCJFDK","BCDFGHJL":"CGBDHFLJ","BCDFGHKL":"CGBDHFLK","BCDFGIJK":"CGBDJFIK",
  "BCDFGIJL":"CGBDJFLI","BCDFGIKL":"CGBDIFLK","BCDFGJKL":"CGBDJFLK","BCDFHIJK":"CJBDHFIK","BCDFHIJL":"CJBDHFLI","BCDFHIKL":"CIBDHFLK",
  "BCDFHJKL":"CJBDHFLK","BCDFIJKL":"CJBDIFLK","BCDGHIJK":"HGBCJDIK","BCDGHIJL":"HGBCJDLI","BCDGHIKL":"HGBCIDLK","BCDGHJKL":"HGBCJDLK",
  "BCDGIJKL":"IGBCJDLK","BCDHIJKL":"HJBCIDLK","BCEFGHIJ":"HGBCJFEI","BCEFGHIK":"EGBCHFIK","BCEFGHIL":"EGBCHFLI","BCEFGHJK":"HGBCJFEK",
  "BCEFGHJL":"HGBCJFLE","BCEFGHKL":"EGBCHFLK","BCEFGIJK":"EGBCJFIK","BCEFGIJL":"EGBCJFLI","BCEFGIKL":"EGBCIFLK","BCEFGJKL":"EGBCJFLK",
  "BCEFHIJK":"EJBCHFIK","BCEFHIJL":"EJBCHFLI","BCEFHIKL":"EIBCHFLK","BCEFHJKL":"EJBCHFLK","BCEFIJKL":"EJBCIFLK","BCEGHIJK":"EJBCHGIK",
  "BCEGHIJL":"EJBCHGLI","BCEGHIKL":"EGBCIHLK","BCEGHJKL":"EJBCHGLK","BCEGIJKL":"EJBCIGLK","BCEHIJKL":"EJBCIHLK","BCFGHIJK":"HGBCJFIK",
  "BCFGHIJL":"HGBCJFLI","BCFGHIKL":"HGBCIFLK","BCFGHJKL":"HGBCJFLK","BCFGIJKL":"IGBCJFLK","BCFHIJKL":"HJBCIFLK","BCGHIJKL":"HJBCIGLK",
  "BDEFGHIJ":"HGBDJFEI","BDEFGHIK":"EGBDHFIK","BDEFGHIL":"EGBDHFLI","BDEFGHJK":"HGBDJFEK","BDEFGHJL":"HGBDJFLE","BDEFGHKL":"EGBDHFLK",
  "BDEFGIJK":"EGBDJFIK","BDEFGIJL":"EGBDJFLI","BDEFGIKL":"EGBDIFLK","BDEFGJKL":"EGBDJFLK","BDEFHIJK":"EJBDHFIK","BDEFHIJL":"EJBDHFLI",
  "BDEFHIKL":"EIBDHFLK","BDEFHJKL":"EJBDHFLK","BDEFIJKL":"EJBDIFLK","BDEGHIJK":"EJBDHGIK","BDEGHIJL":"EJBDHGLI","BDEGHIKL":"EGBDIHLK",
  "BDEGHJKL":"EJBDHGLK","BDEGIJKL":"EJBDIGLK","BDEHIJKL":"EJBDIHLK","BDFGHIJK":"HGBDJFIK","BDFGHIJL":"HGBDJFLI","BDFGHIKL":"HGBDIFLK",
  "BDFGHJKL":"HGBDJFLK","BDFGIJKL":"IGBDJFLK","BDFHIJKL":"HJBDIFLK","BDGHIJKL":"HJBDIGLK","BEFGHIJK":"EJBFHGIK","BEFGHIJL":"EJBFHGLI",
  "BEFGHIKL":"EGBFIHLK","BEFGHJKL":"EJBFHGLK","BEFGIJKL":"EJBFIGLK","BEFHIJKL":"EJBFIHLK","BEGHIJKL":"EJIBHGLK","BFGHIJKL":"HJBFIGLK",
  "CDEFGHIJ":"CGJDHFEI","CDEFGHIK":"CGEDHFIK","CDEFGHIL":"CGEDHFLI","CDEFGHJK":"CGJDHFEK","CDEFGHJL":"CGJDHFLE","CDEFGHKL":"CGEDHFLK",
  "CDEFGIJK":"CGEDJFIK","CDEFGIJL":"CGEDJFLI","CDEFGIKL":"CGEDIFLK","CDEFGJKL":"CGEDJFLK","CDEFHIJK":"CJEDHFIK","CDEFHIJL":"CJEDHFLI",
  "CDEFHIKL":"CEIDHFLK","CDEFHJKL":"CJEDHFLK","CDEFIJKL":"CJEDIFLK","CDEGHIJK":"EGJCHDIK","CDEGHIJL":"EGJCHDLI","CDEGHIKL":"EGICHDLK",
  "CDEGHJKL":"EGJCHDLK","CDEGIJKL":"EGICJDLK","CDEHIJKL":"EJICHDLK","CDFGHIJK":"CGJDHFIK","CDFGHIJL":"CGJDHFLI","CDFGHIKL":"CGIDHFLK",
  "CDFGHJKL":"CGJDHFLK","CDFGIJKL":"CGIDJFLK","CDFHIJKL":"CJIDHFLK","CDGHIJKL":"HGICJDLK","CEFGHIJK":"EGJCHFIK","CEFGHIJL":"EGJCHFLI",
  "CEFGHIKL":"EGICHFLK","CEFGHJKL":"EGJCHFLK","CEFGIJKL":"EGICJFLK","CEFHIJKL":"EJICHFLK","CEGHIJKL":"EJICHGLK","CFGHIJKL":"HGICJFLK",
  "DEFGHIJK":"EGJDHFIK","DEFGHIJL":"EGJDHFLI","DEFGHIKL":"EGIDHFLK","DEFGHJKL":"EGJDHFLK","DEFGIJKL":"EGIDJFLK","DEFHIJKL":"EJIDHFLK",
  "DEGHIJKL":"EJIDHGLK","DFGHIJKL":"HGIDJFLK","EFGHIJKL":"EJIFHGLK"
};

    // Sieger-Slot (Spalte) → R32-Match, in dem dieser Sieger gegen einen Dritten spielt
    const THIRD_MATCH = { '1A':'m79','1B':'m85','1D':'m81','1E':'m74','1G':'m82','1I':'m77','1K':'m87','1L':'m80' };

    // Feste R32-Paarungen ohne Dritte: [matchId, slotA, slotB]   slot = '1X' (Sieger) / '2X' (Zweiter)
    const STATIC_R32 = [
        ['m73','2A','2B'], ['m75','1F','2C'], ['m76','1C','2F'], ['m78','2E','2I'],
        ['m83','2K','2L'], ['m84','1H','2J'], ['m86','1J','2H'], ['m88','2D','2G'],
    ];

    // Bracket-Baum ab Achtelfinale: matchId → [[typ, quelleMatch], [typ, quelleMatch]]
    //   typ 'W' = Sieger der Quelle, 'L' = Verlierer der Quelle (nur Spiel um Platz 3)
    const PROP = {
        m89:[['W','m74'],['W','m77']],  m90:[['W','m73'],['W','m75']],
        m91:[['W','m76'],['W','m78']],  m92:[['W','m79'],['W','m80']],
        m93:[['W','m83'],['W','m84']],  m94:[['W','m81'],['W','m82']],
        m95:[['W','m86'],['W','m88']],  m96:[['W','m85'],['W','m87']],
        m97:[['W','m89'],['W','m90']],  m98:[['W','m93'],['W','m94']],
        m99:[['W','m91'],['W','m92']],  m100:[['W','m95'],['W','m96']],
        m101:[['W','m97'],['W','m98']], m102:[['W','m99'],['W','m100']],
        m103:[['L','m101'],['L','m102']], m104:[['W','m101'],['W','m102']],
    };

    // ── ko_advancers: wer kommt bei KO-Remis nach 90 Min weiter ───────────────
    db.exec(`CREATE TABLE IF NOT EXISTS ko_advancers (matchId TEXT PRIMARY KEY, advancer TEXT NOT NULL)`);

    // ── Gruppentabellen berechnen ─────────────────────────────────────────────
    function computeStandings() {
        const rows = db.prepare(
            "SELECT group_name AS g, teamA, teamB, resultA, resultB, finished FROM matches WHERE type='group'"
        ).all();
        const byGroup = {}; GROUPS.forEach(g => byGroup[g] = {});
        const ensure = (g,t) => (byGroup[g][t] || (byGroup[g][t] = { team:t,P:0,W:0,D:0,L:0,GF:0,GA:0,GD:0,Pts:0 }));
        const finishedMatches = [];
        let finishedCount = 0, totalCount = 0;
        for (const m of rows) {
            totalCount++;
            ensure(m.g, m.teamA); ensure(m.g, m.teamB);
            if (m.finished !== 1 || m.resultA == null || m.resultB == null) continue;
            finishedCount++; finishedMatches.push(m);
            const a = byGroup[m.g][m.teamA], b = byGroup[m.g][m.teamB];
            a.P++; b.P++;
            a.GF += m.resultA; a.GA += m.resultB; b.GF += m.resultB; b.GA += m.resultA;
            if (m.resultA > m.resultB) { a.W++; b.L++; a.Pts += 3; }
            else if (m.resultA < m.resultB) { b.W++; a.L++; b.Pts += 3; }
            else { a.D++; b.D++; a.Pts++; b.Pts++; }
        }
        GROUPS.forEach(g => Object.values(byGroup[g]).forEach(x => x.GD = x.GF - x.GA));

        // direkter Vergleich (Mini-Tabelle) unter einer Menge punktgleicher Teams einer Gruppe
        function h2h(teamNames, g) {
            const set = new Set(teamNames), mini = {};
            teamNames.forEach(t => mini[t] = { Pts:0, GD:0, GF:0 });
            for (const m of finishedMatches) {
                if (m.g !== g || !set.has(m.teamA) || !set.has(m.teamB)) continue;
                const a = mini[m.teamA], b = mini[m.teamB];
                a.GF += m.resultA; a.GD += m.resultA - m.resultB;
                b.GF += m.resultB; b.GD += m.resultB - m.resultA;
                if (m.resultA > m.resultB) a.Pts += 3;
                else if (m.resultA < m.resultB) b.Pts += 3;
                else { a.Pts++; b.Pts++; }
            }
            return mini;
        }

        const tables = {}, ambiguousGroups = [];
        for (const g of GROUPS) {
            let teams = Object.values(byGroup[g]).sort((a,b) => b.Pts - a.Pts);
            const out = [];
            let i = 0;
            while (i < teams.length) {
                let j = i; while (j < teams.length && teams[j].Pts === teams[i].Pts) j++;
                const bucket = teams.slice(i, j);
                if (bucket.length > 1) {
                    const mini = h2h(bucket.map(t => t.team), g);
                    bucket.sort((a,b) => {
                        const ma = mini[a.team], mb = mini[b.team];
                        if (mb.Pts !== ma.Pts) return mb.Pts - ma.Pts;
                        if (mb.GD  !== ma.GD ) return mb.GD  - ma.GD;
                        if (mb.GF  !== ma.GF ) return mb.GF  - ma.GF;
                        if (b.GD   !== a.GD  ) return b.GD   - a.GD;
                        if (b.GF   !== a.GF  ) return b.GF   - a.GF;
                        return a.team.localeCompare(b.team);
                    });
                    for (let k = 0; k < bucket.length - 1; k++) {
                        const a = bucket[k], b = bucket[k+1], ma = mini[a.team], mb = mini[b.team];
                        if (ma.Pts===mb.Pts && ma.GD===mb.GD && ma.GF===mb.GF && a.GD===b.GD && a.GF===b.GF) { a._amb = true; b._amb = true; }
                    }
                }
                out.push(...bucket); i = j;
            }
            out.forEach((t,idx) => t.rank = idx + 1);
            if (out.some(t => t._amb)) ambiguousGroups.push(g);
            tables[g] = out;
        }
        return { tables, finishedCount, totalCount, complete: totalCount > 0 && finishedCount === totalCount, ambiguousGroups };
    }

    // ── 8 beste Dritte gruppenübergreifend ranken ─────────────────────────────
    function rankThirds(tables) {
        const thirds = GROUPS.map(g => { const t = tables[g][2]; return t ? Object.assign({}, t, { group:g }) : null; }).filter(Boolean);
        thirds.sort((a,b) => (b.Pts-a.Pts) || (b.GD-a.GD) || (b.GF-a.GF) || a.group.localeCompare(b.group));
        thirds.forEach((t,i) => t.thirdRank = i + 1);
        let boundaryAmbiguous = false;
        if (thirds.length >= 9) {
            const a = thirds[7], b = thirds[8];
            if (a.Pts===b.Pts && a.GD===b.GD && a.GF===b.GF) boundaryAmbiguous = true;
        }
        const best8 = thirds.slice(0, 8);
        return { thirds, best8, best8Groups: best8.map(t => t.group).sort().join(''), boundaryAmbiguous };
    }

    const slotTeam = (tables, slot) => { const r = tables[slot[1]] && tables[slot[1]][slot[0]==='1'?0:1]; return r ? r.team : null; };

    // ── R32-Vorschlag bauen ───────────────────────────────────────────────────
    function buildR32(tables, thirdsInfo) {
        const out = [];
        for (const [mid, sA, sB] of STATIC_R32)
            out.push({ matchId:mid, teamA:slotTeam(tables,sA), teamB:slotTeam(tables,sB), slotA:sA, slotB:sB, kind:'static' });
        const mapping = (thirdsInfo.best8.length === 8) ? ANNEXC[thirdsInfo.best8Groups] : null;
        COLS.forEach((col, idx) => {
            const tg = mapping ? mapping[idx] : null;
            out.push({
                matchId: THIRD_MATCH[col],
                teamA: slotTeam(tables, col),
                teamB: tg ? (tables[tg][2] && tables[tg][2].team) : null,
                slotA: col, slotB: tg ? '3'+tg : '3?', kind:'third'
            });
        });
        return out.sort((a,b) => parseInt(a.matchId.slice(1)) - parseInt(b.matchId.slice(1)));
    }

    // ── Sieger/Verlierer eines beendeten KO-Spiels (90-Min-Stand + advancers) ──
    function decideKo(row, advancers) {
        if (!row || row.finished !== 1 || row.resultA == null || row.resultB == null) return null;
        if ((row.teamA||'').startsWith('TBA') || (row.teamB||'').startsWith('TBA')) return null;
        if (row.resultA > row.resultB) return { W:row.teamA, L:row.teamB };
        if (row.resultA < row.resultB) return { W:row.teamB, L:row.teamA };
        const adv = advancers[row.id];
        if (!adv) return { draw:true, teamA:row.teamA, teamB:row.teamB };
        return { W:adv, L:(adv===row.teamA?row.teamB:row.teamA), draw:true, resolved:true };
    }

    // ── Folgepaarungen (AF/VF/HF/Finale/Platz 3) ──────────────────────────────
    function buildPropagation() {
        const koRows = {};
        db.prepare("SELECT id, teamA, teamB, resultA, resultB, finished FROM matches WHERE type='ko'").all().forEach(r => koRows[r.id] = r);
        const advancers = {};
        db.prepare("SELECT matchId, advancer FROM ko_advancers").all().forEach(r => advancers[r.matchId] = r.advancer);
        const out = [], pend = [], seen = new Set();
        for (const mid of Object.keys(PROP)) {
            const resolve = ([typ, src]) => {
                const d = decideKo(koRows[src], advancers);
                if (!d) return null;
                if (d.draw && !d.resolved) { if (!seen.has(src)) { seen.add(src); pend.push({ matchId:src, teamA:d.teamA, teamB:d.teamB }); } return null; }
                return typ === 'W' ? d.W : d.L;
            };
            const [specA, specB] = PROP[mid];
            out.push({ matchId:mid, teamA:resolve(specA), teamB:resolve(specB), srcA:specA, srcB:specB });
        }
        return { propagation: out, pendingAdvancers: pend };
    }

    // ── Clinch-Erkennung: wessen EXAKTE Position (1./2.) steht sicher fest? ────
    // Konservativ über Punkte (alle W/U/N-Kombinationen der Restspiele). Gleichstände
    // werden pessimistisch behandelt → es wird NIE ein Clinch behauptet, der nur über
    // die Tordifferenz feststeht. Solche Fälle setzt der Admin ggf. manuell.
    function computeClinch() {
        const rows = db.prepare("SELECT group_name AS g, teamA, teamB, resultA, resultB, finished FROM matches WHERE type='group'").all();
        const G = {}; GROUPS.forEach(g => G[g] = { teams:new Set(), finished:[], pending:[] });
        for (const m of rows) {
            const x = G[m.g]; x.teams.add(m.teamA); x.teams.add(m.teamB);
            if (m.finished === 1 && m.resultA != null && m.resultB != null) x.finished.push(m);
            else x.pending.push(m);
        }
        const out = {};
        for (const g of GROUPS) {
            const x = G[g], names = [...x.teams], k = x.pending.length;
            // Hat ein Team überhaupt noch ein offenes Spiel? (→ Gesamt-Tordifferenz unsicher)
            const hasPending = {}; names.forEach(t => hasPending[t] = false);
            x.pending.forEach(m => { hasPending[m.teamA] = true; hasPending[m.teamB] = true; });
            const possible = {}; names.forEach(t => possible[t] = new Set());

            for (let c = 0; c < Math.pow(3, k); c++) {
                // Restspiel-Ausgänge dieser Kombination (0=A-Sieg, 1=B-Sieg, 2=Remis) — Vorzeichen fix, Marge offen
                const oc = new Map(); let n = c;
                for (const m of x.pending) { const o = n % 3; n = (n - o) / 3; oc.set(m, o); }

                // Punkte (exakt) + Gesamt-Tordiff/-Tore (nur aus beendeten Spielen sicher)
                const pts = {}, gd = {}, gf = {}; names.forEach(t => { pts[t]=0; gd[t]=0; gf[t]=0; });
                for (const m of x.finished) {
                    gf[m.teamA]+=m.resultA; gf[m.teamB]+=m.resultB; gd[m.teamA]+=m.resultA-m.resultB; gd[m.teamB]+=m.resultB-m.resultA;
                    if (m.resultA>m.resultB) pts[m.teamA]+=3; else if (m.resultA<m.resultB) pts[m.teamB]+=3; else { pts[m.teamA]++; pts[m.teamB]++; }
                }
                for (const m of x.pending) { const o=oc.get(m); if (o===0) pts[m.teamA]+=3; else if (o===1) pts[m.teamB]+=3; else { pts[m.teamA]++; pts[m.teamB]++; } }

                // direkter Vergleich (Mini-Tabelle) unter einer punktgleichen Teilmenge S
                const h2h = (S) => {
                    const set=new Set(S), hp={}, hgd={}, hgf={}, hPend={};
                    S.forEach(t => { hp[t]=0; hgd[t]=0; hgf[t]=0; hPend[t]=false; });
                    for (const m of x.finished) { if(!set.has(m.teamA)||!set.has(m.teamB))continue;
                        hgf[m.teamA]+=m.resultA; hgf[m.teamB]+=m.resultB; hgd[m.teamA]+=m.resultA-m.resultB; hgd[m.teamB]+=m.resultB-m.resultA;
                        if (m.resultA>m.resultB) hp[m.teamA]+=3; else if (m.resultA<m.resultB) hp[m.teamB]+=3; else { hp[m.teamA]++; hp[m.teamB]++; } }
                    for (const m of x.pending) { if(!set.has(m.teamA)||!set.has(m.teamB))continue; const o=oc.get(m);
                        if (o===0) hp[m.teamA]+=3; else if (o===1) hp[m.teamB]+=3; else { hp[m.teamA]++; hp[m.teamB]++; }
                        hPend[m.teamA]=true; hPend[m.teamB]=true; }
                    return { hp, hgd, hgf, hPend };
                };

                // Vergleich U vs T: 1 = U sicher besser, -1 = T sicher besser, 0 = (noch) unsicher
                const cmp = (U, T) => {
                    if (pts[U] !== pts[T]) return pts[U] > pts[T] ? 1 : -1;
                    const S = names.filter(t => pts[t] === pts[U]);
                    const { hp, hgd, hgf, hPend } = h2h(S);
                    if (hp[U] !== hp[T]) return hp[U] > hp[T] ? 1 : -1;        // direkter Vergleich: Punkte (margen-unabhängig)
                    if (S.some(t => hPend[t])) return 0;                       // H2H-Tordiff hängt an offener Marge → unsicher
                    if (hgd[U] !== hgd[T]) return hgd[U] > hgd[T] ? 1 : -1;    // H2H-Tordiff
                    if (hgf[U] !== hgf[T]) return hgf[U] > hgf[T] ? 1 : -1;    // H2H-Tore
                    if (hasPending[U] || hasPending[T]) return 0;              // Gesamt-Tordiff-Marge offen → unsicher
                    if (gd[U] !== gd[T]) return gd[U] > gd[T] ? 1 : -1;        // Gesamt-Tordiff
                    if (gf[U] !== gf[T]) return gf[U] > gf[T] ? 1 : -1;        // Gesamt-Tore
                    return 0;                                                  // echter Gleichstand (Losentscheid) → unsicher
                };

                for (const T of names) {
                    let cert=0, maybe=0;
                    for (const U of names) { if (U===T) continue; const r=cmp(U,T); if (r>0) cert++; else if (r===0) maybe++; }
                    for (let r = cert+1; r <= cert+maybe+1; r++) possible[T].add(r);
                }
            }

            const perTeam = {};
            names.forEach(t => { const r = [...possible[t]].sort((a,b)=>a-b);
                perTeam[t] = { ranks:r, c1:(r.length===1&&r[0]===1), c2:(r.length===1&&r[0]===2), top2:r.every(x=>x<=2) }; });
            out[g] = {
                winner:   names.find(t => perTeam[t].c1) || null,
                runnerUp: names.find(t => perTeam[t].c2) || null,
                top2:     names.filter(t => perTeam[t].top2),
                perTeam, pending:k,
            };
        }
        return out;
    }

    // Welche Match-Seiten lassen sich daraus sicher vorzeitig setzen?
    function buildEarlySides(clinch) {
        const sides = [];
        for (const col of COLS) { const w = clinch[col[1]].winner; if (w) sides.push({ matchId:THIRD_MATCH[col], side:'A', team:w, slot:col }); }
        for (const [mid, sA, sB] of STATIC_R32)
            for (const [side, slot] of [['A',sA],['B',sB]]) {
                const team = slot[0] === '1' ? clinch[slot[1]].winner : clinch[slot[1]].runnerUp;
                if (team) sides.push({ matchId:mid, side, team, slot });
            }
        return sides;
    }

    // ── PREVIEW ───────────────────────────────────────────────────────────────
    function preview() {
        const st = computeStandings();
        const ti = rankThirds(st.tables);
        const prop = buildPropagation();
        const clinch = computeClinch();
        const earlySides = buildEarlySides(clinch);
        // markieren, was bereits in den KO-Spielen steht (damit die UI "offen" vs "gesetzt" zeigt)
        const koMap = {}; db.prepare("SELECT id, teamA, teamB FROM matches WHERE type='ko'").all().forEach(r => koMap[r.id] = r);
        earlySides.forEach(s => { const row = koMap[s.matchId]; s.set = !!(row && (s.side === 'A' ? row.teamA : row.teamB) === s.team); });
        const earlyPending = earlySides.filter(s => !s.set).length;
        const bySide = {}; earlySides.forEach(s => { (bySide[s.matchId] = bySide[s.matchId] || {})[s.side] = true; });
        const earlyFullMatches = Object.keys(bySide).filter(mid => bySide[mid].A && bySide[mid].B).length;
        return {
            complete: st.complete, finishedGroupGames: st.finishedCount, totalGroupGames: st.totalCount,
            ambiguousGroups: st.ambiguousGroups,
            standings: st.tables, thirds: ti.thirds, best8Groups: ti.best8Groups,
            boundaryAmbiguous: ti.boundaryAmbiguous, annexMatched: !!ANNEXC[ti.best8Groups],
            r32: buildR32(st.tables, ti),
            propagation: prop.propagation, pendingAdvancers: prop.pendingAdvancers,
            clinch, earlySides, earlyCount: earlySides.length, earlyPending, earlyFullMatches,
        };
    }

    // ── APPLY ─────────────────────────────────────────────────────────────────
    function apply(body) {
        const st = computeStandings();
        const early = body.mode === 'early';
        if (!early && !st.complete && !body.force)
            return { ok:false, error:'Gruppenphase noch nicht abgeschlossen.', finishedGroupGames:st.finishedCount, totalGroupGames:st.totalCount };

        const getKo    = db.prepare("SELECT id, teamA, teamB, finished FROM matches WHERE id=? AND type='ko'");
        const setTeams = db.prepare("UPDATE matches SET teamA=?, teamB=? WHERE id=? AND type='ko' AND finished=0");
        const setA     = db.prepare("UPDATE matches SET teamA=? WHERE id=? AND type='ko' AND finished=0");
        const setB     = db.prepare("UPDATE matches SET teamB=? WHERE id=? AND type='ko' AND finished=0");
        const upAdv    = db.prepare("INSERT INTO ko_advancers (matchId,advancer) VALUES (?,?) ON CONFLICT(matchId) DO UPDATE SET advancer=excluded.advancer");
        const changes = [];

        db.transaction(() => {
            if (body.advancers && typeof body.advancers === 'object')
                for (const [mid, adv] of Object.entries(body.advancers)) if (adv) upAdv.run(mid, adv);

            if (early) {
                // Nur sicher feststehende Seiten setzen (Gruppensieger/-zweite mit geclinchter Position).
                for (const sde of buildEarlySides(computeClinch())) {
                    const row = getKo.get(sde.matchId);
                    if (!row || row.finished === 1) continue;
                    if (sde.side === 'A') { if (row.teamA !== sde.team) { setA.run(sde.team, sde.matchId); changes.push(`${sde.matchId}.A = ${sde.team} (vorzeitig, ${sde.slot})`); } }
                    else                  { if (row.teamB !== sde.team) { setB.run(sde.team, sde.matchId); changes.push(`${sde.matchId}.B = ${sde.team} (vorzeitig, ${sde.slot})`); } }
                }
            } else {
                let r32 = Array.isArray(body.r32) && body.r32.length ? body.r32 : buildR32(st.tables, rankThirds(st.tables));
                for (const m of r32) {
                    const row = getKo.get(m.matchId);
                    if (!row || row.finished === 1 || !m.teamA || !m.teamB) continue;
                    if (row.teamA !== m.teamA || row.teamB !== m.teamB) { setTeams.run(m.teamA, m.teamB, m.matchId); changes.push(`${m.matchId}: ${m.teamA} vs ${m.teamB}`); }
                }
                for (const p of buildPropagation().propagation) {
                    const row = getKo.get(p.matchId);
                    if (!row || row.finished === 1) continue;
                    if (p.teamA && row.teamA !== p.teamA) { setA.run(p.teamA, p.matchId); changes.push(`${p.matchId}.A = ${p.teamA}`); }
                    if (p.teamB && row.teamB !== p.teamB) { setB.run(p.teamB, p.matchId); changes.push(`${p.matchId}.B = ${p.teamB}`); }
                }
            }
        })();
        return { ok:true, count: changes.length, changes };
    }

    // ── Routen ────────────────────────────────────────────────────────────────
    const guard = (req, res) => {
        const pass = (req.query && req.query.adminPass) || (req.body && req.body.adminPass);
        if (pass !== ADMIN_PASS) { res.status(403).json({ error:'Falsches Admin-Passwort' }); return false; }
        return true;
    };
    app.get('/api/admin/ko/preview', (req,res) => { if (!guard(req,res)) return; try { res.json(preview()); } catch(e){ console.error(TAG, e); res.status(500).json({ error:e.message }); } });
    app.post('/api/admin/ko/apply',  (req,res) => { if (!guard(req,res)) return; try { res.json(apply(req.body || {})); } catch(e){ console.error(TAG, e); res.status(500).json({ error:e.message }); } });

    console.log(`${TAG} aktiv – Routen /api/admin/ko/preview & /api/admin/ko/apply`);
    return { preview, apply, computeStandings, buildPropagation, computeClinch, buildEarlySides };
};
