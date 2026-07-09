/**
 * wm-live-dbcheck.js  —  zeigt, was an Live-Ständen in der DB steht. Nur lesend.
 * Start:  node wm-live-dbcheck.js
 */
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, 'tippspiel.sqlite'), { readonly: true, fileMustExist: true });

// Spalten prüfen
const cols = db.prepare("PRAGMA table_info(matches)").all().map(c => c.name);
console.log('Spalten vorhanden:  liveA=' + cols.includes('liveA') + '   liveB=' + cols.includes('liveB'));

if (!cols.includes('liveA')) {
    console.log('→ Die Spalte liveA fehlt! Dann läuft die v2 von wm-autosync.js nicht (oder Migration nicht gelaufen).');
    process.exit(0);
}

const now = Date.now();
const live = db.prepare("SELECT id, teamA, teamB, kickoff, liveA, liveB, resultA, resultB, finished FROM matches WHERE liveA IS NOT NULL").all();

console.log('\nSpiele mit gesetztem Live-Stand: ' + live.length);
for (const m of live) {
    console.log(`  ${m.teamA} ${m.liveA}:${m.liveB} ${m.teamB}   (finished=${m.finished})`);
}

// laufende Spiele (Fenster) zur Kontrolle
const running = db.prepare("SELECT teamA, teamB, kickoff, liveA, liveB, finished FROM matches WHERE finished=0 AND teamA NOT LIKE 'TBA%'").all()
    .filter(m => m.kickoff <= now && now <= m.kickoff + 150*60000);
console.log('\nSpiele im Live-Fenster gerade: ' + running.length);
for (const m of running) {
    console.log(`  ${m.teamA} vs ${m.teamB}  →  liveA/B in DB: ${m.liveA}:${m.liveB}`);
}
db.close();
