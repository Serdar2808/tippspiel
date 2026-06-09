const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_FILE = path.join(__dirname, 'tippspiel_daten.json');
const DB_FILE = path.join(__dirname, 'tippspiel.sqlite');

console.log('🔄 Starte Migration von JSON zu SQLite...');

// 1. JSON-Daten einlesen
let dbJson;
try {
    dbJson = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log(`✓ JSON geladen: ${dbJson.users?.length || 0} User gefunden.`);
} catch (error) {
    console.error('✗ Fehler beim Lesen der JSON-Datei:', error.message);
    process.exit(1);
}

// 2. SQLite-Datenbank initialisieren (erstellt die Datei automatisch)
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL'); // Beschleunigt Schreibvorgänge enorm

// 3. Tabellen-Schema erstellen
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        token TEXT UNIQUE,
        points INTEGER DEFAULT 0,
        exactTips INTEGER DEFAULT 0,
        tendTips INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        type TEXT,
        group_name TEXT,
        teamA TEXT,
        teamB TEXT,
        kickoff INTEGER,
        resultA INTEGER,
        resultB INTEGER,
        finished INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tips (
        userId TEXT,
        matchId TEXT,
        tipA INTEGER,
        tipB INTEGER,
        points INTEGER DEFAULT 0,
        PRIMARY KEY (userId, matchId)
    );

    CREATE TABLE IF NOT EXISTS reactions (
        matchId TEXT,
        userId TEXT,
        emoji TEXT,
        PRIMARY KEY (matchId, userId)
    );

    CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        matchId TEXT,
        userId TEXT,
        userName TEXT,
        text TEXT,
        createdAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
        userId TEXT,
        endpoint TEXT,
        subscription TEXT,
        device TEXT,
        PRIMARY KEY (userId, endpoint)
    );
`);

// 4. Prepared Statements für den Daten-Import vorbereiten
const insertUser = db.prepare('INSERT OR IGNORE INTO users (id, name, token, points, exactTips, tendTips) VALUES (?, ?, ?, ?, ?, ?)');
const insertMatch = db.prepare('INSERT OR IGNORE INTO matches (id, type, group_name, teamA, teamB, kickoff, resultA, resultB, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const insertTip = db.prepare('INSERT OR IGNORE INTO tips (userId, matchId, tipA, tipB, points) VALUES (?, ?, ?, ?, ?)');
const insertReaction = db.prepare('INSERT OR IGNORE INTO reactions (matchId, userId, emoji) VALUES (?, ?, ?)');
const insertComment = db.prepare('INSERT OR IGNORE INTO comments (id, matchId, userId, userName, text, createdAt) VALUES (?, ?, ?, ?, ?, ?)');
const insertPush = db.prepare('INSERT OR IGNORE INTO push_subscriptions (userId, endpoint, subscription, device) VALUES (?, ?, ?, ?)');

// 5. Daten sicher per Transaktion übertragen (alles oder nichts)
const transferData = db.transaction(() => {
    let stats = { users: 0, matches: 0, tips: 0, reactions: 0, comments: 0, push: 0 };

    (dbJson.users || []).forEach(u => {
        insertUser.run(u.id, u.name, u.token, u.points || 0, u.exactTips || 0, u.tendTips || 0);
        stats.users++;
    });

    (dbJson.matches || []).forEach(m => {
        // finished als Boolean in Integer (0/1) umwandeln für SQLite
        insertMatch.run(m.id, m.type, m.group, m.teamA, m.teamB, m.kickoff, m.resultA, m.resultB, m.finished ? 1 : 0);
        stats.matches++;
    });

    (dbJson.tips || []).forEach(t => {
        insertTip.run(t.userId, t.matchId, t.tipA, t.tipB, t.points || 0);
        stats.tips++;
    });

    (dbJson.reactions || []).forEach(r => {
        insertReaction.run(r.matchId, r.userId, r.emoji);
        stats.reactions++;
    });

    (dbJson.comments || []).forEach(c => {
        insertComment.run(c.id, c.matchId, c.userId, c.userName, c.text, c.createdAt);
        stats.comments++;
    });

    (dbJson.pushSubscriptions || []).forEach(p => {
        // Das Push-Objekt sicher als String speichern, damit die Keys nicht kaputtgehen
        const subStr = p.subscription ? JSON.stringify(p.subscription) : null;
        if (subStr && p.subscription.endpoint) {
            insertPush.run(p.userId, p.subscription.endpoint, subStr, p.device || 'unbekannt');
            stats.push++;
        }
    });

    return stats;
});

// 6. Ausführung
try {
    const results = transferData();
    console.log('✅ Migration erfolgreich abgeschlossen!');
    console.log('--- Statistik ---');
    console.table(results);
    console.log('Du kannst nun die Datei tippspiel.sqlite in deinem neuen Backend verwenden.');
} catch (error) {
    console.error('✗ Fehler während der Datenübertragung:', error.message);
} finally {
    db.close();
}