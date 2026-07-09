/**
 * wm-mapping-check.js  —  STUFE 1: NUR LESEN, schreibt NICHTS in die DB.
 * ---------------------------------------------------------------------------
 * Zweck:
 *   1) Findet automatisch den OpenLigaDB-leagueShortcut der WM 2026.
 *   2) Gleicht jedes OpenLigaDB-Spiel per Teamnamen + Datum mit deinen
 *      vorhandenen Matches in tippspiel.sqlite ab (Match-IDs bleiben unberührt).
 *   3) Zeigt für beendete Spiele ALLE Ergebnistypen (wichtig für KO: 90 Min.
 *      vs. Verlängerung), damit du vor dem ersten Schreibzugriff entscheiden
 *      kannst, welcher Ergebnistyp gezählt wird.
 *
 * Die DB wird READONLY geöffnet — ein versehentliches Schreiben ist technisch
 * unmöglich. Läuft gefahrlos parallel zum laufenden Server (WAL-Modus).
 *
 * Start:   node wm-mapping-check.js
 * Voraussetzung: Node 18+ (für globales fetch) und better-sqlite3 (hast du).
 */

const path     = require('path');
const Database = require('better-sqlite3');

// ── Konfiguration ────────────────────────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'tippspiel.sqlite');
const SEASON  = '2026';

// Leer lassen → Skript sucht den Shortcut automatisch. Falls die Auto-Suche den
// falschen Wettbewerb findet, trag den korrekten Shortcut hier fest ein:
let LEAGUE_SHORTCUT = 'wm26';

const API = 'https://api.openligadb.de';

// Manuelle Aliasse NUR falls Auto-Match etwas nicht trifft (links = dein Name,
// rechts = OpenLigaDB-Name). Beispiele auskommentiert – bei Bedarf ergänzen.
const ALIASES = {
    // 'USA': 'Vereinigte Staaten',
    // 'Südkorea': 'Korea Republik',
};

// ── Helfer ───────────────────────────────────────────────────────────────────
const norm = s => (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Diakritika entfernen
    .replace(/[^a-z0-9]/g, '')                         // nur a-z0-9
    .trim();

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            d[i][j] = Math.min(
                d[i - 1][j] + 1,
                d[i][j - 1] + 1,
                d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
    return d[m][n];
}

// 0 = exakt, 1 = unsicher (kleiner Abstand), null = kein Treffer
function teamMatchLevel(dbName, apiName) {
    const a = norm(ALIASES[dbName] || dbName);
    const b = norm(apiName);
    if (!a || !b) return null;
    if (a === b || a.includes(b) || b.includes(a)) return 0;
    const dist = levenshtein(a, b);
    if (dist <= 2) return 1;
    return null;
}

// ±1 Kalendertag Toleranz (US-Zeitzonen: Anstöße können in UTC auf den
// Vor-/Folgetag rutschen). Teamnamen-Match bleibt strikt → keine Fehlzuordnung.
const within1Day = (ms, iso) => {
    const d1 = Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate());
    const d2 = Date.UTC(new Date(iso).getUTCFullYear(), new Date(iso).getUTCMonth(), new Date(iso).getUTCDate());
    return Math.abs(d1 - d2) <= 86400000;
};

