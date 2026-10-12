import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { createHash } from "node:crypto";
import { createCase, getSetting } from "./database.js";
import { isAdmin } from "./auth.js";

const invitePattern = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([a-z0-9-]+)/gi;
const recentMessages = new Map();
const joinWindows = new Map();
const lastInviteStrike = new Map();

export function containsInvite(text) {
  return [...String(text).matchAll(invitePattern)].map((match) => match[1].toLowerCase());
}

export function getSpamSignals(messages, content, mentionCount, threshold = 5) {
  const now = Date.now();
  const recent = messages.filter((entry) => now - (typeof entry === "number" ? entry : entry.time) < 8000);
  const normalized = content.trim().toLowerCase().replace(/\s+/g, " ");
  const hash = createHash("sha256").update(normalized).digest("hex");
  return {
    messageBurst: recent.length + 1 >= threshold,
    repeated: Boolean(normalized && content.length > 3 && recent.some((entry) => entry.hash === hash)),
    mentionFlood: mentionCount >= 6,
  };
}

function isExempt(message, settings) {
  if (isAdmin(message.member)) return true;
  if (settings.exemptChannels?.includes(message.channelId)) return true;
  return message.member?.roles?.cache?.some((role) => settings.exemptRoles?.includes(role.id)) ?? false;
}

async function alertModerators(guild, channelId, text, color = 0xf97316) {
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  await channel.send({
    embeds: [new EmbedBuilder().setColor(color).setDescription(text).setTimestamp()],
    allowedMentions: { parse: [] },
  }).catch((error) => console.error("[security] Não foi possível enviar alerta:", error.message));
}

async function processInvite(message) {
  const settings = getSetting(message.guildId, "antiinvite", {});
  if (!settings.enabled || isExempt(message, settings)) return false;
  const invites = containsInvite(message.content);
  if (!invites.length) return false;
  const allowed = new Set((settings.allowedCodes ?? []).map((code) => String(code).toLowerCase()));
  const blocked = invites.filter((code) => !allowed.has(code));
  if (!blocked.length) return false;

  const incidentId = `${message.guildId}:${message.author.id}`;
  const now = Date.now();
  const priorStrike = lastInviteStrike.get(incidentId);
  const strikes = priorStrike && now - priorStrike.time < 15 * 60_000 ? priorStrike.count + 1 : 1;
  lastInviteStrike.set(incidentId, { count: strikes, time: now });
  let removed = false;
  if (settings.deleteMessages !== false && message.deletable) {
    await message.delete().then(() => { removed = true; }).catch(() => {});
  }
  const reason = `Convite não autorizado: ${blocked.join(", ")}`;
  const caseRow = createCase({
    guildId: message.guildId, kind: "antiinvite", targetId: message.author.id,
    moderatorId: message.client.user.id, reason, metadata: { channelId: message.channelId, removed },
  });
  if (settings.warnMembers !== false) {
    await message.author.send(`Sua mensagem com convite não autorizado foi removida em **${message.guild.name}**. ID do registro: ${caseRow.id}.`).catch(() => {});
  }
  const repeatAt = Math.max(2, Number(settings.timeoutAfter ?? 3));
  if (strikes >= repeatAt && settings.timeoutOnRepeat !== false && message.member?.moderatable) {
    await message.member.timeout(5 * 60 * 1000, "Reincidência de convites não autorizados").catch(() => {});
  }
  await alertModerators(message.guild, settings.logChannelId, `Convite detectado de ${message.author} em ${message.channel}. Mensagem removida: **${removed ? "sim" : "não"}**. Caso #${caseRow.id}.`);
  return true;
}

async function processSpam(message) {
  const settings = getSetting(message.guildId, "antispam", {});
  if (!settings.enabled || isExempt(message, settings) || !message.member?.moderatable) return;

  const key = `${message.guildId}:${message.author.id}`;
  const now = Date.now();
  const entries = (recentMessages.get(key) ?? []).filter((entry) => now - entry.time < 10000);
  const signals = getSpamSignals(entries, message.content, message.mentions.users.size, Number(settings.messagesPerWindow ?? 6));
  entries.push({ time: now, hash: createHash("sha256").update(message.content.trim().toLowerCase().replace(/\s+/g, " ")).digest("hex") });
  recentMessages.set(key, entries);

  const inviteDetected = containsInvite(message.content).length > 0;
  const shouldAct = signals.messageBurst || signals.repeated || signals.mentionFlood || (inviteDetected && settings.blockInvites);
  if (!shouldAct) return;

  const reasons = [
    signals.messageBurst && "envio acelerado",
    signals.repeated && "conteúdo repetido",
    signals.mentionFlood && "excesso de menções",
    inviteDetected && settings.blockInvites && "convite no spam",
  ].filter(Boolean);
  let removed = false;
  if (settings.deleteMessages !== false && message.deletable) {
    await message.delete().then(() => { removed = true; }).catch(() => {});
  }
  const timeoutMs = Math.max(1, Math.min(Number(settings.timeoutMinutes ?? 3), 60)) * 60 * 1000;
  let timedOut = false;
  if (settings.timeoutOnSpam && message.member.moderatable) {
    await message.member.timeout(timeoutMs, `Anti-spam: ${reasons.join(", ")}`).then(() => { timedOut = true; }).catch(() => {});
  }
  const row = createCase({
    guildId: message.guildId, kind: "antispam", targetId: message.author.id,
    moderatorId: message.client.user.id, reason: reasons.join(", "),
    metadata: { channelId: message.channelId, removed, timedOut },
  });
  if (settings.warnMembers !== false) {
    await message.author.send(`Detectamos spam em **${message.guild.name}**. Ação: ${removed ? "mensagem removida" : "mensagem mantida"}${timedOut ? " e timeout" : ""}. Caso #${row.id}.`).catch(() => {});
  }
  await alertModerators(message.guild, settings.logChannelId, `Anti-spam detectou ${message.author} em ${message.channel}: ${reasons.join(", ")}. Mensagem removida: **${removed ? "sim" : "não"}**. Caso #${row.id}.`);
}

