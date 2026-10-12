import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "discord-bot-test-"));
process.env.BOT_DATABASE_PATH = join(dataDir, "state.sqlite");

const { commandDefinitions } = await import("../src/commands.js");
const { getSpamSignals, containsInvite } = await import("../src/security.js");
const { canModerateTarget, isAdmin } = await import("../src/auth.js");
const database = await import("../src/database.js");

after(() => {
  database.closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

test("slash commands serialize with unique names and core project commands", () => {
  const names = commandDefinitions.map((command) => command.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of ["antiraid", "antispam", "antiinvite", "ticketpainel", "ticket", "logs", "ban", "timeout", "enviardm", "dmoptin", "mensagem"]) {
    assert.ok(names.includes(name), `missing slash command: ${name}`);
  }
  for (const command of commandDefinitions) {
    assert.ok(command.description.length >= 1 && command.description.length <= 100);
    assert.ok((command.options ?? []).length <= 25);
    const assertRequiredFirst = (options, path) => {
      let sawOptional = false;
      for (const option of options ?? []) {
        if (option.type === 1 || option.type === 2) {
          assertRequiredFirst(option.options, `${path}/${option.name}`);
        } else if (option.required) {
          assert.equal(sawOptional, false, `${path}/${option.name} is required after an optional option`);
        } else {
          sawOptional = true;
        }
      }
    };
    assertRequiredFirst(command.options, command.name);
  }
});

test("server settings, moderation cases and ticket history persist in SQLite", () => {
  database.setSetting("guild-a", "antiraid", { enabled: true, joinsThreshold: 9 });
  database.setSetting("guild-b", "antiraid", { enabled: false });
  database.setSetting("guild-a", "dm-opt-ins", ["member-a", "member-b"]);
  assert.deepEqual(database.getSetting("guild-a", "antiraid"), { enabled: true, joinsThreshold: 9 });
  assert.deepEqual(database.getSetting("guild-b", "antiraid"), { enabled: false });
  assert.deepEqual(database.getSetting("guild-a", "dm-opt-ins"), ["member-a", "member-b"]);

  const row = database.createCase({
    guildId: "guild-a", kind: "warn", targetId: "user-1", moderatorId: "staff-1", reason: "teste",
  });
  assert.equal(database.getCase("guild-a", row.id).reason, "teste");
  assert.equal(database.updateCase("guild-a", row.id, { active: 0 }).active, 0);

  const ticket = database.createTicket({ guildId: "guild-a", channelId: "channel-1", openerId: "user-1", categoryKey: "suporte" });
  database.addTicketEvent(ticket.id, "staff-1", "claimed");
  assert.equal(database.getTicketByChannel("channel-1").opener_id, "user-1");
  assert.equal(database.getOpenTicketsByUser("guild-a", "user-1").length, 1);
});

test("spam detection flags bursts, repeats and mention floods without flagging calm messages", () => {
  const now = Date.now();
  const quietHistory = [{ time: now - 12_000, hash: "old" }];
  const quiet = getSpamSignals(quietHistory, "uma mensagem nova", 0, 5);
  assert.equal(quiet.messageBurst, false);
  assert.equal(quiet.repeated, false);
  assert.equal(quiet.mentionFlood, false);

  const burst = getSpamSignals(Array.from({ length: 4 }, (_, index) => ({ time: now - index * 100, hash: `hash-${index}` })), "conteúdo novo", 0, 5);
  assert.equal(burst.messageBurst, true);
  const repeat = getSpamSignals([{ time: now - 100, hash: createHash("sha256").update("repetido").digest("hex") }], "Repetido", 0, 6);
  assert.equal(repeat.repeated, true);
  assert.equal(getSpamSignals([], "mensagem", 6).mentionFlood, true);
});

test("Discord invite parsing extracts only invite codes", () => {
  assert.deepEqual(containsInvite("Entre: https://discord.gg/Servidor-123"), ["servidor-123"]);
  assert.deepEqual(containsInvite("Nenhum convite aqui"), []);
});

test("moderation refuses owners and equal-or-higher roles but allows a lower target", () => {
  const role = (position) => ({
    highest: {
      position,
      comparePositionTo: (other) => position - other.position,
    },
  });
  const executor = { id: "mod", roles: role(5) };
  const bot = { id: "bot", roles: role(10) };
  const lowerTarget = { id: "member", roles: role(2) };
  const peerTarget = { id: "peer", roles: role(5) };
  assert.equal(canModerateTarget(executor, lowerTarget, bot, "owner").allowed, true);
  assert.equal(canModerateTarget(executor, peerTarget, bot, "owner").allowed, false);
  assert.equal(canModerateTarget(executor, { id: "owner", roles: role(0) }, bot, "owner").allowed, false);
  assert.equal(isAdmin({ permissions: 8n }), true);
  assert.equal(isAdmin({ permissions: 0n }), false);
});
