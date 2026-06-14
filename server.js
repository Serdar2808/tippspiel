const express  = require('express');
const fsSync   = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const Database = require('better-sqlite3');
const app      = express();
const PORT     = 3000;
const DB_FILE     = path.join(__dirname, 'tippspiel.sqlite');
const VAPID_FILE  = path.join(__dirname, 'vapid_keys.json');

// ── Web Push Setup (optional – nur wenn web-push installiert) ─────────────────
let webpush = null;
let vapidKeys = null;
try {
    webpush = require('web-push');
    if (fsSync.existsSync(VAPID_FILE)) {
        vapidKeys = JSON.parse(fsSync.readFileSync(VAPID_FILE, 'utf8'));
    } else {
        vapidKeys = webpush.generateVAPIDKeys();
        fsSync.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2));
        console.log('✓ VAPID Schlüssel generiert und gespeichert');
    }
    webpush.setVapidDetails('https://leppe-lager.duckdns.org', vapidKeys.publicKey, vapidKeys.privateKey);
    console.log('✓ Push Notifications aktiv');
} catch (e) {
    console.log('ℹ Push deaktiviert – "npm install web-push" um zu aktivieren');
}

app.use(express.json());
app.use(express.static(__dirname));

// ── Datenbank Initialisierung ─────────────────────────────────────────────────
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL'); // Aktiviert High-Performance Schreibmodus

// Tipp-Reaktionen: User reagieren auf die Tipps anderer User (erst nach Anpfiff sichtbar)
db.exec(`CREATE TABLE IF NOT EXISTS tip_reactions (
    matchId      TEXT NOT NULL,
    targetUserId TEXT NOT NULL,
    userId       TEXT NOT NULL,
    emoji        TEXT NOT NULL,
    PRIMARY KEY (matchId, targetUserId, userId)
)`);