async function getJson(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status} bei ${url}`);
    return r.json();
}

// ── Hauptlogik ───────────────────────────────────────────────────────────────
(async () => {
    console.log('═'.repeat(70));
    console.log('  WM-2026 Mapping-Check  (READONLY – schreibt nichts)');
    console.log('═'.repeat(70));

    // 1) Shortcut ggf. automatisch ermitteln ----------------------------------
    if (!LEAGUE_SHORTCUT) {
        console.log('\n› Suche WM-2026-Liga in OpenLigaDB …');
        let leagues = [];
        try { leagues = await getJson(`${API}/getavailableleagues`); }
        catch (e) { console.error('  Konnte Liga-Liste nicht laden:', e.message); }

        const cand = leagues.filter(l => {
            const name = `${l.leagueName || ''}`.toLowerCase();
            const seasonOk = `${l.leagueSeason || ''}`.includes('2026');
            const isWc = /(welt|wm|world\s*cup|fifa)/.test(name);
            return seasonOk && isWc;
        });

        if (!cand.length) {
            console.log('  ⚠ Keinen WM-2026-Wettbewerb automatisch gefunden.');
            console.log('    Mögliche Fußball-Ligen mit Saison 2026:');
            leagues
                .filter(l => `${l.leagueSeason || ''}`.includes('2026'))
                .forEach(l => console.log(`      [${l.leagueShortcut}] ${l.leagueName} (${l.leagueSeason})`));
            console.log('\n    → Trag den passenden Shortcut oben bei LEAGUE_SHORTCUT ein und starte erneut.');
            process.exit(0);
        }

        if (cand.length > 1) {
            console.log('  Mehrere Kandidaten gefunden – bitte einen oben fest eintragen:');
            cand.forEach(l => console.log(`      [${l.leagueShortcut}] ${l.leagueName} (${l.leagueSeason})`));
            process.exit(0);
        }

        LEAGUE_SHORTCUT = cand[0].leagueShortcut;
        console.log(`  ✓ Gefunden: [${LEAGUE_SHORTCUT}] ${cand[0].leagueName}`);
    }

    // 2) OpenLigaDB-Spiele laden ----------------------------------------------
    console.log(`\n› Lade Spiele: ${API}/getmatchdata/${LEAGUE_SHORTCUT}/${SEASON}`);
    const apiMatches = await getJson(`${API}/getmatchdata/${LEAGUE_SHORTCUT}/${SEASON}`);
    console.log(`  ✓ ${apiMatches.length} Spiele von OpenLigaDB geladen.`);

    // 3) Eigene Matches READONLY laden ----------------------------------------
    const db = new Database(DB_FILE, { readonly: true, fileMustExist: true });
    const dbMatches = db.prepare(
        'SELECT id, type, group_name, teamA, teamB, kickoff, resultA, resultB, finished FROM matches'
    ).all();
    console.log(`  ✓ ${dbMatches.length} eigene Matches aus tippspiel.sqlite (readonly).`);

    // 4) Abgleich --------------------------------------------------------------
    const exact = [], unsure = [], unmatched = [];

    for (const dbm of dbMatches) {
        let best = null, bestLevel = 99;
        for (const am of apiMatches) {
            const a1 = am.team1?.teamName, a2 = am.team2?.teamName;
            const when = am.matchDateTimeUTC || am.matchDateTime;
            if (!within1Day(dbm.kickoff, when)) continue;

            // direkte Zuordnung A↔1 / B↔2
            const l1 = teamMatchLevel(dbm.teamA, a1);
            const l2 = teamMatchLevel(dbm.teamB, a2);
            if (l1 !== null && l2 !== null) {
                const lvl = Math.max(l1, l2);
                if (lvl < bestLevel) { bestLevel = lvl; best = { am, swapped: false }; }
            }
            // vertauschte Heim/Gast-Reihenfolge prüfen
            const l1s = teamMatchLevel(dbm.teamA, a2);
            const l2s = teamMatchLevel(dbm.teamB, a1);
            if (l1s !== null && l2s !== null) {
                const lvl = Math.max(l1s, l2s);
                if (lvl < bestLevel) { bestLevel = lvl; best = { am, swapped: true }; }
            }
        }

        if (!best) { unmatched.push(dbm); continue; }
        const entry = { dbm, am: best.am, swapped: best.swapped };
        (bestLevel === 0 ? exact : unsure).push(entry);
    }

    const fmtRes = am => (am.matchResults || [])
        .map(r => `${r.resultName}: ${r.pointsTeam1}:${r.pointsTeam2} [typID ${r.resultTypeID}]`)
        .join('  |  ') || '(noch kein Ergebnis)';

    // 5) Report ---------------------------------------------------------------
    console.log('\n' + '─'.repeat(70));
    console.log(`  ✓ EXAKT zugeordnet: ${exact.length}`);
    console.log('─'.repeat(70));
    for (const { dbm, am, swapped } of exact) {
        const flag = swapped ? '  ⤬(Reihenfolge vertauscht)' : '';
        console.log(`  ${dbm.teamA} vs ${dbm.teamB}`);
        console.log(`     ↳ extId ${am.matchID}  |  ${am.team1?.teamName} vs ${am.team2?.teamName}${flag}`);
        if (am.matchIsFinished) console.log(`     ↳ ${fmtRes(am)}`);
    }

    if (unsure.length) {
        console.log('\n' + '─'.repeat(70));
        console.log(`  ⚠ UNSICHER (bitte prüfen): ${unsure.length}`);
        console.log('─'.repeat(70));
        for (const { dbm, am, swapped } of unsure) {
            const flag = swapped ? '  ⤬(vertauscht)' : '';
            console.log(`  DB:  ${dbm.teamA} vs ${dbm.teamB}`);
            console.log(`  API: ${am.team1?.teamName} vs ${am.team2?.teamName}  (extId ${am.matchID})${flag}`);
            console.log('');
        }
    }

    if (unmatched.length) {
        console.log('\n' + '─'.repeat(70));
        console.log(`  ✗ KEIN Treffer: ${unmatched.length}`);
        console.log('─'.repeat(70));
        for (const dbm of unmatched) {
            const tba = `${dbm.teamA}`.startsWith('TBA') || `${dbm.teamB}`.startsWith('TBA');
            const note = tba ? '  (TBA – Teams noch offen, normal für KO)' : '';
            const datum = new Date(dbm.kickoff).toISOString().slice(0, 16).replace('T', ' ');
            console.log(`  ${dbm.teamA} vs ${dbm.teamB}  [${dbm.type}/${dbm.group_name}]  ${datum} UTC${note}`);
        }
    }

    // 6) KO-Ergebnistypen separat zeigen --------------------------------------
    const koFinished = apiMatches.filter(am =>
        am.matchIsFinished &&
        (am.matchResults || []).length > 1 &&
        /(finale|achtel|viertel|halb|k\.?o|knockout)/i.test(am.group?.groupName || '')
    );
    if (koFinished.length) {
        console.log('\n' + '═'.repeat(70));
        console.log('  KO-SPIELE – Ergebnistypen prüfen (90 Min. vs. Verlängerung!)');
        console.log('═'.repeat(70));
        for (const am of koFinished) {
            console.log(`  ${am.team1?.teamName} vs ${am.team2?.teamName}  (${am.group?.groupName})`);
            console.log(`     ${fmtRes(am)}`);
        }
        console.log('\n  → Anhand dieser Liste entscheiden wir, welcher resultTypeID');
        console.log('    deine 90-Minuten-Regel abbildet, bevor Stufe 2 schreibt.');
    }

    console.log('\n' + '═'.repeat(70));
    console.log(`  ZUSAMMENFASSUNG: exakt ${exact.length} · unsicher ${unsure.length} · offen ${unmatched.length}`);
    console.log('  Es wurde NICHTS verändert. Schick mir die Ausgabe für Stufe 2.');
    console.log('═'.repeat(70));

    db.close();
})().catch(e => {
    console.error('\n✗ Fehler:', e.message);
    process.exit(1);
});
