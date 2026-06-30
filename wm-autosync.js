/**
 * wm-autosync.js  —  STUFE 2 + 2b: Ergebnis-Auto-Eintrag UND Live-Ticker.
 * ===========================================================================
 * Wird aus server.js mit einer Zeile eingebunden. Nutzt EXAKT deine vorhandene
 * Wertungslogik (calcPoints + recalcAllUsers + Push) und macht nur EINEN
 * API-Abruf pro Zyklus, aus dem sowohl Ergebnisse als auch Live-Stand kommen.
 *
 * Sicherheits-Grundsätze:
 *   • Endergebnis (resultA/resultB/finished) wird NUR gesetzt, wenn das Spiel
 *     bei dir noch nicht finished ist → überschreibt nie manuelle Eintragungen.
 *   • Live-Stand landet in EIGENEN Feldern (liveA/liveB) – nie in der Wertung.
 *   • Heim/Gast-Reihenfolge wird pro Spiel über die TEAMNAMEN bestimmt
 *     → korrekt auch bei vertauschten Paarungen.
 *   • KO-Spiele: maßgeblich ist der Stand nach 90 Min – Nachspielzeit zählt,
 *     Verlängerung/Elfmeter (isOvertime) NICHT. Ist das Spiel in regulärer Zeit
 *     entschieden, wird direkt das Endergebnis übernommen.
 *   • Gruppenspiele: Ergebnis = Typ "Endergebnis" (resultTypeID 2).
 *   • Automatisch eingetragene Ergebnisse (autoEntered=1) dürfen vom Sync später
 *     korrigiert werden; manuell eingetragene werden NIE überschrieben.
 *   • Live-Felder werden nur bei echter Änderung geschrieben → kein unnötiges
 *     Hochzählen des /api/version-Zählers.
 *
 * @param {object} deps  { db, calcPoints, recalcAllUsers, sendPush, parseScore }
 * @param {object} opts  { leagueShortcut, season, live, pollSec, dryRun }
 */