// Mitteilungszentrale: spiegelt push-würdige Ereignisse pro Empfänger
db.exec(`CREATE TABLE IF NOT EXISTS notifications (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    userId    TEXT NOT NULL,
    type      TEXT NOT NULL,
    title     TEXT,
    body      TEXT,
    matchId   TEXT,
    createdAt INTEGER NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (userId, createdAt)');

// ── Punkte-Berechnung ─────────────────────────────────────────────────────────
function calcPoints(tipA, tipB, resultA, resultB) {
    if (tipA === null || tipB === null) return 0;
    if (tipA === resultA && tipB === resultB) return 3;                           // exakt
    if (resultA !== resultB && (tipA - tipB) === (resultA - resultB)) return 2;   // Differenz – nur bei KEIN Remis
    if (Math.sign(tipA - tipB) === Math.sign(resultA - resultB)) return 1;        // Tendenz
    return 0;
}

function parseScore(val) {
    if (val === "" || val === null || val === undefined) return null;
    const n = parseInt(val, 10);
    if (!Number.isInteger(n) || n < 0 || n > 30) return undefined;
    return n;
}

function generateUniqueToken() {
    const checkToken = db.prepare('SELECT id FROM users WHERE token = ?');
    let token, attempts = 0;
    do { 
        token = 'tok-' + crypto.randomBytes(12).toString('hex'); 
        attempts++; 
    } while (checkToken.get(token) && attempts < 100);
    return token;
}

// Berechnet die Punkte für alle User per SQL-Update neu
const recalcAllUsers = db.prepare(`
    UPDATE users SET 
        points = COALESCE((SELECT SUM(points) FROM tips WHERE userId = users.id), 0),
        exactTips = COALESCE((SELECT COUNT(*) FROM tips WHERE userId = users.id AND points = 3), 0),
        tendTips = COALESCE((SELECT COUNT(*) FROM tips WHERE userId = users.id AND points >= 1), 0)
`);

// ── Push Helper ───────────────────────────────────────────────────────────────
async function sendPush(userIds, title, body, tag = 'general') {
    if (!webpush || !vapidKeys) return;
    
    let targets = [];
    if (userIds === 'all') {
        targets = db.prepare('SELECT * FROM push_subscriptions').all();
    } else if (userIds.length > 0) {
        const placeholders = userIds.map(() => '?').join(',');
        targets = db.prepare(`SELECT * FROM push_subscriptions WHERE userId IN (${placeholders})`).all(...userIds);
    }

    if (!targets.length) return;
    const payload = JSON.stringify({ title, body, tag });
    const deleteSub = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');

    await Promise.allSettled(targets.map(async s => {
        try {
            const subObj = JSON.parse(s.subscription);
            await webpush.sendNotification(subObj, payload);
        } catch (err) {
            if (err.statusCode === 410 || err.statusCode === 404) {
                deleteSub.run(s.endpoint);
            }
        }
    }));
}

// ── Mitteilungs-Helper ────────────────────────────────────────────────────────
// Schreibt pro Empfänger eine Notification-Zeile und hält je User nur die letzten 50.
const MAX_NOTIFS_PER_USER = 50;
const insertNotif = db.prepare('INSERT INTO notifications (userId, type, title, body, matchId, createdAt) VALUES (?, ?, ?, ?, ?, ?)');
const trimNotifs  = db.prepare(`DELETE FROM notifications WHERE userId = ? AND id NOT IN
    (SELECT id FROM notifications WHERE userId = ? ORDER BY createdAt DESC, id DESC LIMIT ?)`);
function notify(userIds, type, title, body, matchId = null) {
    if (!Array.isArray(userIds) || !userIds.length) return;
    const now = Date.now();
    const tx = db.transaction(ids => {
        for (const uid of ids) {
            insertNotif.run(uid, type, title, body, matchId, now);
            trimNotifs.run(uid, uid, MAX_NOTIFS_PER_USER);
        }
    });
    tx(userIds);
}

// ── Letzte-Chance-Interval (alle 5 Min prüfen) ────────────────────────────────
const sentLastChance = new Set();
setInterval(async () => {
    if (!webpush) return;
    const now = Date.now();
    
    const upcomingMatches = db.prepare('SELECT * FROM matches WHERE finished = 0 AND kickoff > ? AND (kickoff - ?) <= 3600000').all(now, now);
    
    upcomingMatches.forEach(async match => {
        if (sentLastChance.has(match.id)) return;
        sentLastChance.add(match.id);
        
        const untippedUsers = db.prepare(`
            SELECT id FROM users WHERE id NOT IN (
                SELECT userId FROM tips WHERE matchId = ? AND tipA IS NOT NULL
            )
        `).all(match.id);

        if (untippedUsers.length) {
            const min = Math.round((match.kickoff - now) / 60000);
            await sendPush(untippedUsers.map(u => u.id),
                '⏰ Noch nicht getippt!',
                `${match.teamA} vs ${match.teamB} startet in ~${min} Min.`,
                'lastchance'
            );
        }
    });
}, 5 * 60 * 1000);

// ── Morgen-Erinnerung (täglich 9 Uhr) ────────────────────────────────────────
let _morningReminderSent = null;
setInterval(async () => {
    if (!webpush) return;
    const now = new Date();
    if (now.getHours() !== 9 || now.getMinutes() > 4) return;

    const today = now.toDateString();
    if (_morningReminderSent === today) return;

    const nowMs = Date.now();
    const in24h = nowMs + 24 * 60 * 60 * 1000;
    
    const upcoming = db.prepare('SELECT * FROM matches WHERE finished = 0 AND kickoff > ? AND kickoff <= ? ORDER BY kickoff ASC').all(nowMs, in24h);
    if (!upcoming.length) return;
    _morningReminderSent = today;

    const matchIds = upcoming.map(m => `'${m.id}'`).join(',');
    const targets = db.prepare(`
        SELECT u.id FROM users u WHERE EXISTS (
            SELECT 1 FROM matches m WHERE m.id IN (${matchIds}) AND NOT EXISTS (
                SELECT 1 FROM tips t WHERE t.matchId = m.id AND t.userId = u.id AND t.tipA IS NOT NULL
            )
        )
    `).all().map(u => u.id);

    if (!targets.length) return;

    const lines = upcoming.map(m => {
        const time = new Date(m.kickoff).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const teamA = m.teamA.startsWith('TBA') ? '?' : m.teamA.split(' ')[0];
        const teamB = m.teamB.startsWith('TBA') ? '?' : m.teamB.split(' ')[0];
        return `${time} ${teamA}–${teamB}`;
    });
    const body = lines.length <= 4 ? lines.join(' · ') : lines.slice(0, 3).join(' · ') + ` · +${lines.length - 3} weitere`;

    await sendPush(targets, `⚽ ${upcoming.length} Spiel${upcoming.length !== 1 ? 'e' : ''} in den nächsten 24h`, body, 'morning');
}, 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/daten', (req, res) => {
    const { token, admin } = req.query;
    const isAdmin = admin === "GEHEIM123";

    let myUserId = null;
    if (!isAdmin) {
        const check = db.prepare('SELECT id FROM users WHERE token = ?').get(token);
        if (!check) return res.status(403).json({ error: "Kein gueltiges Token" });
        myUserId = check.id;
    }

    const matches = db.prepare(
        'SELECT id, type, group_name AS "group", teamA, teamB, kickoff, resultA, resultB, finished, liveA, liveB FROM matches'
    ).all();
    matches.forEach(m => m.finished = m.finished === 1); // Boolean fix fürs Frontend

    // Fremde Tokens nicht an normale Spieler ausliefern (verhindert Impersonation)
    const users = db.prepare('SELECT id, name, token, points, exactTips, tendTips FROM users').all();
    if (!isAdmin) {
        users.forEach(u => { if (u.id !== myUserId) u.token = null; });
    }

    // Fremde Tipps erst nach Anpfiff / Spielende sichtbar machen (Fairness)
    const now = Date.now();
    const startedIds = new Set(
        db.prepare('SELECT id FROM matches WHERE kickoff <= ? OR finished = 1').all(now).map(m => m.id)
    );
    const tips = db.prepare('SELECT * FROM tips').all().map(t => {
        if (isAdmin || t.userId === myUserId || startedIds.has(t.matchId)) return t;
        return { ...t, tipA: null, tipB: null };
    });

    res.json({
        users,
        matches,
        tips,
        reactions: db.prepare('SELECT * FROM reactions').all(),
        tipReactions: db.prepare('SELECT * FROM tip_reactions').all(),
        comments: db.prepare('SELECT * FROM comments').all(),
        notifications: myUserId
            ? db.prepare('SELECT id, type, title, body, matchId, createdAt FROM notifications WHERE userId = ? ORDER BY createdAt DESC, id DESC LIMIT ?').all(myUserId, MAX_NOTIFS_PER_USER)
            : []
    });
});

// Leichtgewichtiger Änderungs-Zähler: SQLite zählt jede Zeilenänderung selbst.
// Clients pollen das statt der kompletten Daten und laden nur bei echter Änderung neu.
app.get('/api/version', (req, res) => {
    res.json({ v: db.prepare('SELECT total_changes() AS n').get().n });
});

// ── Push Endpoints ────────────────────────────────────────────────────────────

app.get('/api/push/vapid-key', (req, res) => {
    if (!vapidKeys) return res.status(503).json({ error: 'Push nicht verfügbar' });
    res.json({ publicKey: vapidKeys.publicKey });
});


// ── Push Endpoints ────────────────────────────────────────────────────────────
app.post('/api/push/subscribe', (req, res) => {
    const { subscription, token } = req.body;
    if (!subscription) return res.status(400).json({ error: 'Kein Subscription-Objekt' });
    
	let userId = null, userName = null;
    if (token === 'GEHEIM123') { userId = 'admin'; userName = 'Admin'; }
    else {
        const user = db.prepare('SELECT id, name FROM users WHERE token = ?').get(token);
        if (user) { userId = user.id; userName = user.name; }
    }
    if (!userId) return res.status(403).json({ error: 'Kein Zugriff' });

    const endpoint = subscription.endpoint;
    const ua = req.headers['user-agent'] || '';
    const device = /iPhone|iPad/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : 'desktop';

    db.prepare(`
        INSERT INTO push_subscriptions (userId, endpoint, subscription, device) 
        VALUES (@userId, @endpoint, @subStr, @device)
        ON CONFLICT(userId, endpoint) DO UPDATE SET subscription=excluded.subscription, device=excluded.device
    `).run({ userId, endpoint, subStr: JSON.stringify(subscription), device });

	console.log(`✓ Push-Sub: ${userName} auf ${device}`);
    res.json({ success: true });
});

// ── Tip ───────────────────────────────────────────────────────────────────────
app.post('/api/tip', (req, res) => {
    const { matchId, tipA, tipB, token } = req.body;
    const user = db.prepare('SELECT id FROM users WHERE token = ?').get(token);
    if (!user) return res.status(403).json({ error: "Kein Zugriff" });

    const match = db.prepare('SELECT kickoff, finished FROM matches WHERE id = ?').get(matchId);
    if (!match) return res.status(404).json({ error: "Spiel nicht gefunden" });
    if (match.kickoff < Date.now() || match.finished === 1) return res.status(403).json({ error: "Tippzeit abgelaufen!" });

    const pA = parseScore(tipA), pB = parseScore(tipB);
    if (pA === undefined || pB === undefined) return res.status(400).json({ error: "Ungültiger Tipp (0-30)" });

    db.prepare(`
        INSERT INTO tips (userId, matchId, tipA, tipB, points) 
        VALUES (@userId, @matchId, @tipA, @tipB, 0)
        ON CONFLICT(userId, matchId) DO UPDATE SET tipA=excluded.tipA, tipB=excluded.tipB
    `).run({ userId: user.id, matchId, tipA: pA, tipB: pB });

    res.json({ success: true });
});

// ── Admin: Tipp nachträglich ändern/setzen/löschen ────────────────────────────
app.post('/api/admin/tip', (req, res) => {
    const { userId, matchId, tipA, tipB, adminPass } = req.body;
    if (adminPass !== "GEHEIM123") return res.status(403).json({ error: "Falsches Admin-Passwort" });

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: "User nicht gefunden" });

    const match = db.prepare('SELECT resultA, resultB, finished FROM matches WHERE id = ?').get(matchId);
    if (!match) return res.status(404).json({ error: "Spiel nicht gefunden" });

    // Leer = Tipp entfernen
    if (tipA === "" || tipA === null || tipB === "" || tipB === null) {
        db.prepare('DELETE FROM tips WHERE userId = ? AND matchId = ?').run(userId, matchId);
        if (match.finished === 1) recalcAllUsers.run();
        return res.json({ success: true, removed: true });
    }

    const pA = parseScore(tipA), pB = parseScore(tipB);
    if (pA === undefined || pB === undefined) return res.status(400).json({ error: "Ungültiger Tipp (0-30)" });

    // Punkte sofort berechnen, falls Spiel schon beendet
    const points = match.finished === 1 ? calcPoints(pA, pB, match.resultA, match.resultB) : 0;

    db.prepare(`
        INSERT INTO tips (userId, matchId, tipA, tipB, points)
        VALUES (@userId, @matchId, @tipA, @tipB, @points)
        ON CONFLICT(userId, matchId) DO UPDATE SET tipA=excluded.tipA, tipB=excluded.tipB, points=excluded.points
    `).run({ userId, matchId, tipA: pA, tipB: pB, points });

    if (match.finished === 1) recalcAllUsers.run();

    res.json({ success: true });
});

// ── User anlegen ──────────────────────────────────────────────────────────────
app.post('/api/admin/user', (req, res) => {
    const { newUserName, adminPass } = req.body;
    if (adminPass !== "GEHEIM123") return res.status(403).json({ error: "Falsches Admin-Passwort" });
    if (!newUserName?.trim()) return res.status(400).json({ error: "Bitte Namen eingeben." });
    
    const trimmed = newUserName.trim();
    const existing = db.prepare('SELECT id FROM users WHERE LOWER(name) = LOWER(?)').get(trimmed);
    if (existing) return res.status(400).json({ error: `"${trimmed}" existiert bereits.` });

    const newUser = { id: `u${Date.now()}`, name: trimmed, token: generateUniqueToken(), points: 0, exactTips: 0, tendTips: 0 };
    db.prepare('INSERT INTO users (id, name, token, points, exactTips, tendTips) VALUES (?, ?, ?, ?, ?, ?)').run(newUser.id, newUser.name, newUser.token, 0, 0, 0);
    
    res.json({ success: true, user: newUser });
});

// ── User löschen ──────────────────────────────────────────────────────────────
app.delete('/api/admin/user/:id', (req, res) => {
    const { adminPass } = req.body;
    if (adminPass !== "GEHEIM123") return res.status(403).json({ error: "Falsches Admin-Passwort" });
    const userId = req.params.id;
    
    const deleteUserTx = db.transaction(() => {
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        db.prepare('DELETE FROM tips WHERE userId = ?').run(userId);
        db.prepare('DELETE FROM reactions WHERE userId = ?').run(userId);
        db.prepare('DELETE FROM tip_reactions WHERE userId = ? OR targetUserId = ?').run(userId, userId);
        db.prepare('DELETE FROM notifications WHERE userId = ?').run(userId);
        db.prepare('DELETE FROM comments WHERE userId = ?').run(userId);
        db.prepare('DELETE FROM push_subscriptions WHERE userId = ?').run(userId);
    });
    deleteUserTx();
    
    res.json({ success: true });
});

// ── Ergebnis eintragen ────────────────────────────────────────────────────────
app.post('/api/admin/result', async (req, res) => {
    const { matchId, resultA, resultB, teamA, teamB, adminPass } = req.body;
    if (adminPass !== "GEHEIM123") return res.status(403).json({ error: "Falsches Admin-Passwort" });

    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
    if (!match) return res.status(404).json({ error: "Spiel nicht gefunden" });

    if (teamA !== undefined && teamA !== null) db.prepare('UPDATE matches SET teamA = ? WHERE id = ?').run(teamA, matchId);
    if (teamB !== undefined && teamB !== null) db.prepare('UPDATE matches SET teamB = ? WHERE id = ?').run(teamB, matchId);

	if (resultA === "" || resultA === null || resultB === "" || resultB === null) {
        const clearResult = db.transaction(() => {
            db.prepare('UPDATE matches SET resultA = NULL, resultB = NULL, finished = 0 WHERE id = ?').run(matchId);
            db.prepare('UPDATE tips SET points = 0 WHERE matchId = ?').run(matchId);
            recalcAllUsers.run();
        });
        clearResult();
    } else {
        const pA = parseScore(resultA), pB = parseScore(resultB);
        if (pA === undefined || pB === undefined) return res.status(400).json({ error: "Ungültiges Ergebnis" });

        const applyResults = db.transaction(() => {
            db.prepare('UPDATE matches SET resultA = ?, resultB = ?, finished = 1 WHERE id = ?').run(pA, pB, matchId);
            const tips = db.prepare('SELECT userId, tipA, tipB FROM tips WHERE matchId = ?').all(matchId);
            const updateTipPoints = db.prepare('UPDATE tips SET points = ? WHERE matchId = ? AND userId = ?');
            for (const tip of tips) {
                updateTipPoints.run(calcPoints(tip.tipA, tip.tipB, pA, pB), matchId, tip.userId);
            }
            recalcAllUsers.run();
        });
        applyResults();

        // Push Senden
        const ptLabels = ['😭 Daneben', '👍 Tendenz +1P', '📐 Differenz +2P', '🎯 Exakt! +3P'];
        const users = db.prepare('SELECT id FROM users').all();
        for (const u of users) {
            const tip = db.prepare('SELECT tipA, tipB, points FROM tips WHERE matchId = ? AND userId = ?').get(matchId, u.id);
            const body = tip && tip.tipA !== null ? `${ptLabels[tip.points]} (Tipp: ${tip.tipA}:${tip.tipB})` : '⚪ Kein Tipp abgegeben';
            const title = `⚽ ${match.teamA || teamA} ${pA}:${pB} ${match.teamB || teamB}`;
            await sendPush([u.id], title, body, 'result');
            notify([u.id], 'result', title, body, matchId);
        }
    }
    res.json({ success: true });
});

// ── Reaktionen ────────────────────────────────────────────────────────────────
app.post('/api/reaction', async (req, res) => {
    const { matchId, emoji, token } = req.body;
    const user = db.prepare('SELECT id, name FROM users WHERE token = ?').get(token);
    if (!user) return res.status(403).json({ error: "Kein Zugriff" });
    
    const match = db.prepare('SELECT teamA, teamB FROM matches WHERE id = ?').get(matchId);
    if (!match) return res.status(404).json({ error: "Spiel nicht gefunden" });
    
    const allowed = ['🎯','😭','🔥','😱','🤩','😤'];
    if (!allowed.includes(emoji)) return res.status(400).json({ error: "Ungültiges Emoji" });

    const existing = db.prepare('SELECT emoji FROM reactions WHERE matchId = ? AND userId = ?').get(matchId, user.id);
    if (existing) {
        if (existing.emoji === emoji) db.prepare('DELETE FROM reactions WHERE matchId = ? AND userId = ?').run(matchId, user.id);
        else db.prepare('UPDATE reactions SET emoji = ? WHERE matchId = ? AND userId = ?').run(emoji, matchId, user.id);
    } else {
		db.prepare('INSERT INTO reactions (matchId, userId, emoji) VALUES (?, ?, ?)').run(matchId, user.id, emoji);
		const others = db.prepare('SELECT id FROM users WHERE id != ?').all(user.id).map(u => u.id);
		await sendPush(others, `${emoji} ${user.name}`, `${match.teamA} vs ${match.teamB}`, 'reaction');
		notify(others, 'reaction', `${emoji} ${user.name}`, `${match.teamA} vs ${match.teamB}`, matchId);
	}
    res.json({ success: true });
});

// ── Tipp-Reaktionen ───────────────────────────────────────────────────────────
app.post('/api/tip-reaction', async (req, res) => {
    const { matchId, targetUserId, emoji, token } = req.body;
    const user = db.prepare('SELECT id, name FROM users WHERE token = ?').get(token);
    if (!user) return res.status(403).json({ error: "Kein Zugriff" });

    const match = db.prepare('SELECT teamA, teamB, kickoff, finished FROM matches WHERE id = ?').get(matchId);
    if (!match) return res.status(404).json({ error: "Spiel nicht gefunden" });

    // Fairness-Gate: auf Tipps darf erst nach Anpfiff / Spielende reagiert werden
    if (match.kickoff > Date.now() && match.finished !== 1)
        return res.status(403).json({ error: "Tipps noch nicht sichtbar" });

    const target = db.prepare('SELECT id, name FROM users WHERE id = ?').get(targetUserId);
    if (!target) return res.status(404).json({ error: "User nicht gefunden" });

    const allowed = ['😀','😂','🙁','😭','😡','😳','🤑','👍','👏','💪','👎'];
    if (!allowed.includes(emoji)) return res.status(400).json({ error: "Ungültiges Emoji" });

    const existing = db.prepare('SELECT emoji FROM tip_reactions WHERE matchId = ? AND targetUserId = ? AND userId = ?').get(matchId, targetUserId, user.id);
    if (existing) {
        if (existing.emoji === emoji) db.prepare('DELETE FROM tip_reactions WHERE matchId = ? AND targetUserId = ? AND userId = ?').run(matchId, targetUserId, user.id);
        else db.prepare('UPDATE tip_reactions SET emoji = ? WHERE matchId = ? AND targetUserId = ? AND userId = ?').run(emoji, matchId, targetUserId, user.id);
    } else {
        db.prepare('INSERT INTO tip_reactions (matchId, targetUserId, userId, emoji) VALUES (?, ?, ?, ?)').run(matchId, targetUserId, user.id, emoji);
        // Push nur beim ersten Setzen und nicht bei Reaktion auf eigenen Tipp
        if (target.id !== user.id) {
            const body = `reagiert auf deinen Tipp: ${match.teamA} vs ${match.teamB}`;
            await sendPush([target.id], `${emoji} ${user.name}`, body, 'tip-reaction');
            notify([target.id], 'tip-reaction', `${emoji} ${user.name}`, body, matchId);
        }
    }
    res.json({ success: true });
});

// ── Kommentare ────────────────────────────────────────────────────────────────
app.post('/api/comment', async (req, res) => {
    const { matchId, text, token } = req.body;
    const user = db.prepare('SELECT id, name FROM users WHERE token = ?').get(token);
    if (!user) return res.status(403).json({ error: "Kein Zugriff" });
    
    const match = db.prepare('SELECT teamA, teamB FROM matches WHERE id = ?').get(matchId);
    if (!match) return res.status(404).json({ error: "Spiel nicht gefunden" });

    const trimmed = text?.trim();
    if (!trimmed || trimmed.length > 200) return res.status(400).json({ error: "Kommentar ungültig (max 200 Zeichen)" });
    
    const comment = { id: `c${Date.now()}`, matchId, userId: user.id, userName: user.name, text: trimmed, createdAt: Date.now() };
    db.prepare('INSERT INTO comments (id, matchId, userId, userName, text, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(comment.id, comment.matchId, comment.userId, comment.userName, comment.text, comment.createdAt);
    
    const others = db.prepare('SELECT id FROM users WHERE id != ?').all(user.id).map(u => u.id);
    const preview = trimmed.length > 60 ? trimmed.substring(0, 57) + '...' : trimmed;
    await sendPush(others, `💬 ${user.name}`, `${match.teamA} vs ${match.teamB}: "${preview}"`, 'comment');
    notify(others, 'comment', `💬 ${user.name}`, `${match.teamA} vs ${match.teamB}: "${preview}"`, matchId);
    
    res.json({ success: true, comment });
});

app.delete('/api/comment/:id', (req, res) => {
    const { token, adminPass } = req.body;
    const comment = db.prepare('SELECT userId FROM comments WHERE id = ?').get(req.params.id);
    if (!comment) return res.status(404).json({ error: "Kommentar nicht gefunden" });
    
    const user = db.prepare('SELECT id FROM users WHERE token = ?').get(token);
    const isAdmin = adminPass === 'GEHEIM123';
    const isOwner = user && user.id === comment.userId;
    
    if (!isAdmin && !isOwner) return res.status(403).json({ error: "Kein Zugriff" });
    
    db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

app.get('/api/debug/push', (req, res) => {
    if (req.query.admin !== 'GEHEIM123') return res.status(403).end();
    
    // Holt alle Abos sicher aus der SQLite-Tabelle
    const subs = db.prepare('SELECT * FROM push_subscriptions').all();
    
    res.json({
        subscriptions: subs.length,
        webpushAktiv: !!webpush,
        detail: subs.map(s => {
            let ep = '';
            try { ep = JSON.parse(s.subscription).endpoint || ''; } catch(e){}
            return {
                userId: s.userId,
                device: s.device || 'unbekannt',
                endpoint: ep.substring(0, 80)
            };
        })
    });
});

app.delete('/api/debug/push', (req, res) => {
    if (req.query.admin !== 'GEHEIM123') return res.status(403).end();
    
    // Die alte komplizierte Deduplizierung ist nicht mehr nötig, 
    // da SQLite Duplikate durch "ON CONFLICT DO UPDATE" automatisch verhindert.
    // Dieser Endpoint löscht jetzt einfach als Admin-Reset alle Abos.
    db.prepare('DELETE FROM push_subscriptions').run();
    
    res.json({ remaining: 0, message: "Alle Abonnements zurückgesetzt." });
});

app.get('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'tippspiel_admin=; Max-Age=0; Path=/');
    res.redirect('/');
});

// ── Einladung / Selbstanmeldung ───────────────────────────────────────────────
app.get('/einladung', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="de">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
        <title>WM 2026 Tippspiel – Anmeldung</title>
        <style>
            :root{--primary:#28004D;--accent:#FF004D;--accent-green:#ccff00;--bg:#0d1117;--card-bg:#161b22;--border:#30363d;--text:#e6edf3;--text-muted:#8b949e;}
            *{box-sizing:border-box;margin:0;padding:0;}
            body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding-bottom:40px;}
            .hero{background:var(--primary);padding:36px 20px 28px;text-align:center;border-bottom:3px solid var(--accent-green);}
            .hero-icon{font-size:52px;display:block;margin-bottom:10px;}
            .hero h1{font-size:24px;font-weight:900;color:white;margin-bottom:6px;}
            .hero p{color:rgba(255,255,255,.6);font-size:14px;}
            .section{padding:20px 16px 0;}
            .card{background:var(--card-bg);border:1px solid var(--border);border-radius:14px;padding:20px;margin-bottom:14px;}
            h3{color:var(--accent-green);margin:0 0 12px;font-size:16px;}
            input{width:100%;height:46px;font-size:16px;border:2px solid var(--border);border-radius:10px;
                background:var(--bg);color:var(--text);padding:0 14px;outline:none;margin-bottom:12px;}
            input:focus{border-color:var(--accent-green);}
            button{width:100%;height:46px;font-size:15px;font-weight:700;border:none;border-radius:10px;cursor:pointer;transition:.2s;}
            .btn-green{background:#16a34a;color:white;}
            .btn-green:hover{filter:brightness(1.1);}
            .btn-primary{background:var(--primary);color:white;margin-top:8px;}
            #error{color:var(--accent);font-size:13px;margin-top:8px;min-height:18px;}
            #link-box{background:var(--bg);padding:12px;border-radius:8px;border:1px solid var(--border);
                word-break:break-all;color:var(--accent-green);font-size:13px;margin-bottom:14px;user-select:all;}
            .section-title{font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;
                letter-spacing:.8px;margin-bottom:12px;}
            .os-header{display:flex;align-items:center;gap:12px;margin-bottom:14px;}
            .os-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;}
            .os-icon.android{background:linear-gradient(135deg,#34a853,#1a7234);}
            .os-icon.ios{background:linear-gradient(135deg,#555,#222);}
            .os-header h2{font-size:15px;font-weight:700;}
            .os-header small{color:var(--text-muted);font-size:11px;display:block;margin-top:2px;}
            .auto-badge{display:inline-flex;align-items:center;gap:4px;background:rgba(204,255,0,.1);
                border:1px solid rgba(204,255,0,.3);color:var(--accent-green);border-radius:20px;
                padding:3px 10px;font-size:11px;font-weight:700;margin-bottom:12px;}
            .steps{display:flex;flex-direction:column;gap:14px;}
            .step{display:flex;gap:12px;align-items:flex-start;}
            .step-num{width:24px;height:24px;border-radius:50%;background:var(--primary);border:2px solid var(--accent-green);
                color:var(--accent-green);font-size:11px;font-weight:900;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px;}
            .step b{font-size:13px;display:block;margin-bottom:3px;}
            .step p{font-size:12px;color:var(--text-muted);line-height:1.5;}
            @keyframes livePulse{0%,100%{opacity:1}50%{opacity:.4}}
            @keyframes highlight{0%,100%{opacity:1}50%{opacity:.5}}
            /* Phone mockups */
            .mockup-wrap{margin-top:10px;display:flex;justify-content:center;}
            .phone{width:170px;background:#111;border-radius:26px;overflow:hidden;border:2px solid #333;box-shadow:0 6px 20px rgba(0,0,0,.6);}
            .phone-top{height:18px;background:#1a1a1a;display:flex;align-items:center;justify-content:center;}
            .phone-notch{width:56px;height:11px;background:#111;border-radius:0 0 8px 8px;}
            .phone-bottom{height:14px;background:#1a1a1a;display:flex;align-items:center;justify-content:center;}
            .phone-bar{width:44px;height:3px;background:#444;border-radius:2px;}
            .safari-bar{background:#e5e5ea;padding:5px 8px;display:flex;align-items:center;gap:5px;}
            .safari-url{flex:1;background:white;border-radius:7px;padding:4px 8px;font-size:8px;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
            .safari-toolbar{background:#e5e5ea;padding:6px 8px;display:flex;justify-content:space-around;align-items:center;}
            .safari-btn{color:#007aff;font-size:15px;padding:2px;}
            .hl{animation:highlight 1.2s ease-in-out infinite;outline:2px solid var(--accent-green);border-radius:5px;}
            .share-sheet{background:white;border-radius:14px 14px 0 0;position:absolute;bottom:0;left:0;right:0;padding:8px 0 4px;}
            .share-handle{width:32px;height:3px;background:#ccc;border-radius:2px;margin:0 auto 8px;}
            .share-row{display:flex;gap:5px;overflow-x:hidden;padding:0 8px 7px;}
            .share-item{display:flex;flex-direction:column;align-items:center;gap:3px;flex-shrink:0;width:44px;}
            .share-item-icon{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:15px;background:#e5e5ea;}
            .share-item-label{font-size:6px;color:#333;text-align:center;}
            .share-actions{border-top:1px solid #ddd;margin:0 8px;}
            .share-action{padding:6px 0;font-size:9px;color:#333;border-bottom:1px solid #ddd;display:flex;align-items:center;gap:6px;}
            .share-action.hl-row{color:#007aff;font-weight:700;background:rgba(0,122,255,.06);margin:0 -8px;padding:6px 8px;animation:highlight 1.2s ease-in-out infinite;}
            .share-action-icon{width:26px;height:26px;border-radius:6px;background:#e5e5ea;display:flex;align-items:center;justify-content:center;font-size:13px;}
            .add-dialog{background:white;border-radius:12px;margin:8px;overflow:hidden;}
            .add-dialog-nav{background:#f2f2f7;padding:6px 10px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #ddd;}
            .add-dialog-nav span{font-size:9px;color:#555;}
            .add-btn{color:#007aff;font-size:10px;font-weight:700;background:rgba(0,122,255,.1);padding:3px 8px;border-radius:6px;animation:highlight 1.2s ease-in-out infinite;}
            .add-dialog-body{padding:10px;text-align:center;}
            .app-icon-box{width:40px;height:40px;border-radius:9px;background:var(--primary);display:flex;align-items:center;justify-content:center;font-size:18px;margin:0 auto 5px;}
            .android-banner{background:white;border-radius:8px;margin:6px;padding:7px 9px;display:flex;align-items:center;gap:7px;box-shadow:0 2px 8px rgba(0,0,0,.15);}
            .install-btn{background:#1a73e8;color:white;border-radius:14px;padding:4px 9px;font-size:8px;font-weight:700;flex-shrink:0;animation:highlight 1.2s ease-in-out infinite;}
            .info-box{background:rgba(204,255,0,.05);border:1px solid rgba(204,255,0,.2);border-radius:10px;
                padding:12px 14px;font-size:12px;color:var(--text-muted);line-height:1.6;margin-top:14px;}
            .info-box b{color:var(--accent-green);}
        </style>
    </head>
    <body>
        <div class="hero">
            <span class="hero-icon">⚽</span>
            <h1>WM 2026 Tippspiel</h1>
            <p>Melde dich an und tippt gemeinsam!</p>
        </div>

        <div class="section">
            <!-- Step 1: Registrierung -->
            <div class="card" id="step1">
                <h3>Anmelden</h3>
                <input type="text" id="username" placeholder="Dein Name" autocomplete="off"
                    onkeypress="if(event.key==='Enter')register()">
                <button class="btn-green" onclick="register()">Konto erstellen</button>
                <div id="error"></div>
            </div>

            <!-- Step 2: Link -->
            <div class="card" id="step2" style="display:none;">
                <h3>✅ Konto erstellt!</h3>
                <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">
                    Das ist dein persönlicher Login-Link. <b>Speichere ihn!</b> Er dient als Passwort.
                </p>
                <div id="link-box"></div>
                <button class="btn-green" onclick="copyLink()">📋 Link kopieren</button>
                <button class="btn-primary" onclick="goToApp()">🚀 Zum Tippspiel</button>
            </div>

            <!-- Installation Tutorial -->
            <div id="step2-install" style="display:none;">
                <div class="section-title" style="margin-top:6px;">📲 App installieren</div>

                <!-- Android -->
                <div class="card">
                    <div class="os-header">
                        <div class="os-icon android">🤖</div>
                        <div><h2>Android</h2><small>Chrome · Edge · Samsung Browser</small></div>
                    </div>
                    <div class="auto-badge">✓ Automatisch</div>
                    <div class="steps">
                        <div class="step"><div class="step-num">1</div><div><b>Link in Chrome öffnen</b><p>Chrome erkennt die App automatisch.</p></div></div>
                        <div class="step">
                            <div class="step-num">2</div>
                            <div><b>„App installieren" antippen</b><p>Banner erscheint unten automatisch.</p>
                                <div class="mockup-wrap"><div class="phone">
                                    <div class="phone-top"><div class="phone-notch"></div></div>
                                    <div style="background:#f2f2f7;display:flex;flex-direction:column;min-height:130px;">
                                        <div style="background:#fff;padding:5px 8px;display:flex;align-items:center;gap:5px;border-bottom:1px solid #ddd;">
                                            <div style="flex:1;background:#f0f0f5;border-radius:7px;padding:3px 7px;font-size:7px;color:#555;">leppe-lager.duckdns.org</div>
                                        </div>
                                        <div style="flex:1;display:flex;align-items:center;justify-content:center;"><div style="font-size:8px;color:#888;text-align:center;">WM 2026 Tippspiel ⚽</div></div>
                                        <div class="android-banner hl">
                                            <div style="width:32px;height:32px;border-radius:7px;background:var(--primary);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;">⚽</div>
                                            <div style="flex:1;"><b style="font-size:9px;color:#333;display:block;">App installieren</b><small style="font-size:7px;color:#888;">leppe-lager.duckdns.org</small></div>
                                            <div class="install-btn">Installieren</div>
                                        </div>
                                    </div>
                                    <div class="phone-bottom"><div class="phone-bar"></div></div>
                                </div></div>
                            </div>
                        </div>
                        <div class="step"><div class="step-num">3</div><div><b>„Installieren" bestätigen</b><p>App erscheint auf dem Homescreen.</p></div></div>
                    </div>
                </div>

                <!-- iOS -->
                <div class="card">
                    <div class="os-header">
                        <div class="os-icon ios">🍎</div>
                        <div><h2>iPhone / iPad</h2><small>Nur Safari – ab iOS 16.4</small></div>
                    </div>
                    <div class="steps">
                        <div class="step">
                            <div class="step-num">1</div>
                            <div><b>Link in Safari öffnen</b><p>Muss <b>Safari</b> sein – Chrome etc. funktionieren nicht für die Installation.</p>
                                <div class="mockup-wrap"><div class="phone">
                                    <div class="phone-top"><div class="phone-notch"></div></div>
                                    <div style="display:flex;flex-direction:column;min-height:120px;">
                                        <div class="safari-bar"><span style="font-size:11px;color:#007aff;">◀</span><div class="safari-url hl">leppe-lager.duckdns.org</div><span style="font-size:11px;color:#007aff;">↺</span></div>
                                        <div style="flex:1;background:#f2f2f7;display:flex;align-items:center;justify-content:center;"><div style="text-align:center;font-size:8px;color:#888;">WM 2026 Tippspiel</div></div>
                                        <div class="safari-toolbar">
                                            <span class="safari-btn">◀</span><span class="safari-btn">▶</span>
                                            <span class="safari-btn hl" style="font-size:17px;">⬆</span>
                                            <span class="safari-btn">⊞</span><span class="safari-btn">⊕</span>
                                        </div>
                                    </div>
                                    <div class="phone-bottom"><div class="phone-bar"></div></div>
                                </div></div>
                            </div>
                        </div>
                        <div class="step"><div class="step-num">2</div><div><b>Teilen-Button ⬆ antippen</b><p>Das Symbol mit Pfeil nach oben unten in der Safari-Leiste.</p></div></div>
                        <div class="step">
                            <div class="step-num">3</div>
                            <div><b>„Zum Home-Bildschirm" wählen</b><p>Im Menü nach unten scrollen.</p>
                                <div class="mockup-wrap"><div class="phone">
                                    <div class="phone-top"><div class="phone-notch"></div></div>
                                    <div style="min-height:190px;position:relative;display:flex;flex-direction:column;background:#f2f2f7;">
                                        <div style="flex:1;"></div>
                                        <div class="share-sheet">
                                            <div class="share-handle"></div>
                                            <div class="share-row">
                                                <div class="share-item"><div class="share-item-icon">📋</div><div class="share-item-label">Kopieren</div></div>
                                                <div class="share-item"><div class="share-item-icon">📩</div><div class="share-item-label">Nachricht</div></div>
                                                <div class="share-item"><div class="share-item-icon">📧</div><div class="share-item-label">Mail</div></div>
                                            </div>
                                            <div class="share-actions">
                                                <div class="share-action"><div class="share-action-icon">🔖</div>Lesezeichen</div>
                                                <div class="share-action hl-row"><div class="share-action-icon" style="background:#007aff;color:white;">＋</div>Zum Home-Bildschirm</div>
                                                <div class="share-action"><div class="share-action-icon">📝</div>Notiz</div>
                                            </div>
                                        </div>
                                    </div>
                                    <div class="phone-bottom"><div class="phone-bar"></div></div>
                                </div></div>
                            </div>
                        </div>
                        <div class="step">
                            <div class="step-num">4</div>
                            <div><b>„Hinzufügen" antippen</b><p>Oben rechts im Dialog.</p>
                                <div class="mockup-wrap"><div class="phone">
                                    <div class="phone-top"><div class="phone-notch"></div></div>
                                    <div style="background:#000;min-height:140px;padding:8px;">
                                        <div class="add-dialog">
                                            <div class="add-dialog-nav">
                                                <span style="color:#007aff;">Abbrechen</span>
                                                <span style="font-weight:700;font-size:9px;">Zum Home-Bildschirm</span>
                                                <span class="add-btn">Hinzufügen</span>
                                            </div>
                                            <div class="add-dialog-body">
                                                <div class="app-icon-box">⚽</div>
                                                <div style="font-size:10px;font-weight:700;color:#333;">WM 2026 Tippspiel</div>
                                                <div style="font-size:7px;color:#888;margin-top:2px;">leppe-lager.duckdns.org</div>
                                            </div>
                                        </div>
                                    </div>
                                    <div class="phone-bottom"><div class="phone-bar"></div></div>
                                </div></div>
                            </div>
                        </div>
                        <div class="step"><div class="step-num">5</div><div><b>App vom Homescreen starten</b><p>Immer vom Homescreen öffnen — nur so funktionieren Push-Benachrichtigungen auf iOS!</p></div></div>
                    </div>
                    <div class="info-box"><b>⚠️ Wichtig:</b> Push-Benachrichtigungen auf iPhone funktionieren nur wenn die App als PWA vom Homescreen gestartet wird — nicht über Safari direkt.</div>
                </div>
            </div>
        </div>

        <script>
            let personalLink = '';
            async function register() {
                const name = document.getElementById('username').value.trim();
                const err = document.getElementById('error');
                if (!name) return (err.innerText = 'Bitte Namen eingeben.');
                try {
                    const res = await fetch('/api/einladung/register', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name })
                    });
                    const data = await res.json();
                    if (!res.ok || data.error) {
                        err.innerText = data.error || 'Fehler bei der Anmeldung.';
                    } else {
                        personalLink = window.location.origin + '/?token=' + data.user.token;
                        document.getElementById('link-box').innerText = personalLink;
                        document.getElementById('step1').style.display = 'none';
                        document.getElementById('step2').style.display = 'block';
                        document.getElementById('step2-install').style.display = 'block';
                    }
                } catch(e) { err.innerText = 'Netzwerkfehler.'; }
            }
            function copyLink() {
                navigator.clipboard.writeText(personalLink).then(() => {
                    const btn = document.querySelector('#step2 .btn-green');
                    btn.innerText = '✓ Kopiert!';
                    btn.style.background = '#059669';
                    setTimeout(() => { btn.innerText = '📋 Link kopieren'; btn.style.background = '#16a34a'; }, 2000);
                });
            }
            function goToApp() { window.location.href = personalLink; }
        </script>
    </body>
    </html>
    `);
});

app.post('/api/einladung/register', (req, res) => {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Der Name darf nicht leer sein." });
    
    const trimmed = name.trim();
    const existing = db.prepare('SELECT id FROM users WHERE LOWER(name) = LOWER(?)').get(trimmed);
    if (existing) return res.status(400).json({ error: `Der Nutzername "${trimmed}" existiert bereits.` });
    
    const newUser = { id: `u${Date.now()}`, name: trimmed, token: generateUniqueToken(), points: 0, exactTips: 0, tendTips: 0 };
    db.prepare('INSERT INTO users (id, name, token, points, exactTips, tendTips) VALUES (?, ?, ?, ?, ?, ?)').run(newUser.id, newUser.name, newUser.token, 0, 0, 0);
    
    res.json({ success: true, user: newUser });
});

// ── WM-2026 Auto-Sync (OpenLigaDB) ───────────────────────────────────────────
require('./wm-autosync')(
    { db, calcPoints, recalcAllUsers, sendPush, parseScore },
    { leagueShortcut: 'wm26', season: '2026', live: true, pollSec: 60, dryRun: true }
);

app.listen(PORT, () => console.log(`🚀 WM-Tippspiel Server läuft mit SQLite auf Port ${PORT}`));