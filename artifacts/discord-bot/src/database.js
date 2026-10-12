import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const filePath = resolve(process.env.BOT_DATABASE_PATH || "artifacts/discord-bot/data/moderation.sqlite");
mkdirSync(dirname(filePath), { recursive: true });

export const db = new DatabaseSync(filePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT NOT NULL,
    setting_key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guild_id, setting_key)
  );
  CREATE TABLE IF NOT EXISTS cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    moderator_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS cases_guild_target ON cases(guild_id, target_id, id DESC);
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL UNIQUE,
    opener_id TEXT NOT NULL,
    category_key TEXT NOT NULL,
    assigned_to TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TEXT,
    close_reason TEXT,
    priority TEXT NOT NULL DEFAULT 'normal'
  );
  CREATE INDEX IF NOT EXISTS tickets_guild_opener ON tickets(guild_id, opener_id, status);
  CREATE TABLE IF NOT EXISTS ticket_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(ticket_id) REFERENCES tickets(id)
  );
  CREATE TABLE IF NOT EXISTS campaign_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const getSettingStmt = db.prepare("SELECT value_json FROM guild_settings WHERE guild_id = ? AND setting_key = ?");
const saveSettingStmt = db.prepare(`
  INSERT INTO guild_settings (guild_id, setting_key, value_json, updated_at)
  VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(guild_id, setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
`);

export function getSetting(guildId, key, fallback = null) {
  const row = getSettingStmt.get(guildId, key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return fallback;
  }
}

export function setSetting(guildId, key, value) {
  saveSettingStmt.run(guildId, key, JSON.stringify(value));
  return value;
}

export function createCase({ guildId, kind, targetId, moderatorId, reason, expiresAt = null, metadata = {} }) {
  const result = db.prepare(`
    INSERT INTO cases (guild_id, kind, target_id, moderator_id, reason, expires_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(guildId, kind, targetId, moderatorId, reason, expiresAt, JSON.stringify(metadata));
  return getCase(guildId, Number(result.lastInsertRowid));
}

export function getCase(guildId, id) {
  return db.prepare("SELECT * FROM cases WHERE guild_id = ? AND id = ?").get(guildId, id);
}

export function listCases(guildId, targetId, limit = 15) {
  return db.prepare("SELECT * FROM cases WHERE guild_id = ? AND target_id = ? ORDER BY id DESC LIMIT ?").all(guildId, targetId, limit);
}

export function updateCase(guildId, id, updates) {
  const row = getCase(guildId, id);
  if (!row) return null;
  const reason = updates.reason ?? row.reason;
  const active = updates.active ?? row.active;
  const metadata = updates.metadata ? { ...JSON.parse(row.metadata_json), ...updates.metadata } : JSON.parse(row.metadata_json);
  db.prepare("UPDATE cases SET reason = ?, active = ?, metadata_json = ? WHERE guild_id = ? AND id = ?")
    .run(reason, active, JSON.stringify(metadata), guildId, id);
  return getCase(guildId, id);
}

export function activeExpirations() {
  return db.prepare("SELECT * FROM cases WHERE active = 1 AND expires_at IS NOT NULL").all();
}

export function createTicket({ guildId, channelId, openerId, categoryKey }) {
  const result = db.prepare(`
    INSERT INTO tickets (guild_id, channel_id, opener_id, category_key) VALUES (?, ?, ?, ?)
  `).run(guildId, channelId, openerId, categoryKey);
  return db.prepare("SELECT * FROM tickets WHERE id = ?").get(Number(result.lastInsertRowid));
}

export function getTicketByChannel(channelId) {
  return db.prepare("SELECT * FROM tickets WHERE channel_id = ?").get(channelId);
}

export function getOpenTicketsByUser(guildId, openerId) {
  return db.prepare("SELECT * FROM tickets WHERE guild_id = ? AND opener_id = ? AND status IN ('open','pending') ORDER BY id DESC").all(guildId, openerId);
}

export function listOpenTickets(guildId) {
  return db.prepare("SELECT * FROM tickets WHERE guild_id = ? AND status IN ('open','pending') ORDER BY created_at DESC").all(guildId);
}

export function updateTicket(channelId, fields) {
  const ticket = getTicketByChannel(channelId);
  if (!ticket) return null;
  db.prepare(`
    UPDATE tickets SET assigned_to = ?, status = ?, closed_at = ?, close_reason = ?, priority = ?
    WHERE channel_id = ?
  `).run(
    fields.assignedTo === undefined ? ticket.assigned_to : fields.assignedTo,
    fields.status ?? ticket.status,
    fields.closedAt === undefined ? ticket.closed_at : fields.closedAt,
    fields.closeReason === undefined ? ticket.close_reason : fields.closeReason,
    fields.priority ?? ticket.priority,
    channelId,
  );
  return getTicketByChannel(channelId);
}

export function addTicketEvent(ticketId, actorId, eventType, details = "") {
  db.prepare("INSERT INTO ticket_events (ticket_id, actor_id, event_type, details) VALUES (?, ?, ?, ?)")
    .run(ticketId, actorId, eventType, details);
}

export function recordCampaign({ guildId, actorId, kind, sent, failed }) {
  db.prepare("INSERT INTO campaign_runs (guild_id, actor_id, kind, sent, failed) VALUES (?, ?, ?, ?, ?)")
    .run(guildId, actorId, kind, sent, failed);
}

export function closeDatabase() {
  if (db.isOpen) db.close();
}
