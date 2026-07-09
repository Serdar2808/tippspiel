/**
 * fix-ko-kickoffs.js — Einmaliges Korrektur-Skript für die KO-Anstoßzeiten.
 * ===========================================================================
 * Die KO-Spiele hatten Platzhalter-Termine. Dieses Skript setzt für jedes
 * KO-Spiel (type='ko') den korrekten Anpfiff laut offiziellem FIFA-Spielplan
 * (Quelle: NBC/CBS/ESPN/Sky, ET → UTC umgerechnet; App zeigt in dt. Zeit).
 *
 * Sicher: ändert NUR die Spalte kickoff bei type='ko'. Ergebnisse, Teams,
 * finished, Tipps bleiben unberührt. Idempotent – mehrfaches Ausführen ok.
 *
 * Ausführen im Live-Ordner (neben server.js / tippspiel.sqlite):
 *     node fix-ko-kickoffs.js
 * Der Server kann dabei laufen (WAL); zur Sicherheit aber gern kurz stoppen.
 */
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, 'tippspiel.sqlite'));

// [matchId, kickoff(ms, UTC)] – offizieller FIFA-Spielplan 2026
const KICKOFFS = [
    ["m73", 1782673200000],
    ["m74", 1782765000000],
    ["m75", 1782781200000],
    ["m76", 1782752400000],
    ["m77", 1782853200000],
    ["m78", 1782838800000],
    ["m79", 1782867600000],
    ["m80", 1782921600000],
    ["m81", 1782950400000],
    ["m82", 1782936000000],
    ["m83", 1783033200000],
    ["m84", 1783018800000],
    ["m85", 1783047600000],
    ["m86", 1783116000000],
    ["m87", 1783128600000],
    ["m88", 1783101600000],
    ["m89", 1783198800000],
    ["m90", 1783184400000],
    ["m91", 1783281600000],
    ["m92", 1783296000000],
    ["m93", 1783364400000],
    ["m94", 1783382400000],
    ["m95", 1783440000000],
    ["m96", 1783454400000],
    ["m97", 1783627200000],
    ["m98", 1783710000000],
    ["m99", 1783803600000],
    ["m100", 1783818000000],
    ["m101", 1784055600000],
    ["m102", 1784142000000],
    ["m103", 1784408400000],
    ["m104", 1784487600000]
];

const fmtDE = ms => new Date(ms).toLocaleString('de-DE', {
    weekday:'short', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit',
    timeZone:'Europe/Berlin'
});

const sel = db.prepare("SELECT id, group_name, kickoff FROM matches WHERE id=? AND type='ko'");
const upd = db.prepare("UPDATE matches SET kickoff=? WHERE id=? AND type='ko'");

let changed = 0, same = 0, missing = 0;
const tx = db.transaction(() => {
    for (const [id, ms] of KICKOFFS) {
        const row = sel.get(id);
        if (!row) { console.log(`  ⚠️  ${id} nicht gefunden (übersprungen)`); missing++; continue; }
        if (row.kickoff === ms) { same++; continue; }
        upd.run(ms, id);
        console.log(`  ✓ ${id} (${row.group_name}): ${fmtDE(row.kickoff)}  →  ${fmtDE(ms)}`);
        changed++;
    }
});
tx();

console.log(`\nFertig: ${changed} geändert, ${same} bereits korrekt${missing ? `, ${missing} fehlten` : ''}.`);
db.close();
