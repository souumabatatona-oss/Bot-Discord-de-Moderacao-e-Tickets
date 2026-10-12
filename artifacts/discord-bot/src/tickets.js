import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder,
  ModalBuilder, PermissionFlagsBits, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";
import {
  addTicketEvent, createTicket, db, getOpenTicketsByUser, getSetting, getTicketByChannel,
  listOpenTickets, setSetting, updateTicket,
} from "./database.js";
import { isAdmin, isTicketStaff } from "./auth.js";
import { audit, makeEmbed } from "./moderation.js";

const categories = {
  suporte: { label: "Suporte", emoji: "🎧", description: "Dúvidas, assistência e problemas técnicos do servidor." },
  revogacao: { label: "Revogação", emoji: "🔄", description: "Contestação de decisões ou revisão de punições e restrições." },
  denuncias: { label: "Denúncias", emoji: "🚨", description: "Denúncia de comportamento, infrações às regras ou envio de provas." },
};
const notificationCooldown = new Map();

function getTicketSettings(guildId) {
  return getSetting(guildId, "tickets", { panel: {}, categories: {}, maxOpenPerUser: 1, staffRoleId: null, logChannelId: null });
}

function configuredCategory(settings, key) {
  return { ...categories[key], ...(settings.categories?.[key] ?? {}) };
}

function ticketActionRows() {
  const primary = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket:claim").setLabel("Assumir").setEmoji("🟢").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ticket:rename").setLabel("Renomear").setEmoji("✏️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ticket:staff").setLabel("Marcar equipe").setEmoji("🔔").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ticket:close").setLabel("Fechar").setEmoji("🔒").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ticket:dm").setLabel("Enviar DM").setEmoji("📩").setStyle(ButtonStyle.Primary),
  );
  const internal = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket:note").setLabel("Observação interna").setEmoji("📌").setStyle(ButtonStyle.Secondary),
  );
  return [primary, internal];
}

async function publishPanel(interaction) {
  if (!isAdmin(interaction.memberPermissions)) {
    await interaction.reply({ content: "Somente administradores podem publicar ou alterar o painel.", ephemeral: true });
    return;
  }
  const channel = interaction.options.getChannel("canal", true);
  if (!channel.isTextBased() || !channel.permissionsFor(interaction.guild.members.me).has(PermissionFlagsBits.SendMessages)) {
    await interaction.reply({ content: "O bot precisa conseguir enviar mensagens no canal escolhido.", ephemeral: true });
    return;
  }
  const title = interaction.options.getString("titulo") ?? "Central de atendimento";
  const description = interaction.options.getString("descricao") ?? "Escolha uma categoria para abrir um atendimento privado com a equipe.";
  const image = interaction.options.getString("banner");
  if (image && (!/^https:\/\//i.test(image) || image.length > 500)) {
    await interaction.reply({ content: "O banner precisa ser um URL HTTPS válido.", ephemeral: true });
    return;
  }
  const settings = getTicketSettings(interaction.guildId);
  const maxOpen = interaction.options.getInteger("limite_por_membro");
  const reopenDays = interaction.options.getInteger("prazo_reabertura_dias");
  const staffRole = interaction.options.getRole("cargo_staff");
  const logChannel = interaction.options.getChannel("canal_logs");
  settings.panel = { channelId: channel.id, title, description, image: image ?? null };
  if (maxOpen !== null) settings.maxOpenPerUser = maxOpen;
  if (reopenDays !== null) settings.reopenDays = reopenDays;
  if (staffRole) settings.staffRoleId = staffRole.id;
  if (logChannel) settings.logChannelId = logChannel.id;
  setSetting(interaction.guildId, "tickets", settings);
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription(description)
    .setFooter({ text: interaction.guild.name }).setTimestamp();
  if (image) embed.setImage(image);
  const options = Object.entries(categories).filter(([key]) => configuredCategory(settings, key).enabled !== false).map(([key, category]) => ({
    label: configuredCategory(settings, key).label ?? category.label,
    value: key,
    description: String(configuredCategory(settings, key).description ?? category.description).slice(0, 100),
    emoji: category.emoji,
  }));
  if (!options.length) {
    await interaction.reply({ content: "Ative pelo menos uma categoria antes de publicar o painel.", ephemeral: true });
    return;
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId("ticket:open").setPlaceholder("Selecione o assunto do atendimento").addOptions(options);
  await channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] });
  await audit(interaction.guild, "tickets", `Painel de tickets publicado por ${interaction.user}.`, { Canal: channel.toString() });
  await interaction.reply({ content: `Painel publicado em ${channel}.`, ephemeral: true });
}

