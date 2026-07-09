/**
 * wm-live-probe.js  —  prüft, ob OpenLigaDB/wm26 Live-taugliche Tordaten liefert.
 * Rein lesend, fasst die Datenbank NICHT an. Start:  node wm-live-probe.js
 */
const LEAGUE = 'wm26', SEASON = '2026';
const API = 'https://api.openligadb.de';

(async () => {
    const r = await fetch(`${API}/getmatchdata/${LEAGUE}/${SEASON}`, { headers: { Accept: 'application/json' } });
    if (!r.ok) { console.error('HTTP', r.status); process.exit(1); }
    const matches = await r.json();
    const now = Date.now();

    // relevant: beendet ODER gerade im Live-Fenster (Anpfiff bis +2,5 h)
    const relevant = matches.filter(m => {
        const ko = new Date(m.matchDateTimeUTC || m.matchDateTime).getTime();
        const live = ko <= now && now <= ko + 150 * 60000 && !m.matchIsFinished;
        return m.matchIsFinished || live;
    });

    console.log('═'.repeat(70));
    console.log(`  Live-Probe wm26  —  ${relevant.length} beendete/laufende Spiele`);
    console.log('═'.repeat(70));

    if (!relevant.length) {
        console.log('\n  Aktuell kein beendetes/laufendes Spiel im Datensatz.');
        console.log('  Tipp: während eines laufenden Spiels erneut starten – dann sieht man,');
        console.log('  ob Tore in Echtzeit eintrudeln.');
    }

    for (const m of relevant) {
        const ko = new Date(m.matchDateTimeUTC || m.matchDateTime);
        const live = !m.matchIsFinished;
        const goals = m.goals || [];
        console.log('\n' + '─'.repeat(70));
        console.log(`  ${m.team1?.teamName} vs ${m.team2?.teamName}   ${live ? '🔴 LÄUFT' : '✓ beendet'}`);
        console.log(`  Anpfiff: ${ko.toISOString().slice(0,16).replace('T',' ')} UTC`);
        console.log(`  letzte Aktualisierung: ${m.lastUpdateDateTime || '—'}`);
        console.log(`  Tore im goals-Array: ${goals.length}`);
        if (goals.length) {
            for (const g of goals) {
                const min = g.matchMinute != null ? `${g.matchMinute}'` : '?';
                const flags = [g.isPenalty && 'Elfer', g.isOwnGoal && 'ET', g.isOvertime && 'n.V.'].filter(Boolean).join(',');
                console.log(`     ${min.padStart(4)}  ${g.scoreTeam1}:${g.scoreTeam2}  ${g.goalGetterName || ''}${flags ? '  ('+flags+')' : ''}`);
            }
        } else {
            console.log('     (keine Einzeltore – nur das Gesamtergebnis wurde eingetragen)');
        }
        const res = (m.matchResults || []).map(x => `${x.resultName} ${x.pointsTeam1}:${x.pointsTeam2}`).join('  |  ');
        console.log(`  matchResults: ${res || '—'}`);
    }

    console.log('\n' + '═'.repeat(70));
    console.log('  Aussagekraft:');
    console.log('   • goals-Array gefüllt MIT Minuten  → Live-Stand technisch möglich.');
    console.log('   • nur matchResults, goals leer     → kein Live, nur Endstand nachträglich.');
    console.log('   • Am besten WÄHREND eines Spiels laufen lassen, um die Aktualität zu sehen.');
    console.log('═'.repeat(70));
})().catch(e => { console.error('Fehler:', e.message); process.exit(1); });
