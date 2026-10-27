const fs = require("node:fs");
const Database = require("better-sqlite3");

fs.mkdirSync("data", { recursive: true });
const db = new Database("data/bot.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    dj_role TEXT,
    always_on INTEGER NOT NULL DEFAULT 0,
    autoplay INTEGER NOT NULL DEFAULT 0,
    volume INTEGER,
    voice_channel TEXT,
    text_channel TEXT
  );
  CREATE TABLE IF NOT EXISTS playlists (
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    tracks TEXT NOT NULL,
    PRIMARY KEY (user_id, name)
  );
`);

// Cột thêm sau này: bảng cũ chưa có thì ALTER (tên cột cố định ở đây, không lấy từ người dùng).
const EXTRA = { source: "TEXT", eq: "TEXT", speed: "REAL", pitch: "REAL", color: "TEXT", announce: "INTEGER NOT NULL DEFAULT 1", opus: "INTEGER" };
const have = db.prepare("PRAGMA table_info(guild_settings)").all().map((c) => c.name);
for (const [col, type] of Object.entries(EXTRA)) {
  if (!have.includes(col)) db.exec(`ALTER TABLE guild_settings ADD COLUMN ${col} ${type}`);
}

// Whitelist cột để tên cột đưa vào SQL luôn an toàn.
const COLUMNS = ["dj_role", "always_on", "autoplay", "volume", "voice_channel", "text_channel", ...Object.keys(EXTRA)];

const defaults = {
  dj_role: null, always_on: 0, autoplay: 0, volume: null, voice_channel: null, text_channel: null,
  source: null, eq: null, speed: null, pitch: null, color: null, announce: 1, opus: null,
};

exports.getSettings = (guildId) =>
  db.prepare("SELECT * FROM guild_settings WHERE guild_id = ?").get(guildId) ?? { guild_id: guildId, ...defaults };

exports.setSetting = (guildId, column, value) => {
  if (!COLUMNS.includes(column)) throw new Error(`Cột không hợp lệ: ${column}`);
  db.prepare(
    `INSERT INTO guild_settings (guild_id, ${column}) VALUES (?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET ${column} = excluded.${column}`,
  ).run(guildId, value);
};

exports.alwaysOnGuilds = () =>
  db.prepare("SELECT * FROM guild_settings WHERE always_on = 1 AND voice_channel IS NOT NULL").all();

exports.savePlaylist = (userId, name, tracks) =>
  db
    .prepare("INSERT OR REPLACE INTO playlists (user_id, name, tracks) VALUES (?, ?, ?)")
    .run(userId, name, JSON.stringify(tracks));

exports.getPlaylist = (userId, name) => {
  const row = db.prepare("SELECT tracks FROM playlists WHERE user_id = ? AND name = ?").get(userId, name);
  return row ? JSON.parse(row.tracks) : null;
};

exports.listPlaylists = (userId) =>
  db
    .prepare("SELECT name, tracks FROM playlists WHERE user_id = ? ORDER BY name")
    .all(userId)
    .map((r) => ({ name: r.name, count: JSON.parse(r.tracks).length }));

exports.deletePlaylist = (userId, name) =>
  db.prepare("DELETE FROM playlists WHERE user_id = ? AND name = ?").run(userId, name).changes > 0;