async function configureCategory(interaction) {
  if (!isAdmin(interaction.memberPermissions)) {
    await interaction.reply({ content: "Somente administradores podem configurar categorias de tickets.", ephemeral: true });
    return;
  }
  const key = interaction.options.getString("categoria", true);
  const categoryChannel = interaction.options.getChannel("categoria_canais", true);
  const staffRole = interaction.options.getRole("cargo_atendimento");
  const welcome = interaction.options.getString("mensagem_inicial");
  const label = interaction.options.getString("nome");
  const description = interaction.options.getString("descricao");
  const enabled = interaction.options.getBoolean("ativada");
  if (categoryChannel.type !== ChannelType.GuildCategory) {
    await interaction.reply({ content: "Escolha uma categoria de canais do Discord.", ephemeral: true });
    return;
  }
  const settings = getTicketSettings(interaction.guildId);
  const previous = settings.categories?.[key] ?? {};
  settings.categories = {
    ...(settings.categories ?? {}),
    [key]: {
      ...previous, parentId: categoryChannel.id,
      ...(staffRole ? { staffRoleId: staffRole.id } : {}),
      ...(welcome ? { welcomeMessage: welcome } : {}),
      ...(label ? { label } : {}),
      ...(description ? { description } : {}),
      enabled: enabled ?? previous.enabled ?? true,
    },
  };
  setSetting(interaction.guildId, "tickets", settings);
  await audit(interaction.guild, "configurações", `Categoria ${key} de tickets atualizada por ${interaction.user}.`, { Canal: categoryChannel.name, Staff: staffRole?.name });
  await interaction.reply({ content: `Configuração salva para a categoria **${configuredCategory(settings, key).label}**.`, ephemeral: true });
}

export async function executeTicketCommand(interaction) {
  if (interaction.commandName === "ticketpainel") {
    if (interaction.options.getSubcommand() === "publicar") return publishPanel(interaction);
    return configureCategory(interaction);
  }
  if (interaction.commandName !== "ticket") return false;
  return executeTicketAdminCommand(interaction);
}

