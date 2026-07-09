/**
 * wm-live-watch.js  —  misst die Live-Aktualität von wm26 WÄHREND eines Spiels.
 * Rein lesend, fasst die DB nicht an. Jede Minute ein Poll. Stop: Strg + C.
 * Start (am besten kurz nach einem Anpfiff):  node wm-live-watch.js
 */
const LEAGUE = 'wm26', SEASON = '2026';
const API = 'https://api.openligadb.de';
const EVERY_MS = 60 * 1000;

function scoreFromGoals(m) {
    const g = m.goals || [];
    if (!g.length) return '0:0 (noch keine Tore eingetragen)';
    const last = g[g.length - 1];
    return `${last.scoreTeam1}:${last.scoreTeam2}  (letztes Tor ${last.matchMinute != null ? last.matchMinute + "'" : '?'})`;
}

async function tick() {
    const stamp = new Date().toISOString().slice(11, 19);
    let matches;
    try {
        const r = await fetch(`${API}/getmatchdata/${LEAGUE}/${SEASON}`, { headers: { Accept: 'application/json' } });
        if (!r.ok) { console.log(`[${stamp}] HTTP ${r.status}`); return; }
        matches = await r.json();
    } catch (e) { console.log(`[${stamp}] Fehler: ${e.message}`); return; }

    const now = Date.now();
    const live = matches.filter(m => {
        const ko = new Date(m.matchDateTimeUTC || m.matchDateTime).getTime();
        return ko <= now && now <= ko + 150 * 60000 && !m.matchIsFinished;
    });

    if (!live.length) { console.log(`[${stamp}]  kein Spiel im Live-Fenster.`); return; }

    for (const m of live) {
        console.log(`[${stamp}]  ${m.team1?.teamName} vs ${m.team2?.teamName}`);
        console.log(`           Stand: ${scoreFromGoals(m)}`);
        console.log(`           letzte Aktualisierung lt. API: ${m.lastUpdateDateTime || '—'}`);
    }
}

console.log('Watch läuft – jede Minute ein Poll. Stop mit Strg + C.\n');
tick();
setInterval(tick, EVERY_MS);
