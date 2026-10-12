import { AuditLogEvent, Client, Events, GatewayIntentBits, Partials, REST, Routes } from "discord.js";
import { closeDatabase, getSetting } from "./database.js";
import { commandDefinitions, handleCommand, handlePublicationButton, clearPendingPublications } from "./commands.js";
import { handleGuildMemberAdd, handleMessage, pruneSecurityState } from "./security.js";
import { handleTicketInteraction } from "./tickets.js";
import { audit, handleLockdownButton, restoreTemporaryActions } from "./moderation.js";

const token = process.env.DISCORD_BOT_TOKEN?.trim();
if (!token) {
  console.error("[startup] DISCORD_BOT_TOKEN não está definido nos Secrets.");
  process.exitCode = 1;
  throw new Error("DISCORD_BOT_TOKEN ausente.");
}

function envEnabled(name) {
  return ["1", "true", "yes", "sim"].includes(String(process.env[name] ?? "").toLowerCase());
}

const botIntents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildMessages,
];
if (envEnabled("DISCORD_ENABLE_GUILD_MEMBERS_INTENT")) botIntents.push(GatewayIntentBits.GuildMembers);
if (envEnabled("DISCORD_ENABLE_MESSAGE_CONTENT_INTENT")) botIntents.push(GatewayIntentBits.MessageContent);

const client = new Client({
  intents: botIntents,
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User],
});

async function findRecentAuditExecutor(guild, eventType, targetId) {
  try {
    const auditLogs = await guild.fetchAuditLogs({ type: eventType, limit: 6 });
    const entry = auditLogs.entries.find((item) =>
      (!targetId || item.target?.id === targetId) && Date.now() - item.createdTimestamp < 20_000,
    );
    return entry?.executor ? `<@${entry.executor.id}>` : "Desconhecido (sem ação correspondente nos registros de auditoria)";
  } catch {
    return "Desconhecido (o bot não tem acesso aos registros de auditoria)";
  }
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(token);
  const applicationId = process.env.DISCORD_APPLICATION_ID || client.application?.id || client.user.id;
  const developmentGuildId = process.env.DISCORD_DEV_GUILD_ID;
  const route = developmentGuildId
    ? Routes.applicationGuildCommands(applicationId, developmentGuildId)
    : Routes.applicationCommands(applicationId);
  await rest.put(route, { body: commandDefinitions });
  console.info(`[commands] ${commandDefinitions.length} comandos registrados (${developmentGuildId ? "servidor de desenvolvimento" : "globais"}).`);
}

client.once(Events.ClientReady, async (readyClient) => {
  console.info(`[ready] Conectado como ${readyClient.user.tag}; em ${readyClient.guilds.cache.size} servidor(es).`);
  if (!client.options.intents.has(GatewayIntentBits.GuildMembers)) {
    console.warn("[capability] Server Members Intent desligado: entradas e anti-raid pausados. Habilite no Developer Portal e use DISCORD_ENABLE_GUILD_MEMBERS_INTENT=true.");
  }
  if (!client.options.intents.has(GatewayIntentBits.MessageContent)) {
    console.warn("[capability] Message Content Intent desligado: anti-spam e anti-convite pausados. Habilite no Developer Portal e use DISCORD_ENABLE_MESSAGE_CONTENT_INTENT=true.");
  }
  restoreTemporaryActions(client);
  try {
    await registerCommands();
    for (const guild of client.guilds.cache.values()) {
      const config = getSetting(guild.id, "lockdown", {});
      if (config.active) {
        console.warn(`[lockdown] Bloqueio de emergência persistente ativo em ${guild.name}. Use /unlockdown quando for seguro.`);
      }
    }
  } catch (error) {
    console.error("[commands] Não foi possível registrar os comandos:", error);
  }
  setInterval(() => {
    clearPendingPublications();
    pruneSecurityState();
  }, 60_000).unref?.();
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith("ticket:")) {
      if (await handleTicketInteraction(interaction)) return;
    }
    if (interaction.isButton() && interaction.customId.startsWith("publish:")) {
      if (await handlePublicationButton(interaction)) return;
    }
    if (interaction.isButton() && interaction.customId.startsWith("lockdown:")) {
      if (await handleLockdownButton(interaction)) return;
    }
    if ((interaction.isStringSelectMenu() || interaction.isModalSubmit()) && interaction.customId.startsWith("ticket:")) {
      await handleTicketInteraction(interaction);
    }
  } catch (error) {
    console.error(`[interaction] Falha em ${interaction.commandName ?? interaction.customId ?? "ação"}:`, error);
    const message = error?.code === 50013
      ? "O bot não tem a permissão do Discord necessária para esta ação."
      : error?.code === 50001
        ? "O bot não consegue acessar esse recurso."
        : "A ação falhou. Confira as permissões do bot e a hierarquia de cargos.";
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  }
});