async function openTicket(interaction) {
  const key = interaction.values[0];
  if (!categories[key]) {
    await interaction.reply({ content: "Categoria inválida.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const settings = getTicketSettings(interaction.guildId);
  const category = configuredCategory(settings, key);
  if (category.enabled === false) {
    await interaction.editReply({ content: "Essa categoria está temporariamente desativada." });
    return;
  }
  const open = getOpenTicketsByUser(interaction.guildId, interaction.user.id);
  if (open.length >= Math.max(1, Math.min(10, settings.maxOpenPerUser ?? 1))) {
    await interaction.editReply({ content: `Você já atingiu o limite de ${settings.maxOpenPerUser ?? 1} ticket(s) aberto(s).` });
    return;
  }
  const parent = category.parentId ? interaction.guild.channels.cache.get(category.parentId) : null;
  if (category.parentId && (!parent || parent.type !== ChannelType.GuildCategory)) {
    await interaction.editReply({ content: "A categoria de canais configurada não está disponível. Peça a um administrador para revisar o painel." });
    return;
  }
  const roleIds = [settings.staffRoleId, category.staffRoleId].filter(Boolean);
  const permissionOverwrites = [
    { id: interaction.guildId, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
    { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.AttachFiles] },
    ...[...new Set(roleIds)].map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] })),
  ];
  const safeUsername = interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 35).replace(/^-|-$/g, "") || "membro";
  const channel = await interaction.guild.channels.create({
    name: `${key}-${safeUsername}`.slice(0, 90),
    type: ChannelType.GuildText,
    parent: parent?.id,
    permissionOverwrites,
    reason: `Ticket ${category.label} de ${interaction.user.tag}`,
  }).catch(async (error) => {
    console.error("[tickets] Falha ao criar canal:", error);
    await interaction.editReply({ content: "Não foi possível criar o canal privado. Confira as permissões de canais do bot." });
    return null;
  });
  if (!channel) return;
  try {
    const ticket = createTicket({ guildId: interaction.guildId, channelId: channel.id, openerId: interaction.user.id, categoryKey: key });
    addTicketEvent(ticket.id, interaction.user.id, "opened", category.label);
    const welcome = category.welcomeMessage || `Descreva seu caso. A equipe de atendimento irá responder aqui.`;
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`${category.emoji} ${category.label}`)
      .setDescription(`${interaction.user} abriu este atendimento.\n\n${welcome}`)
      .addFields(
        { name: "Responsável", value: "Ainda não assumido", inline: true },
        { name: "Aberto", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
      ).setFooter({ text: `Ticket #${ticket.id} · ID ${ticket.id}` });
    await channel.send({ content: `${interaction.user}${roleIds.length ? ` ${[...new Set(roleIds)].map((id) => `<@&${id}>`).join(" ")}` : ""}`, embeds: [embed], components: ticketActionRows(), allowedMentions: { users: [interaction.user.id], roles: [...new Set(roleIds)] } });
    await audit(interaction.guild, "tickets", `Ticket #${ticket.id} aberto por ${interaction.user}.`, { Categoria: category.label, Canal: channel.toString() });
    await interaction.editReply({ content: `Seu ticket está aberto em ${channel}.` });
  } catch (error) {
    await channel.delete("Falha ao configurar ticket").catch(() => {});
    throw error;
  }
}

async function requireStaff(interaction) {
  if (isTicketStaff(interaction.member, interaction.guildId)) return true;
  await interaction.reply({ content: "Somente atendentes autorizados podem usar essa ação.", ephemeral: true });
  return false;
}

function activeTicket(interaction) {
  return getTicketByChannel(interaction.channelId);
}