export async function handleMessage(message) {
  if (!message.guild || message.author.bot || !message.client.options.intents.has(GatewayIntentBits.MessageContent) || !message.content) return;
  try {
    const inviteHandled = await processInvite(message);
    if (!inviteHandled) await processSpam(message);
  } catch (error) {
    console.error("[security] Falha ao processar mensagem:", error);
  }
}

export async function handleGuildMemberAdd(member) {
  try {
    const settings = getSetting(member.guild.id, "antiraid", {});
    if (!settings.enabled) return;
    const now = Date.now();
    const windowMs = Math.max(5, Number(settings.windowSeconds ?? 30)) * 1000;
    const entries = (joinWindows.get(member.guild.id) ?? []).filter((entry) => now - entry.time < windowMs);
    entries.push({ time: now, memberId: member.id });
    joinWindows.set(member.guild.id, entries);
    const accountAgeDays = (now - member.user.createdTimestamp) / 86_400_000;
    const burstThreshold = Math.max(2, Number(settings.joinsThreshold ?? 8));
    const isBurst = entries.length >= burstThreshold;
    const isNewAccount = accountAgeDays < Number(settings.newAccountDays ?? 7);
    if (!isBurst && !(isNewAccount && settings.alertNewAccounts)) return;

    const reason = isBurst
      ? `${entries.length} entradas em ${settings.windowSeconds ?? 30}s`
      : `Conta criada há ${Math.max(0, Math.floor(accountAgeDays))} dia(s)`;
    const row = createCase({
      guildId: member.guild.id, kind: "antiraid", targetId: member.id, moderatorId: member.client.user.id,
      reason, metadata: { accountAgeDays: Number(accountAgeDays.toFixed(2)), burst: isBurst },
    });
    let verificationApplied = false;
    if (isBurst && settings.enableVerificationRole && settings.verificationRoleId) {
      const role = member.guild.roles.cache.get(settings.verificationRoleId);
      if (role && member.guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)
        && role.position < member.guild.members.me.roles.highest.position) {
        verificationApplied = await member.roles.add(role, "Verificação temporária anti-raid").then(() => true).catch(() => false);
        if (verificationApplied) {
          const minutes = Math.max(1, Math.min(1440, Number(settings.verificationMinutes ?? 10)));
          const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();
          createCase({
            guildId: member.guild.id, kind: "antiraid-verification", targetId: member.id,
            moderatorId: member.client.user.id, reason: `Remoção automática do cargo de verificação após ${minutes} min.`,
            expiresAt, metadata: { roleId: role.id },
          });
        }
      }
    }
    await alertModerators(member.guild, settings.logChannelId, `Sinal anti-raid: ${member} — ${reason}.${verificationApplied ? " Cargo de verificação temporário aplicado." : " Nenhuma punição automática aplicada."} Caso #${row.id}.`);
  } catch (error) {
    console.error("[security] Falha ao processar entrada:", error);
  }
}

export function clearSecurityState() {
  recentMessages.clear();
  joinWindows.clear();
  lastInviteStrike.clear();
}

export function pruneSecurityState(now = Date.now()) {
  for (const [key, entries] of recentMessages) {
    const recent = entries.filter((entry) => now - entry.time < 60_000);
    if (recent.length) recentMessages.set(key, recent);
    else recentMessages.delete(key);
  }
  for (const [guildId, entries] of joinWindows) {
    const recent = entries.filter((entry) => now - entry.time < 10 * 60_000);
    if (recent.length) joinWindows.set(guildId, recent);
    else joinWindows.delete(guildId);
  }
  for (const [key, entry] of lastInviteStrike) if (now - entry.time > 15 * 60_000) lastInviteStrike.delete(key);
}
