import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import {
  createCase, db, getCase, getSetting, listCases, setSetting, updateCase,
} from "./database.js";
import { canModerateTarget, isAdmin } from "./auth.js";

const COLORS = { success: 0x22c55e, warning: 0xf59e0b, error: 0xef4444, info: 0x3b82f6 };
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

export function makeEmbed(title, description, color = COLORS.info) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp();
}

export async function audit(guild, category, text, details = {}) {
  const config = getSetting(guild.id, "logs", {});
  if (!config.channelId || config.categories?.[category] === false) return;
  const channel = await guild.channels.fetch(config.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const embed = makeEmbed(`Registro · ${category}`, text, category === "moderação" ? COLORS.warning : COLORS.info);
  const fields = Object.entries(details).filter(([, value]) => value !== undefined && value !== null && value !== "")
    .slice(0, 10).map(([name, value]) => ({ name: name.slice(0, 256), value: String(value).slice(0, 1024), inline: true }));
  if (fields.length) embed.addFields(fields);
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((error) => {
    console.error("[logs] Falha ao publicar log:", error.message);
  });
}

function permissionName(permission) {
  const names = {
    [PermissionFlagsBits.BanMembers]: "Banir membros",
    [PermissionFlagsBits.KickMembers]: "Expulsar membros",
    [PermissionFlagsBits.ModerateMembers]: "Moderar membros",
    [PermissionFlagsBits.ManageMessages]: "Gerenciar mensagens",
    [PermissionFlagsBits.ManageChannels]: "Gerenciar canais",
    [PermissionFlagsBits.ManageRoles]: "Gerenciar cargos",
    [PermissionFlagsBits.ManageNicknames]: "Gerenciar apelidos",
    [PermissionFlagsBits.ManageGuild]: "Gerenciar servidor",
  };
  return names[permission] ?? "executar este comando";
}

function requirePermission(interaction, permission) {
  const permissions = interaction.memberPermissions;
  return permissions?.has(PermissionFlagsBits.Administrator) || permissions?.has(permission);
}

export async function requireCommandPermission(interaction, permission) {
  if (requirePermission(interaction, permission)) return true;
  await interaction.reply({
    embeds: [makeEmbed("Permissão necessária", `Você precisa de **${permissionName(permission)}** para usar este comando.`, COLORS.error)],
    ephemeral: true,
  });
  return false;
}

function getTargetMember(interaction, option = "membro") {
  return interaction.options.getMember(option);
}

async function targetCheck(interaction, target) {
  const bot = interaction.guild.members.me;
  const executor = interaction.guild.members.cache.get(interaction.user.id)
    ?? await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const result = canModerateTarget(executor, target, bot, interaction.guild.ownerId);
  if (result.allowed) return result;
  return result;
}

function safeReason(value, actor) {
  const reason = String(value ?? "").trim();
  return (reason || `Ação solicitada por ${actor.tag}`).slice(0, 500);
}

async function recordModeration(interaction, kind, targetId, reason, extra = {}) {
  const row = createCase({
    guildId: interaction.guildId, kind, targetId, moderatorId: interaction.user.id, reason,
    expiresAt: extra.expiresAt ?? null, metadata: extra.metadata ?? {},
  });
  await audit(interaction.guild, "moderação", `**${kind}** aplicado por ${interaction.user}. Caso **#${row.id}**.`, {
    Alvo: `<@${targetId}>`, Motivo: reason, Duração: extra.expiresAt ? `<t:${Math.floor(new Date(extra.expiresAt).getTime() / 1000)}:R>` : undefined,
  });
  return row;
}

async function punishMember(interaction, kind, permission, action) {
  if (!(await requireCommandPermission(interaction, permission))) return;
  const target = getTargetMember(interaction);
  if (!target) {
    await interaction.reply({ content: "Não consegui localizar esse membro no servidor.", ephemeral: true });
    return;
  }
  const check = await targetCheck(interaction, target);
  if (!check.allowed) {
    await interaction.reply({ content: check.reason, ephemeral: true });
    return;
  }
  const reason = safeReason(interaction.options.getString("motivo"), interaction.user);
  const details = await action(target, reason);
  const row = await recordModeration(interaction, kind, target.id, reason, details ?? {});
  await interaction.reply({ embeds: [makeEmbed("Ação concluída", `${kind} aplicado a ${target.user.tag}. Caso **#${row.id}**.`, COLORS.success)], ephemeral: true });
}

function formatCase(row) {
  if (!row) return "Caso não encontrado.";
  return `**Caso #${row.id} · ${row.kind}**\nAlvo: <@${row.target_id}> · Responsável: <@${row.moderator_id}>\nMotivo: ${row.reason}\nData: <t:${Math.floor(new Date(`${row.created_at}Z`).getTime() / 1000)}:F>${row.expires_at ? `\nExpira: <t:${Math.floor(new Date(row.expires_at).getTime() / 1000)}:R>` : ""}\nEstado: ${row.active ? "ativo" : "inativo"}`;
}

export async function executeModeration(interaction) {
  const name = interaction.commandName;
  if (name === "ban") {
    return punishMember(interaction, "ban", PermissionFlagsBits.BanMembers, async (member, reason) => {
      if (!member.bannable) throw new Error("O bot não tem permissão para banir esse membro.");
      await member.ban({ reason });
    });
  }
  if (name === "kick") {
    return punishMember(interaction, "kick", PermissionFlagsBits.KickMembers, async (member, reason) => {
      if (!member.kickable) throw new Error("O bot não tem permissão para expulsar esse membro.");
      await member.kick(reason);
    });
  }
  if (["timeout", "mute", "tempmute"].includes(name)) {
    if (!(await requireCommandPermission(interaction, PermissionFlagsBits.ModerateMembers))) return;
    const target = getTargetMember(interaction);
    if (!target) return interaction.reply({ content: "Membro não encontrado.", ephemeral: true });
    const check = await targetCheck(interaction, target);
    if (!check.allowed) return interaction.reply({ content: check.reason, ephemeral: true });
    const minutes = interaction.options.getInteger("minutos") ?? (name === "tempmute" ? 60 : 10);
    const durationMs = Math.min(Math.max(minutes, 1), Math.floor(MAX_TIMEOUT_MS / 60000)) * 60000;
    const reason = safeReason(interaction.options.getString("motivo"), interaction.user);
    await target.timeout(durationMs, reason);
    const expiresAt = new Date(Date.now() + durationMs).toISOString();
    const row = await recordModeration(interaction, name, target.id, reason, { expiresAt });
    return interaction.reply({ content: `Timeout aplicado a ${target.user.tag} por ${minutes} minuto(s). Caso #${row.id}.`, ephemeral: true });
  }
  if (name === "untimeout") {
    return punishMember(interaction, name, PermissionFlagsBits.ModerateMembers, async (member, reason) => {
      if (!member.moderatable) throw new Error("O bot não consegue remover o timeout desse membro.");
      await member.timeout(null, reason);
    });
  }
  if (name === "tempban") {
    return punishMember(interaction, name, PermissionFlagsBits.BanMembers, async (member, reason) => {
      if (!member.bannable) throw new Error("O bot não tem permissão para banir esse membro.");
      const days = Math.max(1, Math.min(30, interaction.options.getInteger("dias") ?? 1));
      const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
      await member.ban({ reason });
      return { expiresAt };
    });
  }
  if (name === "softban") {
    return punishMember(interaction, name, PermissionFlagsBits.BanMembers, async (member, reason) => {
      const userId = member.id;
      await member.ban({ reason, deleteMessageSeconds: 7 * 24 * 60 * 60 });
      await interaction.guild.members.unban(userId, `Softban concluído: ${reason}`);
    });
  }
  if (name === "warn") {
    if (!(await requireCommandPermission(interaction, PermissionFlagsBits.ModerateMembers))) return;
    const target = getTargetMember(interaction);
    if (!target) return interaction.reply({ content: "Membro não encontrado.", ephemeral: true });
    const check = await targetCheck(interaction, target);
    if (!check.allowed) return interaction.reply({ content: check.reason, ephemeral: true });
    const user = target.user;
    const reason = safeReason(interaction.options.getString("motivo"), interaction.user);
    const row = await recordModeration(interaction, "warn", user.id, reason);
    await user.send(`Você recebeu uma advertência em **${interaction.guild.name}**. Motivo: ${reason}. Caso #${row.id}.`).catch(() => {});
    return interaction.reply({ content: `Advertência registrada para ${user.tag}. Caso #${row.id}.`, ephemeral: true });
  }
  if (name === "unban") {
    if (!(await requireCommandPermission(interaction, PermissionFlagsBits.BanMembers))) return;
    const userId = interaction.options.getString("id", true);
    if (!/^\d{17,20}$/.test(userId)) return interaction.reply({ content: "Informe um ID de usuário Discord válido.", ephemeral: true });
    await interaction.guild.members.unban(userId, safeReason(interaction.options.getString("motivo"), interaction.user));
    const row = await recordModeration(interaction, name, userId, safeReason(interaction.options.getString("motivo"), interaction.user));
    return interaction.reply({ content: `Banimento removido. Caso #${row.id}.`, ephemeral: true });
  }
  if (name === "warnings" || name === "history") {
    const user = interaction.options.getUser("membro", true);
    const rows = listCases(interaction.guildId, user.id, 15);
    const filtered = name === "warnings" ? rows.filter((row) => row.kind === "warn") : rows;
    const description = filtered.length ? filtered.map((row) => `**#${row.id}** ${row.kind} · <t:${Math.floor(new Date(`${row.created_at}Z`).getTime() / 1000)}:d> · ${row.reason.slice(0, 100)}${row.active ? "" : " · inativo"}`).join("\n") : "Nenhum registro encontrado.";
    return interaction.reply({ embeds: [makeEmbed(`Histórico de ${user.tag}`, description)], ephemeral: true });
  }
  if (name === "clearwarns") {
    if (!(await requireCommandPermission(interaction, PermissionFlagsBits.ManageGuild))) return;
    const user = interaction.options.getUser("membro", true);
    const result = db.prepare("UPDATE cases SET active = 0 WHERE guild_id = ? AND target_id = ? AND kind = 'warn' AND active = 1")
      .run(interaction.guildId, user.id);
    await audit(interaction.guild, "moderação", `Advertências de ${user} limpas por ${interaction.user}.`, { Quantidade: result.changes });
    return interaction.reply({ content: `${result.changes} advertência(s) marcada(s) como inativa(s).`, ephemeral: true });
  }
  if (name === "unwarn" || name === "reason") {
    if (!(await requireCommandPermission(interaction, PermissionFlagsBits.ManageGuild))) return;
    const id = interaction.options.getInteger("caso", true);
    const row = getCase(interaction.guildId, id);
    if (!row) return interaction.reply({ content: "Caso não encontrado neste servidor.", ephemeral: true });
    if (name === "unwarn" && row.kind !== "warn") return interaction.reply({ content: "Esse caso não é uma advertência.", ephemeral: true });
    const previous = row.reason;
    const updated = name === "unwarn"
      ? updateCase(interaction.guildId, id, { active: 0 })
      : updateCase(interaction.guildId, id, { reason: interaction.options.getString("motivo", true), metadata: { previousReason: previous, changedBy: interaction.user.id, changedAt: new Date().toISOString() } });
    await audit(interaction.guild, "moderação", `Caso #${id} atualizado por ${interaction.user}.`, { "Motivo anterior": name === "reason" ? previous : undefined, "Novo motivo": name === "reason" ? updated.reason : undefined });
    return interaction.reply({ content: `Caso #${id} atualizado.`, ephemeral: true });
  }
  if (name === "case") {
    const row = getCase(interaction.guildId, interaction.options.getInteger("id", true));
    return interaction.reply({ embeds: [makeEmbed("Detalhes do caso", formatCase(row))], ephemeral: true });
  }
  if (name === "modstats") {
    if (!(await requireCommandPermission(interaction, PermissionFlagsBits.ModerateMembers))) return;
    const byKind = db.prepare("SELECT kind, COUNT(*) AS count FROM cases WHERE guild_id = ? AND active = 1 GROUP BY kind").all(interaction.guildId);
    const total = byKind.reduce((sum, row) => sum + row.count, 0);
    const description = byKind.length ? byKind.map((row) => `**${row.kind}:** ${row.count}`).join("\n") : "Nenhuma ação registrada ainda.";
    return interaction.reply({ embeds: [makeEmbed(`Estatísticas de moderação · ${total} ações`, description)], ephemeral: true });
  }
  if (name === "purge") {
    if (!(await requireCommandPermission(interaction, PermissionFlagsBits.ManageMessages))) return;
    const amount = interaction.options.getInteger("quantidade", true);
    if (amount < 1 || amount > 100) return interaction.reply({ content: "A quantidade precisa estar entre 1 e 100.", ephemeral: true });
    const deleted = await interaction.channel.bulkDelete(amount, true);
    await recordModeration(interaction, name, interaction.user.id, `Exclusão de ${deleted.size} mensagens`, { metadata: { channelId: interaction.channelId, count: deleted.size } });
    return interaction.reply({ content: `${deleted.size} mensagem(ns) removida(s).`, ephemeral: true });
  }
  if (name === "slowmode") {
    if (!(await requireCommandPermission(interaction, PermissionFlagsBits.ManageChannels))) return;
    const seconds = interaction.options.getInteger("segundos", true);
    if (seconds < 0 || seconds > 21600) return interaction.reply({ content: "Use um valor entre 0 e 21.600 segundos.", ephemeral: true });
    await interaction.channel.setRateLimitPerUser(seconds, `Alterado por ${interaction.user.tag}`);
    await recordModeration(interaction, name, interaction.channelId, `Slowmode definido para ${seconds}s`);
    return interaction.reply({ content: `Slowmode definido para ${seconds} segundo(s).`, ephemeral: true });
  }
  if (name === "lock" || name === "unlock") {
    if (!(await requireCommandPermission(interaction, PermissionFlagsBits.ManageChannels))) return;
    const locked = name === "lock";
    await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: locked }, { reason: `Canal ${locked ? "bloqueado" : "desbloqueado"} por ${interaction.user.tag}` });
    await recordModeration(interaction, name, interaction.channelId, `Canal ${locked ? "bloqueado" : "desbloqueado"}`);
    return interaction.reply({ content: `Canal ${locked ? "bloqueado" : "desbloqueado"}.`, ephemeral: true });
  }
  if (name === "lockdown") {
    if (!(await requireCommandPermission(interaction, PermissionFlagsBits.ManageChannels))) return;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("lockdown:confirm").setLabel("Confirmar bloqueio").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("lockdown:cancel").setLabel("Cancelar").setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({ content: "Isso bloqueia o envio de mensagens para @everyone nos canais de texto e fórum acessíveis ao bot. Confirme para continuar.", components: [row], ephemeral: true });
  }
  if (name === "unlockdown") {
    if (!(await requireCommandPermission(interaction, PermissionFlagsBits.ManageChannels))) return;
    return restoreLockdown(interaction, true);
  }
  if (name === "nick") {
    if (!(await requireCommandPermission(interaction, PermissionFlagsBits.ManageNicknames))) return;
    const target = getTargetMember(interaction);
    if (!target) return interaction.reply({ content: "Membro não encontrado.", ephemeral: true });
    const check = await targetCheck(interaction, target);
    if (!check.allowed) return interaction.reply({ content: check.reason, ephemeral: true });
    const nick = interaction.options.getString("apelido");
    if (nick && (nick.length > 32 || /[\u0000-\u001f]/.test(nick))) return interaction.reply({ content: "O apelido deve ter até 32 caracteres válidos.", ephemeral: true });
    const oldNick = target.nickname ?? target.user.username;
    await target.setNickname(nick, `Alterado por ${interaction.user.tag}`);
    await recordModeration(interaction, name, target.id, `Apelido: ${oldNick} → ${nick ?? target.user.username}`);
    return interaction.reply({ content: "Apelido atualizado.", ephemeral: true });
  }
  if (name === "role") return handleRole(interaction);
  if (name === "userinfo") {
    const user = interaction.options.getUser("membro") ?? interaction.user;
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    const roles = member?.roles.cache.filter((role) => role.id !== interaction.guildId).map((role) => role.toString()).slice(0, 12).join(" ") || "Nenhum";
    const embed = makeEmbed(`Informações · ${user.tag}`, [
      `ID: \`${user.id}\``, `Conta criada: <t:${Math.floor(user.createdTimestamp / 1000)}:F>`,
      member ? `Entrou no servidor: <t:${Math.floor(member.joinedTimestamp / 1000)}:F>` : "Não está no servidor.",
      `Cargos: ${roles}`,
    ].join("\n"));
    embed.setThumbnail(user.displayAvatarURL({ size: 256 }));
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
  if (name === "serverinfo") {
    const guild = interaction.guild;
    const embed = makeEmbed(`Servidor · ${guild.name}`, [
      `ID: \`${guild.id}\``, `Membros: ${guild.memberCount}`, `Criado: <t:${Math.floor(guild.createdTimestamp / 1000)}:F>`,
      `Canais: ${guild.channels.cache.size}`, `Cargos: ${guild.roles.cache.size}`,
    ].join("\n"));
    if (guild.iconURL()) embed.setThumbnail(guild.iconURL({ size: 256 }));
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
  if (name === "avatar") {
    const user = interaction.options.getUser("membro") ?? interaction.user;
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle(`Avatar · ${user.tag}`).setImage(user.displayAvatarURL({ size: 1024 }))], ephemeral: true });
  }
  if (name === "membercount") return interaction.reply({ content: `Este servidor tem **${interaction.guild.memberCount}** membros.`, ephemeral: true });
  return false;
}