client.on(Events.MessageCreate, (message) => handleMessage(message));
client.on(Events.GuildMemberAdd, async (member) => {
  await handleGuildMemberAdd(member);
  await audit(member.guild, "membros", `Membro entrou: ${member.user.tag}.`, {
    Usuário: `${member} · \`${member.id}\``,
    Conta: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:F>`,
  });
});
client.on(Events.GuildMemberRemove, async (member) => {
  if (!member.guild) return;
  const actor = await findRecentAuditExecutor(member.guild, AuditLogEvent.MemberKick, member.id);
  await audit(member.guild, "membros", `Membro saiu: ${member.user?.tag ?? "desconhecido"}.`, { ID: member.id, Responsável: actor });
});
client.on(Events.MessageDelete, async (message) => {
  if (!message.guild) return;
  const content = (message.content || (message.partial ? "Mensagem não armazenada em cache." : "conteúdo vazio.")).replace(/@/g, "@\u200b");
  await audit(message.guild, "mensagens", `Mensagem excluída em <#${message.channelId}>.`, {
    Autor: message.author ? `${message.author.tag} (\`${message.author.id}\`)` : "Desconhecido",
    Conteúdo: content.slice(0, 1000),
  });
});
client.on(Events.MessageUpdate, async (before, after) => {
  if (!after.guild || before.content === after.content) return;
  await audit(after.guild, "mensagens", `Mensagem editada em <#${after.channelId}>.`, {
    Autor: after.author ? `${after.author.tag} (\`${after.author.id}\`)` : "Desconhecido",
    Anterior: (before.content || "Não disponível").replace(/@/g, "@\u200b").slice(0, 800),
    Nova: (after.content || "Não disponível").replace(/@/g, "@\u200b").slice(0, 800),
  });
});
client.on(Events.MessageBulkDelete, async (messages) => {
  const guild = messages.first()?.guild;
  if (guild) await audit(guild, "mensagens", `Exclusão em massa detectada em <#${messages.first().channelId}>.`, { Quantidade: messages.size, Autor: "Desconhecido (API não determinou com segurança)" });
});
client.on(Events.GuildBanAdd, async (ban) => {
  const actor = await findRecentAuditExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
  if (actor === `<@${client.user?.id}>`) return;
  await audit(ban.guild, "moderação", `Banimento observado: <@${ban.user.id}>.`, { Responsável: actor, Usuário: ban.user.tag });
});
client.on(Events.GuildBanRemove, async (ban) => {
  const actor = await findRecentAuditExecutor(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
  await audit(ban.guild, "moderação", `Banimento removido: <@${ban.user.id}>.`, { Responsável: actor, Usuário: ban.user.tag });
});
client.on(Events.ChannelCreate, async (channel) => {
  if (!channel.guild) return;
  const actor = await findRecentAuditExecutor(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
  await audit(channel.guild, "estrutura", `Canal criado: ${channel}.`, { Tipo: channel.type, Responsável: actor });
});
client.on(Events.ChannelDelete, async (channel) => {
  if (!channel.guild) return;
  const actor = await findRecentAuditExecutor(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
  await audit(channel.guild, "estrutura", `Canal removido: ${channel.name}.`, { ID: channel.id, Responsável: actor });
});
client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
  if (!newChannel.guild || oldChannel.name === newChannel.name) return;
  const actor = await findRecentAuditExecutor(newChannel.guild, AuditLogEvent.ChannelUpdate, newChannel.id);
  await audit(newChannel.guild, "estrutura", `Canal atualizado: ${newChannel}.`, { Anterior: oldChannel.name, Atual: newChannel.name, Responsável: actor });
});
client.on(Events.GuildRoleCreate, async (role) => {
  const actor = await findRecentAuditExecutor(role.guild, AuditLogEvent.RoleCreate, role.id);
  await audit(role.guild, "estrutura", `Cargo criado: ${role}.`, { ID: role.id, Responsável: actor });
});
client.on(Events.GuildRoleDelete, async (role) => {
  const actor = await findRecentAuditExecutor(role.guild, AuditLogEvent.RoleDelete, role.id);
  await audit(role.guild, "estrutura", `Cargo removido: ${role.name}.`, { ID: role.id, Responsável: actor });
});
client.on(Events.GuildRoleUpdate, async (oldRole, newRole) => {
  const actor = await findRecentAuditExecutor(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
  await audit(newRole.guild, "estrutura", `Cargo atualizado: ${newRole}.`, { Anterior: oldRole.name, Atual: newRole.name, Responsável: actor });
});
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const before = oldMember.roles.cache.map((role) => role.id).sort().join(",");
  const after = newMember.roles.cache.map((role) => role.id).sort().join(",");
  if (before !== after) {
    const actor = await findRecentAuditExecutor(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
    await audit(newMember.guild, "membros", `Cargos de ${newMember.user.tag} foram alterados.`, { Responsável: actor });
  }
  if (oldMember.nickname !== newMember.nickname) {
    await audit(newMember.guild, "membros", `Apelido de ${newMember.user.tag} atualizado.`, { Anterior: oldMember.nickname ?? oldMember.user.username, Atual: newMember.nickname ?? newMember.user.username });
  }
});

client.on(Events.Error, (error) => console.error("[discord] Erro do gateway:", error));
client.on(Events.Warn, (warning) => console.warn("[discord] Aviso:", warning));
process.on("unhandledRejection", (reason) => console.error("[process] Promise rejeitada sem tratamento:", reason));
process.on("uncaughtException", (error) => console.error("[process] Erro não tratado:", error));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[shutdown] Encerrando com ${signal}.`);
  try {
    await client.destroy();
  } finally {
    closeDatabase();
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await client.login(token);
