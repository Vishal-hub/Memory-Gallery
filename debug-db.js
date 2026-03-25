const { app } = require('electron');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

async function debug() {
    console.log('--- DEBUG START ---');
    try {
        const userData = process.env.APPDATA + '\\memory-desktop';
        console.log('UserData Path (approx):', userData);
        
        const dbPath = path.join(userData, 'memory-index.sqlite');
        console.log('DB Path:', dbPath);
        
        if (!fs.existsSync(dbPath)) {
            console.log('DB FILE NOT FOUND!');
            return;
        }

        const db = new Database(dbPath);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        console.log('Tables:', tables.map(t => t.name).join(', '));
        
        if (tables.some(t => t.name === 'settings')) {
            const settings = db.prepare("SELECT * FROM settings").all();
            console.log('Settings:', JSON.stringify(settings, null, 2));
        } else {
            console.log('SETTINGS TABLE MISSING!');
        }
        
    } catch (err) {
        console.error('Debug failed:', err);
    }
    console.log('--- DEBUG END ---');
}

debug();
