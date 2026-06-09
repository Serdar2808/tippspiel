const express  = require('express');
const fs       = require('fs').promises;
const fsSync   = require('fs');
const path     = require('path');
const app      = express();
const PORT     = 3000;
const DATA_FILE   = path.join(__dirname, 'tippspiel_daten.json');
const BACKUP_FILE = path.join(__dirname, 'tippspiel_daten_backup.json');
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

// ── Datenbank laden ───────────────────────────────────────────────────────────
let db = { users: [], matches: [], tips: [], reactions: [], comments: [], pushSubscriptions: [] };

if (fsSync.existsSync(DATA_FILE)) {
    try {
        db = JSON.parse(fsSync.readFileSync(DATA_FILE, 'utf8'));
        if (!db.tips)              db.tips              = [];
        if (!db.users)             db.users             = [];
        if (!db.matches)           db.matches           = [];
        if (!db.reactions)         db.reactions         = [];
        if (!db.comments)          db.comments          = [];
        if (!db.pushSubscriptions) db.pushSubscriptions = [];
        console.log(`✓ DB: ${db.users.length} User, ${db.matches.length} Spiele, ${db.tips.length} Tipps, ${db.comments.length} Kommentare`);
    } catch (e) {
        console.error('✗ DB-Fehler:', e.message);
    }
} else {
    const wmGroups = {
        A: ["Mexiko","Südkorea","Südafrika","Tschechien"],
        B: ["Kanada","Schweiz","Katar","Bosnien und Herzegowina"],
        C: ["Brasilien","Marokko","Schottland","Haiti"],
        D: ["USA","Australien","Paraguay","Türkei"],
        E: ["Deutschland","Ecuador","Elfenbeinküste","Curaçao"],
        F: ["Niederlande","Japan","Tunesien","Schweden"],
        G: ["Belgien","Iran","Ägypten","Neuseeland"],
        H: ["Spanien","Uruguay","Saudi-Arabien","Kap Verde"],
        I: ["Frankreich","Senegal","Norwegen","Irak"],
        J: ["Argentinien","Österreich","Algerien","Jordanien"],
        K: ["Portugal","Kolumbien","Usbekistan","DR Kongo"],
        L: ["England","Kroatien","Panama","Ghana"]
    };
    db.users = []; db.reactions = []; db.comments = []; db.pushSubscriptions = [];
    let mId = 1;
    const groupSchedules = [
        { a:"Mexiko",b:"Südafrika",time:"2026-06-11T21:00:00+02:00" },
        { a:"Südkorea",b:"Tschechien",time:"2026-06-12T04:00:00+02:00" },
        { a:"Kanada",b:"Bosnien und Herzegowina",time:"2026-06-12T21:00:00+02:00" },
        { a:"USA",b:"Paraguay",time:"2026-06-13T03:00:00+02:00" },
        { a:"Katar",b:"Schweiz",time:"2026-06-13T21:00:00+02:00" },
        { a:"Brasilien",b:"Marokko",time:"2026-06-14T00:00:00+02:00" },
        { a:"Haiti",b:"Schottland",time:"2026-06-14T03:00:00+02:00" },
        { a:"Australien",b:"Türkei",time:"2026-06-14T06:00:00+02:00" },
        { a:"Deutschland",b:"Curaçao",time:"2026-06-14T19:00:00+02:00" },
        { a:"Niederlande",b:"Japan",time:"2026-06-14T22:00:00+02:00" },
        { a:"Elfenbeinküste",b:"Ecuador",time:"2026-06-15T01:00:00+02:00" },
        { a:"Schweden",b:"Tunesien",time:"2026-06-15T04:00:00+02:00" },
        { a:"Spanien",b:"Kap Verde",time:"2026-06-15T18:00:00+02:00" },
        { a:"Belgien",b:"Ägypten",time:"2026-06-15T21:00:00+02:00" },
        { a:"Saudi-Arabien",b:"Uruguay",time:"2026-06-16T00:00:00+02:00" },
        { a:"Iran",b:"Neuseeland",time:"2026-06-16T03:00:00+02:00" },
        { a:"Frankreich",b:"Senegal",time:"2026-06-16T21:00:00+02:00" },
        { a:"Irak",b:"Norwegen",time:"2026-06-17T00:00:00+02:00" },
        { a:"Argentinien",b:"Algerien",time:"2026-06-17T03:00:00+02:00" },
        { a:"Österreich",b:"Jordanien",time:"2026-06-17T06:00:00+02:00" },
        { a:"Portugal",b:"DR Kongo",time:"2026-06-17T19:00:00+02:00" },
        { a:"England",b:"Kroatien",time:"2026-06-17T22:00:00+02:00" },
        { a:"Ghana",b:"Panama",time:"2026-06-18T01:00:00+02:00" },
        { a:"Usbekistan",b:"Kolumbien",time:"2026-06-18T04:00:00+02:00" },
        { a:"Tschechien",b:"Südafrika",time:"2026-06-18T18:00:00+02:00" },
        { a:"Schweiz",b:"Bosnien und Herzegowina",time:"2026-06-18T21:00:00+02:00" },
        { a:"Kanada",b:"Katar",time:"2026-06-19T00:00:00+02:00" },
        { a:"Mexiko",b:"Südkorea",time:"2026-06-19T03:00:00+02:00" },
        { a:"USA",b:"Australien",time:"2026-06-19T21:00:00+02:00" },
        { a:"Schottland",b:"Marokko",time:"2026-06-20T00:00:00+02:00" },
        { a:"Brasilien",b:"Haiti",time:"2026-06-20T02:30:00+02:00" },
        { a:"Türkei",b:"Paraguay",time:"2026-06-20T05:00:00+02:00" },
        { a:"Niederlande",b:"Schweden",time:"2026-06-20T19:00:00+02:00" },
        { a:"Deutschland",b:"Elfenbeinküste",time:"2026-06-20T22:00:00+02:00" },
        { a:"Ecuador",b:"Curaçao",time:"2026-06-21T02:00:00+02:00" },
        { a:"Tunesien",b:"Japan",time:"2026-06-21T06:00:00+02:00" },
        { a:"Spanien",b:"Saudi-Arabien",time:"2026-06-21T18:00:00+02:00" },
        { a:"Belgien",b:"Iran",time:"2026-06-21T21:00:00+02:00" },
        { a:"Uruguay",b:"Kap Verde",time:"2026-06-22T00:00:00+02:00" },
        { a:"Neuseeland",b:"Ägypten",time:"2026-06-22T03:00:00+02:00" },
        { a:"Argentinien",b:"Österreich",time:"2026-06-22T19:00:00+02:00" },
        { a:"Frankreich",b:"Irak",time:"2026-06-22T23:00:00+02:00" },
        { a:"Norwegen",b:"Senegal",time:"2026-06-23T02:00:00+02:00" },
        { a:"Jordanien",b:"Algerien",time:"2026-06-23T05:00:00+02:00" },
        { a:"Portugal",b:"Usbekistan",time:"2026-06-23T19:00:00+02:00" },
        { a:"England",b:"Ghana",time:"2026-06-23T22:00:00+02:00" },
        { a:"Panama",b:"Kroatien",time:"2026-06-24T01:00:00+02:00" },
        { a:"Kolumbien",b:"DR Kongo",time:"2026-06-24T04:00:00+02:00" },
        { a:"Schweiz",b:"Kanada",time:"2026-06-24T21:00:00+02:00" },
        { a:"Bosnien und Herzegowina",b:"Katar",time:"2026-06-24T21:00:00+02:00" },
        { a:"Schottland",b:"Brasilien",time:"2026-06-25T00:00:00+02:00" },
        { a:"Marokko",b:"Haiti",time:"2026-06-25T00:00:00+02:00" },
        { a:"Tschechien",b:"Mexiko",time:"2026-06-25T03:00:00+02:00" },
        { a:"Südafrika",b:"Südkorea",time:"2026-06-25T03:00:00+02:00" },
        { a:"Curaçao",b:"Elfenbeinküste",time:"2026-06-25T22:00:00+02:00" },
        { a:"Ecuador",b:"Deutschland",time:"2026-06-25T22:00:00+02:00" },
        { a:"Japan",b:"Schweden",time:"2026-06-26T01:00:00+02:00" },
        { a:"Tunesien",b:"Niederlande",time:"2026-06-26T01:00:00+02:00" },
        { a:"Türkei",b:"USA",time:"2026-06-26T04:00:00+02:00" },
        { a:"Paraguay",b:"Australien",time:"2026-06-26T04:00:00+02:00" },
        { a:"Norwegen",b:"Frankreich",time:"2026-06-26T21:00:00+02:00" },
        { a:"Senegal",b:"Irak",time:"2026-06-26T21:00:00+02:00" },
        { a:"Kap Verde",b:"Saudi-Arabien",time:"2026-06-27T02:00:00+02:00" },
        { a:"Uruguay",b:"Spanien",time:"2026-06-27T02:00:00+02:00" },
        { a:"Neuseeland",b:"Belgien",time:"2026-06-27T05:00:00+02:00" },
        { a:"Ägypten",b:"Iran",time:"2026-06-27T05:00:00+02:00" },
        { a:"Panama",b:"England",time:"2026-06-27T23:00:00+02:00" },
        { a:"Kroatien",b:"Ghana",time:"2026-06-27T23:00:00+02:00" },
        { a:"Kolumbien",b:"Portugal",time:"2026-06-28T01:30:00+02:00" },
        { a:"DR Kongo",b:"Usbekistan",time:"2026-06-28T01:30:00+02:00" },
        { a:"Österreich",b:"Algerien",time:"2026-06-28T04:00:00+02:00" },
        { a:"Argentinien",b:"Jordanien",time:"2026-06-28T04:00:00+02:00" }
    ];
    groupSchedules.forEach(m => {
        let group = '';
        for (const [g, teams] of Object.entries(wmGroups)) { if (teams.includes(m.a)) group = g; }
        db.matches.push({ id:`m${mId++}`, type:'group', group, teamA:m.a, teamB:m.b, kickoff:Date.parse(m.time), resultA:null, resultB:null, finished:false });
    });
    const koSchedule = {
        'Sechzehntelfinale': [
            '2026-06-29T18:00+02:00','2026-06-29T21:00+02:00',
            '2026-06-30T18:00+02:00','2026-06-30T21:00+02:00',
            '2026-07-01T18:00+02:00','2026-07-01T21:00+02:00',
            '2026-07-02T18:00+02:00','2026-07-02T21:00+02:00',
            '2026-07-03T18:00+02:00','2026-07-03T21:00+02:00',
            '2026-07-04T18:00+02:00','2026-07-04T21:00+02:00',
            '2026-07-05T18:00+02:00','2026-07-05T21:00+02:00',
            '2026-07-06T18:00+02:00','2026-07-06T21:00+02:00',
        ],
        'Achtelfinale': [
            '2026-07-08T18:00+02:00','2026-07-08T21:00+02:00',
            '2026-07-09T18:00+02:00','2026-07-09T21:00+02:00',
            '2026-07-10T18:00+02:00','2026-07-10T21:00+02:00',
            '2026-07-11T18:00+02:00','2026-07-11T21:00+02:00',
        ],
        'Viertelfinale': [
            '2026-07-15T18:00+02:00','2026-07-15T21:00+02:00',
            '2026-07-16T18:00+02:00','2026-07-16T21:00+02:00',
        ],
        'Halbfinale':         ['2026-07-18T21:00+02:00','2026-07-19T21:00+02:00'],
        'Spiel um Platz 3':   ['2026-07-23T21:00+02:00'],
        'Finale':             ['2026-07-24T21:00+02:00'],
    };
    ['Sechzehntelfinale','Achtelfinale','Viertelfinale','Halbfinale','Spiel um Platz 3','Finale'].forEach(name => {
        koSchedule[name].forEach((time, i) => {
            db.matches.push({ id:`m${mId++}`, type:'ko', group:name,
                teamA:`TBA (${name})`, teamB:`TBA (${name})`,
                kickoff:Date.parse(time), resultA:null, resultB:null, finished:false });
        });
    });
    fsSync.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

let _saveCounter = 0;
let _saveQueue   = Promise.resolve();
async function saveData() {
    _saveQueue = _saveQueue.then(async () => {
        await fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2));
        if (++_saveCounter % 10 === 0) {
            await fs.writeFile(BACKUP_FILE, JSON.stringify(db, null, 2))
                .catch(e => console.error('✗ Backup-Fehler:', e.message));
        }
    });
    return _saveQueue;
}

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
    const crypto = require('crypto');
    let token, attempts = 0;
    do { token = 'tok-' + crypto.randomBytes(12).toString('hex'); attempts++; }
    while (db.users.some(u => u.token === token) && attempts < 100);
    return token;
}