async function handleRole(interaction) {
  const action = interaction.options.getSubcommand();
  const role = interaction.options.getRole("cargo", true);
  if (action === "info") {
    return interaction.reply({ content: `**${role.name}** · ID \`${role.id}\` · ${role.members.size} membro(s) · posição ${role.position} · ${role.mentionable ? "mencionável" : "não mencionável"}.`, ephemeral: true });
  }
  if (!(await requireCommandPermission(interaction, PermissionFlagsBits.ManageRoles))) return;
  if (role.managed || role.position >= interaction.guild.members.me.roles.highest.position) return interaction.reply({ content: "O bot não pode gerenciar este cargo pela integração ou hierarquia.", ephemeral: true });
  const target = getTargetMember(interaction);
  if (!target) return interaction.reply({ content: "Membro não encontrado.", ephemeral: true });
  const check = await targetCheck(interaction, target);
  if (!check.allowed) return interaction.reply({ content: check.reason, ephemeral: true });
  const executor = await getMember(interaction.guild, interaction.user.id);
  if (interaction.user.id !== interaction.guild.ownerId && executor && role.position >= executor.roles.highest.position) {
    return interaction.reply({ content: "Seu cargo precisa estar acima do cargo escolhido.", ephemeral: true });
  }
  if (action === "add") await target.roles.add(role, `Concedido por ${interaction.user.tag}`);
  else await target.roles.remove(role, `Removido por ${interaction.user.tag}`);
  await recordModeration(interaction, `role-${action}`, target.id, `Cargo ${role.name} ${action === "add" ? "adicionado" : "removido"}`);
  return interaction.reply({ content: `Cargo **${role.name}** ${action === "add" ? "adicionado a" : "removido de"} ${target.user.tag}.`, ephemeral: true });
}

