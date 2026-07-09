/**
 * wm-candidates.js  —  STUFE 1b: NUR LESEN, schreibt NICHTS.
 * ---------------------------------------------------------------------------
 * Vergleicht die konkurrierenden WM-2026-Ligen in OpenLigaDB und bewertet sie
 * danach, wie gut sie zu DEINEN vorhandenen Matches passen. So findest du
 * objektiv die richtige Liga, bevor irgendwas geschrieben wird.
 *
 * Start:  node wm-candidates.js
 */

const path     = require('path');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, 'tippspiel.sqlite');
const SEASON  = '2026';
const API     = 'https://api.openligadb.de';

// Fußball-Kandidaten (Darts wurde aussortiert):
const CANDIDATES = ['wm26', 'wm_mueller', 'wm2026', 'wm2026_xlife'];

// ── Helfer (identisch zum Mapping-Skript) ────────────────────────────────────
const norm = s => (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '').trim();

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            d[i][j] = Math.min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
    return d[m][n];
}
function teamMatchLevel(dbName, apiName) {
    const a = norm(dbName), b = norm(apiName);
    if (!a || !b) return null;
    if (a === b || a.includes(b) || b.includes(a)) return 0;
    return levenshtein(a, b) <= 2 ? 1 : null;
}
const sameDay = (ms, iso) => {
    const x = new Date(ms), y = new Date(iso);
    return x.getUTCFullYear()===y.getUTCFullYear() && x.getUTCMonth()===y.getUTCMonth() && x.getUTCDate()===y.getUTCDate();
};
async function getJson(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

function countMatches(dbMatches, apiMatches) {
    let exact = 0, unsure = 0;
    for (const dbm of dbMatches) {
        // TBA-Spiele (Teams noch offen) beim Scoring ignorieren
        if (`${dbm.teamA}`.startsWith('TBA') || `${dbm.teamB}`.startsWith('TBA')) continue;
        let bestLevel = 99;
        for (const am of apiMatches) {
            const when = am.matchDateTimeUTC || am.matchDateTime;
            if (!sameDay(dbm.kickoff, when)) continue;
            const a1 = am.team1?.teamName, a2 = am.team2?.teamName;
            for (const [x, y] of [[a1, a2], [a2, a1]]) {
                const l1 = teamMatchLevel(dbm.teamA, x), l2 = teamMatchLevel(dbm.teamB, y);
                if (l1 !== null && l2 !== null) bestLevel = Math.min(bestLevel, Math.max(l1, l2));
            }
        }
        if (bestLevel === 0) exact++;
        else if (bestLevel === 1) unsure++;
    }
    return { exact, unsure };
}

// ── Hauptlogik ───────────────────────────────────────────────────────────────
(async () => {
    console.log('═'.repeat(74));
    console.log('  WM-2026 Kandidaten-Vergleich  (READONLY)');
    console.log('═'.repeat(74));

    const db = new Database(DB_FILE, { readonly: true, fileMustExist: true });
    const dbMatches = db.prepare('SELECT teamA, teamB, kickoff FROM matches').all();
    const tippbar = dbMatches.filter(m => !`${m.teamA}`.startsWith('TBA') && !`${m.teamB}`.startsWith('TBA')).length;
    console.log(`\nDeine DB: ${dbMatches.length} Matches gesamt, davon ${tippbar} mit bekannten Teams.\n`);

    const results = [];
    for (const sc of CANDIDATES) {
        try {
            const m = await getJson(`${API}/getmatchdata/${sc}/${SEASON}`);
            const finished = m.filter(x => x.matchIsFinished).length;
            const withRes  = m.filter(x => (x.matchResults || []).some(r => r.pointsTeam1 != null)).length;
            const dates = m.map(x => new Date(x.matchDateTimeUTC || x.matchDateTime)).filter(d => !isNaN(d));
            const range = dates.length
                ? `${new Date(Math.min(...dates)).toISOString().slice(0,10)} … ${new Date(Math.max(...dates)).toISOString().slice(0,10)}`
                : '—';
            const { exact, unsure } = countMatches(dbMatches, m);
            results.push({ sc, total: m.length, finished, withRes, range, exact, unsure });
        } catch (e) {
            results.push({ sc, error: e.message });
        }
    }
    db.close();

    results.sort((a, b) => (b.exact || 0) - (a.exact || 0));

    for (const r of results) {
        console.log('─'.repeat(74));
        if (r.error) { console.log(`  [${r.sc}]  ✗ Fehler: ${r.error}`); continue; }
        console.log(`  [${r.sc}]`);
        console.log(`     Spiele gesamt : ${r.total}      beendet: ${r.finished}      mit Ergebnis: ${r.withRes}`);
        console.log(`     Zeitraum      : ${r.range}`);
        console.log(`     → EXAKT-Treffer mit deinen Matches: ${r.exact}   (unsicher: ${r.unsure})`);
    }

    console.log('\n' + '═'.repeat(74));
    const winner = results.find(r => !r.error);
    if (winner) {
        console.log(`  EMPFEHLUNG: [${winner.sc}]  — meiste Exakt-Treffer (${winner.exact}).`);
        console.log('  Erwartung für eine vollständige WM 2026: 104 Spiele, 72 Vorrunde.');
    }
    console.log('  Es wurde NICHTS verändert. Schick mir diese Ausgabe.');
    console.log('═'.repeat(74));
})().catch(e => { console.error('\n✗ Fehler:', e.message); process.exit(1); });