module.exports = function initWmAutoSync(deps, opts = {}) {
    const { db, calcPoints, recalcAllUsers, sendPush, parseScore, notify } = deps;
    const LEAGUE  = opts.leagueShortcut || 'wm26';
    const SEASON  = opts.season || '2026';
    const LIVE    = opts.live === true;
    const DRY_RUN = opts.dryRun === false;
    const POLL_MS = opts.pollSec ? opts.pollSec * 1000
                  : opts.intervalMin ? opts.intervalMin * 60000
                  : (LIVE ? 60000 : 180000);
    const API = 'https://api.openligadb.de';
    const ENDERGEBNIS_TYPE_ID = 2; // 1=Halbzeit, 2=Endergebnis
    const LIVE_WINDOW_MS = 150 * 60000; // Anpfiff .. +2,5 h
    const TAG = '[WM-Sync]';

    // ── Namens-Helfer ────────────────────────────────────────────────────────
    const norm = s => (s || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '').trim();

    const namesEqual = (a, b) => {
        const x = norm(a), y = norm(b);
        return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
    };

    const within1Day = (ms, iso) => {
        const a = new Date(ms), b = new Date(iso);
        const d1 = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
        const d2 = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
        return Math.abs(d1 - d2) <= 86400000;
    };

    async function getJson(url) {
        const r = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error(`HTTP ${r.status} bei ${url}`);
        return r.json();
    }

    // ── 1) Migration: Spalten anlegen (idempotent) ───────────────────────────
    function ensureSchema() {
        const cols = db.prepare("PRAGMA table_info(matches)").all().map(c => c.name);
        const add = (name, def) => {
            if (!cols.includes(name)) {
                db.prepare(`ALTER TABLE matches ADD COLUMN ${name} ${def}`).run();
                console.log(`${TAG} Spalte "${name}" hinzugefügt.`);
            }
        };
        add('extId', 'INTEGER');
        add('autoEntered', 'INTEGER DEFAULT 0');
        if (LIVE) { add('liveA', 'INTEGER'); add('liveB', 'INTEGER'); }
    }

    // ── DB-Spiel zu einem API-Spiel finden (Name + Datum, ±1 Tag) ────────────
    function findDbMatch(apiMatch) {
        const a1 = apiMatch.team1?.teamName, a2 = apiMatch.team2?.teamName;
        const when = apiMatch.matchDateTimeUTC || apiMatch.matchDateTime;
        const rows = db.prepare(
            "SELECT id, type, teamA, teamB, kickoff, finished FROM matches WHERE teamA NOT LIKE 'TBA%' AND teamB NOT LIKE 'TBA%'"
        ).all();
        for (const m of rows) {
            const direct  = namesEqual(m.teamA, a1) && namesEqual(m.teamB, a2);
            const swapped = namesEqual(m.teamA, a2) && namesEqual(m.teamB, a1);
            if (!(direct || swapped)) continue;
            // Gruppenspiele: Datum muss grob passen (schützt vor Namens-Kollisionen).
            // KO-Spiele: Teamnamen sind eindeutig genug → Datum ignorieren, da die
            // Kickoff-Zeiten der KO-Shells Platzhalter sein können.
            if (m.type === 'ko' || within1Day(m.kickoff, when)) return m;
        }
        return null;
    }

    // ── 2) extId-Backfill ────────────────────────────────────────────────────
    function backfillExtIds(apiMatches) {
        const setExt = db.prepare('UPDATE matches SET extId = ? WHERE id = ? AND (extId IS NULL OR extId != ?)');
        let n = 0;
        for (const am of apiMatches) {
            const m = findDbMatch(am);
            if (m) { const r = setExt.run(am.matchID, m.id, am.matchID); if (r.changes) n++; }
        }
        if (n) console.log(`${TAG} extId für ${n} Spiel(e) gesetzt/aktualisiert.`);
    }

    // ── Orientierung: pA/pB für (teamA,teamB) aus team1/team2 ableiten ───────
    function orient(dbMatch, apiMatch, p1, p2) {
        if (namesEqual(dbMatch.teamA, apiMatch.team1?.teamName)) return [p1, p2];
        if (namesEqual(dbMatch.teamA, apiMatch.team2?.teamName)) return [p2, p1];
        return null;
    }

    // ── 90-Minuten-Stand aus den Tor-Events (nur für KO-Wertung) ─────────────
    // Maßgeblich ist das isOvertime-Flag, NICHT die Spielminute: Nachspielzeit
    // (z. B. 90+4) gehört zur regulären Zeit und zählt, nur echte Verlängerungs-
    // tore (isOvertime === true) werden ausgeschlossen. Gibt {s1,s2} bezogen auf
    // team1/team2 der API zurück – oder null, wenn keine verlässliche Ableitung
    // möglich ist (dann trägt der Admin manuell ein).
    function ninetyMinScore(am) {
        const goals = Array.isArray(am.goals) ? am.goals : [];
        const reg = goals.filter(x => x.isOvertime !== true);
        if (!reg.length) {
            if (goals.length === 0) {
                const end = (am.matchResults || []).find(r => r.resultTypeID === ENDERGEBNIS_TYPE_ID);
                if (end && end.pointsTeam1 === 0 && end.pointsTeam2 === 0) return { s1: 0, s2: 0 };
                return null; // beendet, aber keine Tordaten → nicht raten
            }
            return { s1: 0, s2: 0 }; // alle Tore erst in der Verlängerung → 0:0 nach 90
        }
        const last = reg[reg.length - 1];
        if (last.scoreTeam1 != null && last.scoreTeam2 != null) return { s1: last.scoreTeam1, s2: last.scoreTeam2 };
        return null;
    }

    // ── KO: maßgeblicher Stand für die Wertung (= Stand nach 90 Min) ─────────
    // 1) Keine Verlängerung gespielt → in regulärer Zeit (inkl. Nachspielzeit)
    //    entschieden → das Endergebnis IST der 90-Minuten-Stand (zuverlässig,
    //    enthält Nachspielzeit-Tore). 2) Verlängerung gespielt → nur der Stand
    //    bis Minute 90 zählt → aus den Nicht-Verlängerungs-Toren rekonstruiert.
    // Gibt {s1,s2} (team1/team2 der API) zurück oder null → Admin trägt manuell ein.
    function koRegulationScore(am) {
        const goals = Array.isArray(am.goals) ? am.goals : [];
        const hasOT = goals.some(g => g.isOvertime === true);
        const reg   = ninetyMinScore(am);
        const end   = (am.matchResults || []).find(r => r.resultTypeID === ENDERGEBNIS_TYPE_ID);
        if (!hasOT) {
            // In regulärer Zeit entschieden – Endergebnis bevorzugen (enthält Nachspielzeit).
            if (end && end.pointsTeam1 !== end.pointsTeam2) return { s1: end.pointsTeam1, s2: end.pointsTeam2 };
            if (reg && reg.s1 !== reg.s2) return reg;
            // Kein Verlängerungs-Flag, aber Remis-Bild → unklar (evtl. Elfmeter
            // ohne sauberes Flag) → lieber manuell eintragen lassen.
            return null;
        }
        // Verlängerung gespielt → 90-Minuten-Stand (Remis) aus den regulären Toren.
        return reg;
    }

    // ── 3) Endergebnis anwenden – spiegelt /api/admin/result ─────────────────
    const ptLabels = ['😭 Daneben', '👍 Tendenz +1P', '📐 Differenz +2P', '🎯 Exakt! +3P'];

    async function applyResult(matchRow, pA, pB) {
        const tx = db.transaction(() => {
            db.prepare('UPDATE matches SET resultA = ?, resultB = ?, finished = 1, autoEntered = 1, liveA = NULL, liveB = NULL WHERE id = ?').run(pA, pB, matchRow.id);
            const tips = db.prepare('SELECT userId, tipA, tipB FROM tips WHERE matchId = ?').all(matchRow.id);
            const upd  = db.prepare('UPDATE tips SET points = ? WHERE matchId = ? AND userId = ?');
            for (const t of tips) upd.run(calcPoints(t.tipA, t.tipB, pA, pB), matchRow.id, t.userId);
            recalcAllUsers.run();
        });
        tx();
        const users = db.prepare('SELECT id FROM users').all();
        for (const u of users) {
            const tip = db.prepare('SELECT tipA, tipB, points FROM tips WHERE matchId = ? AND userId = ?').get(matchRow.id, u.id);
            const body = tip && tip.tipA !== null ? `${ptLabels[tip.points]} (Tipp: ${tip.tipA}:${tip.tipB})` : '⚪ Kein Tipp abgegeben';
            const title = `⚽ ${matchRow.teamA} ${pA}:${pB} ${matchRow.teamB}`;
            await sendPush([u.id], title, body, 'result');
            if (typeof notify === 'function') notify([u.id], 'result', title, body, matchRow.id);
        }
    }

    // ── Live-Stand aktualisieren (eigene Felder, kein Scoring) ───────────────
    function syncLive(apiMatches, now) {
        // a) veraltete Live-Stände leeren (Spiel beendet oder Fenster vorbei)
        const open = db.prepare('SELECT id, kickoff, finished FROM matches WHERE liveA IS NOT NULL').all();
        const clr  = db.prepare('UPDATE matches SET liveA = NULL, liveB = NULL WHERE id = ?');
        for (const m of open) {
            const inWin = m.finished !== 1 && m.kickoff <= now && now <= m.kickoff + LIVE_WINDOW_MS;
            if (!inWin) clr.run(m.id);
        }
        // b) aktuelle Stände setzen
        const setLive = db.prepare('UPDATE matches SET liveA = ?, liveB = ? WHERE id = ?');
        for (const am of apiMatches) {
            if (am.matchIsFinished) continue;
            const ko = new Date(am.matchDateTimeUTC || am.matchDateTime).getTime();
            if (!(ko <= now && now <= ko + LIVE_WINDOW_MS)) continue;

            let m = db.prepare('SELECT id, teamA, teamB, finished FROM matches WHERE extId = ?').get(am.matchID);
            if (!m) m = findDbMatch(am);
            if (!m || m.finished === 1) continue;

            const g = am.goals || [];
            const last = g.length ? g[g.length - 1] : null;
            const s1 = last && last.scoreTeam1 != null ? last.scoreTeam1 : 0;
            const s2 = last && last.scoreTeam2 != null ? last.scoreTeam2 : 0;
            const o = orient(m, am, s1, s2);
            if (!o) continue;

            const cur = db.prepare('SELECT liveA, liveB FROM matches WHERE id = ?').get(m.id);
            if (cur.liveA !== o[0] || cur.liveB !== o[1]) {
                if (DRY_RUN) console.log(`${TAG} [DRY-RUN] live: ${m.teamA} ${o[0]}:${o[1]} ${m.teamB}`);
                else { setLive.run(o[0], o[1], m.id); console.log(`${TAG} live: ${m.teamA} ${o[0]}:${o[1]} ${m.teamB}`); }
            }
        }
    }

    // ── Ein Durchlauf ────────────────────────────────────────────────────────
    async function syncOnce() {
        let apiMatches;
        try { apiMatches = await getJson(`${API}/getmatchdata/${LEAGUE}/${SEASON}`); }
        catch (e) { console.warn(`${TAG} Abruf fehlgeschlagen: ${e.message}`); return; }

        backfillExtIds(apiMatches);
        const now = Date.now();

        // Endergebnisse
        let applied = 0;
        for (const am of apiMatches) {
            if (!am.matchIsFinished) continue;

            const COLS = 'id, type, teamA, teamB, finished, autoEntered, resultA, resultB';
            let m = db.prepare(`SELECT ${COLS} FROM matches WHERE extId = ?`).get(am.matchID);
            if (!m) { const fm = findDbMatch(am); if (fm) m = db.prepare(`SELECT ${COLS} FROM matches WHERE id = ?`).get(fm.id); }
            if (!m) continue;
            // Manuell eingetragene Ergebnisse niemals überschreiben.
            if (m.finished === 1 && m.autoEntered !== 1) continue;

            // Score je nach Spieltyp bestimmen.
            let pA, pB;
            if (m.type === 'ko') {
                // KO: maßgeblich ist der Stand nach 90 Min (Nachspielzeit zählt,
                // Verlängerung/Elfmeter NICHT).
                const reg = koRegulationScore(am);
                if (!reg) continue; // keine verlässliche Ableitung → Admin trägt manuell ein
                const o = orient(m, am, reg.s1, reg.s2);
                if (!o) { console.warn(`${TAG} Reihenfolge unklar bei KO ${m.teamA} vs ${m.teamB} (extId ${am.matchID}) – übersprungen.`); continue; }
                pA = parseScore(o[0]); pB = parseScore(o[1]);
            } else {
                const end = (am.matchResults || []).find(r => r.resultTypeID === ENDERGEBNIS_TYPE_ID);
                if (!end) continue;
                const o = orient(m, am, end.pointsTeam1, end.pointsTeam2);
                if (!o) { console.warn(`${TAG} Reihenfolge unklar bei ${m.teamA} vs ${m.teamB} (extId ${am.matchID}) – übersprungen.`); continue; }
                pA = parseScore(o[0]); pB = parseScore(o[1]);
            }
            if (pA === undefined || pB === undefined || pA === null || pB === null) continue;

            // Bereits automatisch eingetragen und unverändert → nichts zu tun.
            if (m.finished === 1 && m.resultA === pA && m.resultB === pB) continue;

            const correcting = m.finished === 1;
            const label = (m.type === 'ko' ? ' [KO/90Min]' : '') + (correcting ? ' [Korrektur]' : '');
            if (DRY_RUN) console.log(`${TAG} [DRY-RUN] würde ${correcting ? 'korrigieren' : 'eintragen'}${label}: ${m.teamA} ${pA}:${pB} ${m.teamB} (extId ${am.matchID})`);
            else { await applyResult(m, pA, pB); console.log(`${TAG} ${correcting ? 'korrigiert' : 'eingetragen'}${label}: ${m.teamA} ${pA}:${pB} ${m.teamB} (extId ${am.matchID})`); }
            applied++;
        }
        if (applied && DRY_RUN) console.log(`${TAG} DRY-RUN: ${applied} Ergebnis(se) wären eingetragen worden.`);

        // Live-Ticker
        if (LIVE) syncLive(apiMatches, now);
    }

    // ── Start ────────────────────────────────────────────────────────────────
    try { ensureSchema(); }
    catch (e) { console.error(`${TAG} Schema-Migration fehlgeschlagen: ${e.message}`); return; }

    console.log(`${TAG} aktiv – Liga ${LEAGUE}/${SEASON}, alle ${POLL_MS / 1000}s${LIVE ? ', Live an' : ''}${DRY_RUN ? '  (DRY-RUN: schreibt nichts)' : ''}`);
    setTimeout(syncOnce, 8000);
    setInterval(syncOnce, POLL_MS);
};