export async function handleLockdownButton(interaction) {
  if (!(interaction.customId === "lockdown:confirm" || interaction.customId === "lockdown:cancel")) return false;
  if (!isAdmin(interaction.memberPermissions) && !interaction.memberPermissions.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({ content: "Você não tem permissão para esta ação.", ephemeral: true });
    return true;
  }
  if (interaction.customId.endsWith(":cancel")) {
    await interaction.update({ content: "Bloqueio cancelado.", components: [] });
    return true;
  }
  await interaction.deferUpdate();
  const settings = getSetting(interaction.guildId, "lockdown", {});
  const originals = settings.originals ?? {};
  const textChannels = interaction.guild.channels.cache.filter((channel) => channel.isTextBased() && "permissionOverwrites" in channel);
  const ids = [];
  for (const channel of textChannels.values()) {
    const current = channel.permissionOverwrites.resolve(interaction.guildId);
    const original = current?.allow.has(PermissionsBitField.Flags.SendMessages)
      ? true : current?.deny.has(PermissionsBitField.Flags.SendMessages) ? false : null;
    originals[channel.id] = original;
    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false }, { reason: `Lockdown confirmado por ${interaction.user.tag}` }).then(() => ids.push(channel.id)).catch(() => {});
  }
  setSetting(interaction.guildId, "lockdown", { active: true, originals });
  const logCase = await recordModeration(interaction, "lockdown", interaction.guildId, `Bloqueio de emergência: ${ids.length} canais.`);
  await interaction.editReply({ content: `Bloqueio aplicado em ${ids.length} canal(is). Caso #${logCase.id}.`, components: [] });
  return true;
}