function recalcAllUsers() {
    db.users.forEach(u => {
        const userTips = db.tips.filter(t => t.userId === u.id);
        u.points    = userTips.reduce((s, t) => s + (t.points || 0), 0);
        u.exactTips = userTips.filter(t => t.points === 3).length;
        u.tendTips  = userTips.filter(t => t.points >= 1).length;
    });
}

// ── Push Helper ───────────────────────────────────────────────────────────────
async function sendPush(userIds, title, body, tag = 'general') {
    if (!webpush || !vapidKeys) return;
    const targets = userIds === 'all'
        ? db.pushSubscriptions
        : db.pushSubscriptions.filter(s => userIds.includes(s.userId));
    if (!targets.length) return;
    const payload = JSON.stringify({ title, body, tag });
    const expired = [];
    await Promise.allSettled(targets.map(async s => {
        try {
            await webpush.sendNotification(s.subscription, payload);
        } catch (err) {
            console.error(`Push-Fehler für User ${s.userId}:`, err.statusCode, err.message);
            if (err.statusCode === 410 || err.statusCode === 404) expired.push(s);
        }
    }));
    if (expired.length) {
        db.pushSubscriptions = db.pushSubscriptions.filter(s => !expired.includes(s));
        await saveData();
    }
}

// ── Letzte-Chance-Interval (alle 5 Min prüfen) ────────────────────────────────
const sentLastChance = new Set();
setInterval(async () => {
    if (!webpush) return;
    const now = Date.now();
    db.matches
        .filter(m => !m.finished && m.kickoff > now && !sentLastChance.has(m.id) && (m.kickoff - now) <= 60 * 60000)
        .forEach(async match => {
            sentLastChance.add(match.id);
            const untipped = db.users.filter(u =>
                !db.tips.find(t => t.matchId === match.id && t.userId === u.id && t.tipA !== null)
            );
            if (untipped.length) {
                const min = Math.round((match.kickoff - now) / 60000);
                await sendPush(untipped.map(u => u.id),
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

    const nowMs  = Date.now();
    const in24h  = nowMs + 24 * 60 * 60 * 1000;
    const upcoming = db.matches
        .filter(m => !m.finished && m.kickoff > nowMs && m.kickoff <= in24h)
        .sort((a, b) => a.kickoff - b.kickoff);

    if (!upcoming.length) return;
    _morningReminderSent = today;

    // Nur User die mind. 1 Spiel noch nicht getippt haben
    const targets = db.users
        .filter(u => upcoming.some(m =>
            !db.tips.find(t => t.matchId === m.id && t.userId === u.id && t.tipA !== null)
        ))
        .map(u => u.id);

    if (!targets.length) return;

    // Kompaktes Match-Format (max 3 anzeigen + "+N weitere")
    const lines = upcoming.map(m => {
        const time  = new Date(m.kickoff).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const teamA = m.teamA.startsWith('TBA') ? '?' : m.teamA.split(' ')[0];
        const teamB = m.teamB.startsWith('TBA') ? '?' : m.teamB.split(' ')[0];
        return `${time} ${teamA}–${teamB}`;
    });
    const body = lines.length <= 4
        ? lines.join(' · ')
        : lines.slice(0, 3).join(' · ') + ` · +${lines.length - 3} weitere`;

    await sendPush(
        targets,
        `⚽ ${upcoming.length} Spiel${upcoming.length !== 1 ? 'e' : ''} in den nächsten 24h`,
        body,
        'morning'
    );
    console.log(`✓ Morgen-Erinnerung: ${upcoming.length} Spiele → ${targets.length} User`);
}, 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/daten', (req, res) => {
    if (req.query.admin === "GEHEIM123") return res.json(db);
    const user = db.users.find(u => u.token === req.query.token);
    if (!user) return res.status(403).json({ error: "Kein gueltiges Token" });
    res.json(db);
});


// ── Push Endpoints ────────────────────────────────────────────────────────────

app.get('/api/push/vapid-key', (req, res) => {
    if (!vapidKeys) return res.status(503).json({ error: 'Push nicht verfügbar' });
    res.json({ publicKey: vapidKeys.publicKey });
});


app.post('/api/push/subscribe', async (req, res) => {
    const { subscription, token } = req.body;
    if (!subscription) return res.status(400).json({ error: 'Kein Subscription-Objekt' });
    const user = db.users.find(u => u.token === token);
    const userId = user ? user.id : (token === 'GEHEIM123' ? 'admin' : null);
    if (!userId) return res.status(403).json({ error: 'Kein Zugriff' });

    const endpoint = subscription.endpoint;
    const ua = req.headers['user-agent'] || '';
    const device = /iPhone|iPad/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : 'desktop';

    // Gleicher Endpoint = gleiches Gerät → ersetzen
    db.pushSubscriptions = db.pushSubscriptions.filter(s =>
        s.subscription?.endpoint !== endpoint
    );
    db.pushSubscriptions.push({ userId, subscription, device });
    console.log(`✓ Push-Sub: ${userId} auf ${device} (${endpoint.substring(0,40)}...)`);
    await saveData();
    res.json({ success: true });
});

// ── Tip ───────────────────────────────────────────────────────────────────────
app.post('/api/tip', async (req, res) => {
    const { matchId, tipA, tipB, token } = req.body;
    const user = db.users.find(u => u.token === token);
    if (!user) return res.status(403).json({ error: "Kein Zugriff" });
    const match = db.matches.find(m => m.id === matchId);
    if (!match) return res.status(404).json({ error: "Spiel nicht gefunden" });
    if (match.kickoff < Date.now() || match.finished)
        return res.status(403).json({ error: "Tippzeit abgelaufen!" });
    const parsedA = parseScore(tipA), parsedB = parseScore(tipB);
    if (parsedA === undefined || parsedB === undefined)
        return res.status(400).json({ error: "Ungültiger Tipp (0-30)" });
    let tip = db.tips.find(t => t.userId === user.id && t.matchId === matchId);
    if (tip) { tip.tipA = parsedA; tip.tipB = parsedB; }
    else { tip = { userId:user.id, matchId, tipA:parsedA, tipB:parsedB, points:0 }; db.tips.push(tip); }
    if (match.finished) {
        tip.points = calcPoints(tip.tipA, tip.tipB, match.resultA, match.resultB);
        recalcAllUsers();
    }
    await saveData();
    res.json({ success: true });
});

// ── User anlegen ──────────────────────────────────────────────────────────────
app.post('/api/admin/user', async (req, res) => {
    const { newUserName, adminPass } = req.body;
    if (adminPass !== "GEHEIM123") return res.status(403).json({ error: "Falsches Admin-Passwort" });
    if (!newUserName?.trim()) return res.status(400).json({ error: "Bitte Namen eingeben." });
    const trimmed = newUserName.trim();
    if (db.users.some(u => u.name.toLowerCase() === trimmed.toLowerCase()))
        return res.status(400).json({ error: `"${trimmed}" existiert bereits.` });
    const newUser = { id:`u${Date.now()}`, name:trimmed, token:generateUniqueToken(), points:0, exactTips:0, tendTips:0 };
    db.users.push(newUser);
    await saveData();
    res.json({ success: true, user: newUser });
});

// ── User löschen ──────────────────────────────────────────────────────────────
app.delete('/api/admin/user/:id', async (req, res) => {
    const { adminPass } = req.body;
    if (adminPass !== "GEHEIM123") return res.status(403).json({ error: "Falsches Admin-Passwort" });
    const idx = db.users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "User nicht gefunden" });
    const userId = req.params.id;
    db.users.splice(idx, 1);
    db.tips              = db.tips.filter(t => t.userId !== userId);
    db.reactions         = db.reactions.filter(r => r.userId !== userId);
    db.comments          = db.comments.filter(c => c.userId !== userId);
    db.pushSubscriptions = db.pushSubscriptions.filter(s => s.userId !== userId);
    await saveData();
    res.json({ success: true });
});

// ── Ergebnis eintragen ────────────────────────────────────────────────────────
app.post('/api/admin/result', async (req, res) => {
    const { matchId, resultA, resultB, teamA, teamB, adminPass } = req.body;
    if (adminPass !== "GEHEIM123") return res.status(403).json({ error: "Falsches Admin-Passwort" });
    const match = db.matches.find(m => m.id === matchId);
    if (!match) return res.status(404).json({ error: "Spiel nicht gefunden" });
    if (teamA !== undefined && teamA !== null) match.teamA = teamA;
    if (teamB !== undefined && teamB !== null) match.teamB = teamB;

    if (resultA === "" || resultA === null || resultB === "" || resultB === null) {
        match.resultA = null; match.resultB = null; match.finished = false;
        db.tips.filter(t => t.matchId === matchId).forEach(t => t.points = 0);
    } else {
        const pA = parseScore(resultA), pB = parseScore(resultB);
        if (pA === undefined || pB === undefined) return res.status(400).json({ error: "Ungültiges Ergebnis (0-30)" });
        match.resultA = pA; match.resultB = pB; match.finished = true;
        db.tips.forEach(t => {
            if (t.matchId === matchId) t.points = calcPoints(t.tipA, t.tipB, pA, pB);
        });
        // Push: Ergebnis + Punkte (personalisiert pro User)
        const ptLabels = ['😭 Daneben', '👍 Tendenz +1P', '📐 Differenz +2P', '🎯 Exakt! +3P'];
        for (const user of db.users) {
            const tip = db.tips.find(t => t.matchId === matchId && t.userId === user.id);
            const body = tip && tip.tipA !== null
                ? `${ptLabels[tip.points]} (Tipp: ${tip.tipA}:${tip.tipB})`
                : '⚪ Kein Tipp abgegeben';
            await sendPush([user.id],
                `⚽ ${match.teamA} ${pA}:${pB} ${match.teamB}`,
                body, 'result'
            );
        }
    }
    recalcAllUsers();
    await saveData();
    res.json({ success: true });
});

// ── Reaktionen ────────────────────────────────────────────────────────────────
app.post('/api/reaction', async (req, res) => {
    const { matchId, emoji, token } = req.body;
    const user = db.users.find(u => u.token === token);
    if (!user) return res.status(403).json({ error: "Kein Zugriff" });
    const match = db.matches.find(m => m.id === matchId);
    if (!match) return res.status(404).json({ error: "Spiel nicht gefunden" });
    const allowed = ['🎯','😭','🔥','😱','🤩','😤'];
    if (!allowed.includes(emoji)) return res.status(400).json({ error: "Ungültiges Emoji" });
    const existing = db.reactions.find(r => r.matchId === matchId && r.userId === user.id);
    if (existing) {
        if (existing.emoji === emoji) db.reactions = db.reactions.filter(r => !(r.matchId === matchId && r.userId === user.id));
        else existing.emoji = emoji;
    } else {
        db.reactions.push({ matchId, userId: user.id, emoji });
        // Push an andere User
        const others = db.users.filter(u => u.id !== user.id).map(u => u.id);
        await sendPush(others, `${emoji} ${user.name}`, `${match.teamA} vs ${match.teamB}`, 'reaction');
    }
    await saveData();
    res.json({ success: true });
});

// ── Kommentare ────────────────────────────────────────────────────────────────
app.post('/api/comment', async (req, res) => {
    const { matchId, text, token } = req.body;
    const user = db.users.find(u => u.token === token);
    if (!user) return res.status(403).json({ error: "Kein Zugriff" });
    const match = db.matches.find(m => m.id === matchId);
    if (!match) return res.status(404).json({ error: "Spiel nicht gefunden" });

    const trimmed = text?.trim();
    if (!trimmed || trimmed.length > 200) return res.status(400).json({ error: "Kommentar ungültig (max 200 Zeichen)" });
    const comment = { id:`c${Date.now()}`, matchId, userId:user.id, userName:user.name, text:trimmed, createdAt:Date.now() };
    db.comments.push(comment);
    await saveData();
    // Push an alle anderen
    const others = db.users.filter(u => u.id !== user.id).map(u => u.id);
    const preview = trimmed.length > 60 ? trimmed.substring(0, 57) + '...' : trimmed;
    await sendPush(others, `💬 ${user.name}`, `${match.teamA} vs ${match.teamB}: "${preview}"`, 'comment');
    res.json({ success: true, comment });
});

app.delete('/api/comment/:id', async (req, res) => {
    const { token, adminPass } = req.body;
    const comment = db.comments?.find(c => c.id === req.params.id);
    if (!comment) return res.status(404).json({ error: "Kommentar nicht gefunden" });
    const user = db.users.find(u => u.token === token);
    const isAdmin = adminPass === 'GEHEIM123';
    const isOwner = user && user.id === comment.userId;
    if (!isAdmin && !isOwner) return res.status(403).json({ error: "Kein Zugriff" });
    db.comments = db.comments.filter(c => c.id !== comment.id);
    await saveData();
    res.json({ success: true });
});

app.get('/api/debug/push', (req, res) => {
    if (req.query.admin !== 'GEHEIM123') return res.status(403).end();
    res.json({
        subscriptions: db.pushSubscriptions.length,
        webpushAktiv: !!webpush,
        detail: db.pushSubscriptions.map(s => ({
            userId: s.userId,
            device: s.device || 'unbekannt',
            // iOS APNs-Endpoints enthalten "apple.com", Chrome enthält "fcm.googleapis"
            endpoint: (s.subscription?.endpoint || '').substring(0, 80)
        }))
    });
});

app.delete('/api/debug/push', (req, res) => {
    if (req.query.admin !== 'GEHEIM123') return res.status(403).end();
    // Alte Subscriptions mit gleichem Endpoint deduplizieren
    const seen = new Set();
    db.pushSubscriptions = db.pushSubscriptions.filter(s => {
        const ep = s.subscription?.endpoint;
        if (seen.has(ep)) return false;
        seen.add(ep);
        return true;
    });
    saveData();
    res.json({ remaining: db.pushSubscriptions.length, detail: db.pushSubscriptions.map(s => ({ userId: s.userId, device: s.device })) });
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

app.post('/api/einladung/register', async (req, res) => {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Der Name darf nicht leer sein." });
    
    const trimmed = name.trim();
    if (db.users.some(u => u.name.toLowerCase() === trimmed.toLowerCase())) {
        return res.status(400).json({ error: `Der Nutzername "${trimmed}" existiert bereits.` });
    }
    
    const newUser = { 
        id: `u${Date.now()}`, 
        name: trimmed, 
        token: generateUniqueToken(), 
        points: 0, 
        exactTips: 0, 
        tendTips: 0 
    };
    
    db.users.push(newUser);
    await saveData();
    res.json({ success: true, user: newUser });
});


// ── Einmalige KO-Datum-Migration ─────────────────────────────────────────────
app.get('/api/admin/fix-ko-dates', async (req, res) => {
    if (req.query.admin !== 'GEHEIM123') return res.status(403).end();
    const schedule = {
        'Sechzehntelfinale': [
            '2026-06-29T18:00+02:00','2026-06-29T21:00+02:00',
            '2026-06-30T18:00+02:00','2026-06-30T21:00+02:00',
            '2026-07-01T18:00+02:00','2026-07-01T21:00+02:00',
            '2026-07-02T18:00+02:00','2026-07-02T21:00+02:00',
            '2026-07-03T18:00+02:00','2026-07-03T21:00+02:00',
            '2026-07-04T18:00+02:00','2026-07-04T21:00+02:00',
            '2026-07-05T18:00+02:00','2026-07-05T21:00+02:00',
            '2026-07-06T18:00+02:00','2026-07-06T21:00+02:00',
        ],
        'Achtelfinale': [
            '2026-07-08T18:00+02:00','2026-07-08T21:00+02:00',
            '2026-07-09T18:00+02:00','2026-07-09T21:00+02:00',
            '2026-07-10T18:00+02:00','2026-07-10T21:00+02:00',
            '2026-07-11T18:00+02:00','2026-07-11T21:00+02:00',
        ],
        'Viertelfinale': [
            '2026-07-15T18:00+02:00','2026-07-15T21:00+02:00',
            '2026-07-16T18:00+02:00','2026-07-16T21:00+02:00',
        ],
        'Halbfinale':       ['2026-07-18T21:00+02:00','2026-07-19T21:00+02:00'],
        'Spiel um Platz 3': ['2026-07-23T21:00+02:00'],
        'Finale':           ['2026-07-24T21:00+02:00'],
    };
    let fixed = 0;
    for (const [round, dates] of Object.entries(schedule)) {
        const matches = db.matches
            .filter(m => m.type === 'ko' && m.group === round)
            .sort((a, b) => a.kickoff - b.kickoff);
        matches.forEach((m, i) => {
            if (dates[i]) { m.kickoff = Date.parse(dates[i]); fixed++; }
        });
    }
    await saveData();
    res.json({ ok: true, fixed, message: `${fixed} KO-Spiele korrigiert` });
});

app.listen(PORT, () => console.log(`✓ Server läuft auf Port ${PORT}`));