async function ticketButton(interaction) {
  const ticket = activeTicket(interaction);
  if (!ticket) {
    await interaction.reply({ content: "Este canal não está registrado como ticket ativo.", ephemeral: true });
    return true;
  }
  if (interaction.customId === "ticket:claim") {
    if (!(await requireStaff(interaction))) return true;
    if (ticket.status !== "open") {
      await interaction.reply({ content: "Este ticket não está aberto.", ephemeral: true });
      return true;
    }
    if (ticket.assigned_to && ticket.assigned_to !== interaction.user.id) {
      await interaction.reply({ content: `Este ticket já foi assumido por <@${ticket.assigned_to}>.`, ephemeral: true });
      return true;
    }
    updateTicket(interaction.channelId, { assignedTo: interaction.user.id });
    addTicketEvent(ticket.id, interaction.user.id, "claimed");
    await audit(interaction.guild, "tickets", `Ticket #${ticket.id} assumido por ${interaction.user}.`);
    await interaction.reply({ content: "Você assumiu este ticket.", ephemeral: true });
    await interaction.message.edit({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setFields(
      ...interaction.message.embeds[0].fields.filter((field) => field.name !== "Responsável"),
      { name: "Responsável", value: interaction.user.toString(), inline: true },
    )] }).catch(() => {});
    return true;
  }
  if (interaction.customId === "ticket:rename") {
    if (!(await requireStaff(interaction))) return true;
    const modal = new ModalBuilder().setCustomId("ticket:rename-modal").setTitle("Renomear ticket")
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("name").setLabel("Novo nome").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(3).setMaxLength(80).setValue(interaction.channel.name)));
    await interaction.showModal(modal);
    return true;
  }
  if (interaction.customId === "ticket:staff") {
    if (!(await requireStaff(interaction))) return true;
    const last = notificationCooldown.get(interaction.channelId) ?? 0;
    if (Date.now() - last < 60_000) {
      await interaction.reply({ content: `A equipe foi notificada recentemente. Aguarde ${Math.ceil((60_000 - (Date.now() - last)) / 1000)}s.`, ephemeral: true });
      return true;
    }
    const settings = getTicketSettings(interaction.guildId);
    const roleId = configuredCategory(settings, ticket.category_key).staffRoleId ?? settings.staffRoleId;
    if (!roleId) {
      await interaction.reply({ content: "Nenhum cargo de atendimento está configurado para esta categoria.", ephemeral: true });
      return true;
    }
    notificationCooldown.set(interaction.channelId, Date.now());
    addTicketEvent(ticket.id, interaction.user.id, "staff_notified");
    await interaction.channel.send({ content: `🔔 <@&${roleId}> foi chamado por ${interaction.user}.`, allowedMentions: { roles: [roleId], users: [] } });
    await audit(interaction.guild, "tickets", `Equipe marcada no ticket #${ticket.id} por ${interaction.user}.`);
    await interaction.reply({ content: "Equipe notificada.", ephemeral: true });
    return true;
  }
  if (interaction.customId === "ticket:dm") {
    if (!(await requireStaff(interaction))) return true;
    const modal = new ModalBuilder().setCustomId("ticket:dm-modal").setTitle("Enviar mensagem direta")
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("message").setLabel("Mensagem ao autor").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500)));
    await interaction.showModal(modal);
    return true;
  }
  if (interaction.customId === "ticket:note") {
    if (!(await requireStaff(interaction))) return true;
    const modal = new ModalBuilder().setCustomId("ticket:note-modal").setTitle("Observação interna")
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("note").setLabel("Observação (visível à equipe)").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)));
    await interaction.showModal(modal);
    return true;
  }
  if (interaction.customId === "ticket:close") {
    if (ticket.status !== "open" && ticket.status !== "pending") {
      await interaction.reply({ content: "Este ticket já está encerrado.", ephemeral: true });
      return true;
    }
    if (interaction.user.id !== ticket.opener_id && ticket.assigned_to !== interaction.user.id && !isAdmin(interaction.memberPermissions)) {
      await interaction.reply({ content: "Somente o autor, o responsável ou um administrador pode fechar este ticket.", ephemeral: true });
      return true;
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ticket:close-confirm").setLabel("Confirmar encerramento").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("ticket:close-cancel").setLabel("Continuar atendimento").setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({ content: "Confirmar o encerramento deste ticket?", components: [row], ephemeral: true });
    return true;
  }
  if (interaction.customId === "ticket:close-cancel") {
    await interaction.update({ content: "O ticket continua aberto.", components: [] });
    return true;
  }
  if (interaction.customId === "ticket:close-confirm") {
    if (ticket.status !== "open" && ticket.status !== "pending") {
      await interaction.reply({ content: "Este ticket já está encerrado.", ephemeral: true });
      return true;
    }
    if (interaction.user.id !== ticket.opener_id && ticket.assigned_to !== interaction.user.id && !isAdmin(interaction.memberPermissions)) {
      await interaction.reply({ content: "Você não pode encerrar este ticket.", ephemeral: true });
      return true;
    }
    await interaction.update({ content: "Encerrando e gerando transcrição…", components: [] });
    await closeTicket(interaction, ticket, "Encerrado pelo autor ou atendente", interaction.user.id);
    return true;
  }
  return false;
}