export async function restoreLockdown(interaction, reply = false) {
  const config = getSetting(interaction.guildId, "lockdown", {});
  if (!config.active) {
    if (reply) await interaction.reply({ content: "Não há um bloqueio de emergência ativo.", ephemeral: true });
    return true;
  }
  let restored = 0;
  for (const [channelId, sendMessages] of Object.entries(config.originals ?? {})) {
    const channel = interaction.guild.channels.cache.get(channelId);
    if (!channel?.permissionOverwrites) continue;
    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: sendMessages }, { reason: `Lockdown encerrado por ${interaction.user.tag}` })
      .then(() => { restored += 1; }).catch(() => {});
  }
  setSetting(interaction.guildId, "lockdown", { active: false, originals: {} });
  const row = await recordModeration(interaction, "unlockdown", interaction.guildId, `Bloqueio encerrado; ${restored} canais restaurados.`);
  if (reply) await interaction.reply({ content: `Bloqueio encerrado. ${restored} canal(is) restaurado(s). Caso #${row.id}.`, ephemeral: true });
  return true;
}

export function restoreTemporaryActions(client) {
  for (const row of db.prepare("SELECT * FROM cases WHERE active = 1 AND expires_at IS NOT NULL AND kind IN ('tempban','tempmute','timeout','mute','antiraid-verification')").all()) {
    const finish = async () => {
      const remaining = Date.parse(row.expires_at) - Date.now();
      if (remaining > 0) {
        const timer = setTimeout(finish, Math.min(remaining, 2_147_000_000));
        timer.unref?.();
        return;
      }
      const guild = client.guilds.cache.get(row.guild_id);
      if (!guild) return;
      try {
        if (row.kind === "antiraid-verification") {
          const member = await guild.members.fetch(row.target_id).catch(() => null);
          const roleId = JSON.parse(row.metadata_json).roleId;
          if (member && roleId && member.roles.cache.has(roleId)) await member.roles.remove(roleId, "Fim da verificação temporária anti-raid");
        } else if (row.kind === "tempban") {
          const bans = await guild.bans.fetch();
          if (bans.has(row.target_id)) await guild.members.unban(row.target_id, "Expiração do banimento temporário");
        } else {
          const member = await guild.members.fetch(row.target_id).catch(() => null);
          if (member?.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp <= Date.now()) {
            await member.timeout(null, "Expiração do timeout temporário");
          }
        }
        updateCase(row.guild_id, row.id, { active: 0 });
      } catch (error) {
        console.error(`[moderation] Falha ao encerrar caso #${row.id}:`, error.message);
      }
    };
    const timer = setTimeout(finish, Math.min(Math.max(0, Date.parse(row.expires_at) - Date.now()), 2_147_000_000));
    timer.unref?.();
  }
}