async function closeTicket(interaction, ticket, reason, actorId) {
  const channel = interaction.guild.channels.cache.get(ticket.channel_id);
  if (!channel) {
    updateTicket(ticket.channel_id, { status: "closed", closedAt: new Date().toISOString(), closeReason: reason });
    return;
  }
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const transcript = messages ? [...messages.values()].reverse().map((message) => {
    const time = new Date(message.createdTimestamp).toISOString();
    const content = message.content.replace(/@/g, "@\u200b");
    const attachments = [...message.attachments.values()].map((file) => file.name || "arquivo").join(", ");
    return `[${time}] ${message.author.tag}: ${content}${attachments ? ` [anexos: ${attachments}]` : ""}`;
  }).join("\n") : "Não foi possível ler o histórico deste canal.";
  const attachment = new AttachmentBuilder(Buffer.from(transcript, "utf8"), { name: `ticket-${ticket.id}-transcricao.txt` });
  const settings = getTicketSettings(interaction.guildId);
  const logChannelId = settings.logChannelId ?? getSetting(interaction.guildId, "logs", {}).channelId;
  const logChannel = logChannelId ? await interaction.guild.channels.fetch(logChannelId).catch(() => null) : null;
  if (logChannel?.isTextBased()) {
    await logChannel.send({ content: `Transcrição do ticket #${ticket.id} (autor <@${ticket.opener_id}>, fechado por <@${actorId}>). Motivo: ${reason}`, files: [attachment] }).catch(() => {});
  }
  const author = await interaction.client.users.fetch(ticket.opener_id).catch(() => null);
  if (author) await author.send({ content: `Seu ticket #${ticket.id} em **${interaction.guild.name}** foi encerrado.`, files: [attachment] }).catch(() => {});
  updateTicket(ticket.channel_id, { status: "closed", closedAt: new Date().toISOString(), closeReason: reason });
  addTicketEvent(ticket.id, actorId, "closed", reason);
  await audit(interaction.guild, "tickets", `Ticket #${ticket.id} encerrado por <@${actorId}>.`, { Motivo: reason });
  await channel.permissionOverwrites.edit(ticket.opener_id, { SendMessages: false }, { reason: "Ticket encerrado" }).catch(() => {});
  await channel.setName(`fechado-${channel.name}`.slice(0, 95), "Ticket encerrado").catch(() => {});
  const reopenDays = Math.max(1, Math.min(30, settings.reopenDays ?? 7));
  await channel.send({ content: `Ticket encerrado por <@${actorId}>. Transcrição enviada ao canal de logs quando configurado. Este canal será mantido para consulta; um atendente pode reabri-lo em até ${reopenDays} dias.` }).catch(() => {});
}

async function modalSubmit(interaction) {
  const ticket = activeTicket(interaction);
  if (!ticket) {
    await interaction.reply({ content: "Ticket não encontrado.", ephemeral: true });
    return true;
  }
  if (!(await requireStaff(interaction))) return true;
  if (interaction.customId === "ticket:rename-modal") {
    const name = interaction.fields.getTextInputValue("name").toLowerCase().trim();
    if (!/^[a-z0-9][a-z0-9_-]{2,79}$/.test(name)) {
      await interaction.reply({ content: "Use de 3 a 80 caracteres: letras sem acento, números, hífen ou sublinhado.", ephemeral: true });
      return true;
    }
    const previous = interaction.channel.name;
    await interaction.channel.setName(name);
    addTicketEvent(ticket.id, interaction.user.id, "renamed", `${previous} → ${name}`);
    await audit(interaction.guild, "tickets", `Ticket #${ticket.id} renomeado por ${interaction.user}.`, { Anterior: previous, Novo: name });
    await interaction.reply({ content: `Canal renomeado para **${name}**.`, ephemeral: true });
    return true;
  }
  if (interaction.customId === "ticket:dm-modal") {
    const message = interaction.fields.getTextInputValue("message").trim();
    const author = await interaction.client.users.fetch(ticket.opener_id).catch(() => null);
    const sent = await author?.send({ content: `Mensagem da equipe de **${interaction.guild.name}** sobre o ticket #${ticket.id}:\n\n${message}`, allowedMentions: { parse: [] } }).then(() => true).catch(() => false);
    addTicketEvent(ticket.id, interaction.user.id, sent ? "dm_sent" : "dm_failed");
    await audit(interaction.guild, "tickets", `DM para o autor do ticket #${ticket.id} solicitada por ${interaction.user}; resultado: ${sent ? "enviada" : "falha"}.`);
    await interaction.reply({ content: sent ? "Mensagem enviada por DM." : "Não foi possível enviar a DM; o membro pode ter bloqueado mensagens diretas.", ephemeral: true });
    return true;
  }
  if (interaction.customId === "ticket:note-modal") {
    const note = interaction.fields.getTextInputValue("note").trim();
    addTicketEvent(ticket.id, interaction.user.id, "internal_note", note);
    await audit(interaction.guild, "tickets", `Observação interna registrada no ticket #${ticket.id} por ${interaction.user}.`);
    await interaction.reply({ content: "Observação salva no histórico interno do ticket.", ephemeral: true });
    return true;
  }
  return false;
}

async function executeTicketAdminCommand(interaction) {
  const subcommand = interaction.options.getSubcommand();
  const ticket = activeTicket(interaction);
  if (subcommand === "estatisticas") {
    if (!isTicketStaff(interaction.member, interaction.guildId)) return interaction.reply({ content: "Somente atendentes podem consultar estatísticas.", ephemeral: true });
    const open = listOpenTickets(interaction.guildId).length;
    const closed = db.prepare("SELECT COUNT(*) AS count FROM tickets WHERE guild_id = ? AND status = 'closed'").get(interaction.guildId).count;
    const total = db.prepare("SELECT COUNT(*) AS count FROM tickets WHERE guild_id = ?").get(interaction.guildId).count;
    return interaction.reply({ embeds: [makeEmbed("Estatísticas de atendimento", `Abertos: **${open}**\nFechados: **${closed}**\nTotal: **${total}**`)], ephemeral: true });
  }
  if (subcommand === "historico") {
    if (!ticket) return interaction.reply({ content: "Este canal não é um ticket.", ephemeral: true });
    if (!isTicketStaff(interaction.member, interaction.guildId) && interaction.user.id !== ticket.opener_id) return interaction.reply({ content: "Sem permissão para consultar este histórico.", ephemeral: true });
    const events = db.prepare("SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id DESC LIMIT 15").all(ticket.id);
    const description = events.length ? events.map((event) => `**${event.event_type}** · <@${event.actor_id}> · <t:${Math.floor(new Date(`${event.created_at}Z`).getTime() / 1000)}:R>${event.details ? ` · ${event.details.slice(0, 120)}` : ""}`).join("\n") : "Sem eventos.";
    return interaction.reply({ embeds: [makeEmbed(`Histórico do ticket #${ticket.id}`, description)], ephemeral: true });
  }
  if (subcommand === "add" || subcommand === "remove" || subcommand === "transferir" || subcommand === "prioridade" || subcommand === "pendente" || subcommand === "reabrir" || subcommand === "arquivar") {
    if (!(await requireStaff(interaction))) return;
  } else if (!ticket) {
    return interaction.reply({ content: "Execute este comando no canal do ticket.", ephemeral: true });
  }
  if (!ticket) return interaction.reply({ content: "Ticket não encontrado.", ephemeral: true });
  const channel = interaction.channel;
  if (subcommand === "add" || subcommand === "remove") {
    const user = interaction.options.getUser("membro", true);
    if (subcommand === "add") {
      await channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
    } else if (user.id === ticket.opener_id) {
      return interaction.reply({ content: "O autor original não pode ser removido do próprio ticket.", ephemeral: true });
    } else {
      await channel.permissionOverwrites.delete(user.id).catch(() => {});
    }
    addTicketEvent(ticket.id, interaction.user.id, subcommand === "add" ? "member_added" : "member_removed", user.id);
    await audit(interaction.guild, "tickets", `Membro ${user} ${subcommand === "add" ? "adicionado ao" : "removido do"} ticket #${ticket.id} por ${interaction.user}.`);
    return interaction.reply({ content: `${user} ${subcommand === "add" ? "adicionado ao" : "removido do"} ticket.`, ephemeral: true });
  }
  if (subcommand === "transferir") {
    const user = interaction.options.getUser("atendente", true);
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member || !isTicketStaff(member, interaction.guildId)) return interaction.reply({ content: "O destinatário precisa ter um cargo de atendimento configurado.", ephemeral: true });
    updateTicket(channel.id, { assignedTo: user.id });
    addTicketEvent(ticket.id, interaction.user.id, "transferred", user.id);
    await audit(interaction.guild, "tickets", `Ticket #${ticket.id} transferido por ${interaction.user} para ${user}.`);
    return interaction.reply({ content: `Responsabilidade transferida para ${user}.`, ephemeral: true });
  }
  if (subcommand === "prioridade") {
    const priority = interaction.options.getString("prioridade", true);
    updateTicket(channel.id, { priority });
    addTicketEvent(ticket.id, interaction.user.id, "priority_changed", priority);
    return interaction.reply({ content: `Prioridade atualizada: **${priority}**.`, ephemeral: true });
  }
  if (subcommand === "pendente") {
    const pending = interaction.options.getBoolean("pendente", true);
    updateTicket(channel.id, { status: pending ? "pending" : "open" });
    addTicketEvent(ticket.id, interaction.user.id, pending ? "marked_pending" : "reopened");
    return interaction.reply({ content: pending ? "Ticket marcado como pendente." : "Ticket retomado.", ephemeral: true });
  }
  if (subcommand === "reabrir") {
    const closed = db.prepare("SELECT * FROM tickets WHERE channel_id = ? AND status = 'closed'").get(channel.id);
    if (!closed) return interaction.reply({ content: "Ticket fechado não encontrado neste canal.", ephemeral: true });
    const reopenDays = Math.max(1, Math.min(30, getTicketSettings(interaction.guildId).reopenDays ?? 7));
    if (Date.now() - Date.parse(`${closed.closed_at}Z`) > reopenDays * 86_400_000) return interaction.reply({ content: "O prazo para reabrir este ticket expirou.", ephemeral: true });
    updateTicket(channel.id, { status: "open", closedAt: null, closeReason: null });
    await channel.permissionOverwrites.edit(closed.opener_id, { SendMessages: true, ViewChannel: true });
    addTicketEvent(closed.id, interaction.user.id, "reopened");
    await channel.send(`Ticket reaberto por ${interaction.user}.`);
    return interaction.reply({ content: "Ticket reaberto.", ephemeral: true });
  }
  if (subcommand === "arquivar") {
    if (ticket.status !== "closed") return interaction.reply({ content: "Feche o ticket antes de arquivá-lo.", ephemeral: true });
    await channel.setName(`arquivo-${channel.name}`.slice(0, 95));
    addTicketEvent(ticket.id, interaction.user.id, "archived");
    return interaction.reply({ content: "Ticket arquivado; o canal foi mantido para consulta.", ephemeral: true });
  }
  return interaction.reply({ content: "Ação de ticket inválida.", ephemeral: true });
}

export async function handleTicketInteraction(interaction) {
  try {
    if (interaction.isStringSelectMenu() && interaction.customId === "ticket:open") {
      await openTicket(interaction);
      return true;
    }
    if (interaction.isButton() && interaction.customId.startsWith("ticket:")) {
      return await ticketButton(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("ticket:")) {
      return await modalSubmit(interaction);
    }
  } catch (error) {
    console.error("[tickets] Erro ao processar interação:", error);
    const message = "Não foi possível concluir esta ação. Confira as permissões do bot e tente novamente.";
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    else await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    return true;
  }
  return false;
}
