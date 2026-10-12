import {
  ChannelType, EmbedBuilder, GatewayIntentBits, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder,
  ButtonBuilder, ButtonStyle, ActionRowBuilder,
} from "discord.js";
import { createHash } from "node:crypto";
import { db, getSetting, recordCampaign, setSetting } from "./database.js";
import { makeEmbed, audit } from "./moderation.js";
import { executeModeration } from "./moderation.js";
import { executeTicketCommand } from "./tickets.js";

const definitions = [];
const pendingPublications = new Map();

function securityCommand(name, description, configOptions = (command) => command) {
  return new SlashCommandBuilder().setName(name).setDescription(description)
    .addSubcommand((sub) => sub.setName("ativar").setDescription("Ativar esta proteção."))
    .addSubcommand((sub) => sub.setName("desativar").setDescription("Desativar esta proteção."))
    .addSubcommand((sub) => sub.setName("status").setDescription("Consultar estado e parâmetros."))
    .addSubcommand((sub) => {
      sub.setName("configurar").setDescription("Ajustar limites e ações.");
      return configOptions(sub);
    });
}

definitions.push(
  securityCommand("antiraid", "Configure a proteção contínua contra entradas em massa.", (sub) => sub
    .addIntegerOption((option) => option.setName("entradas").setDescription("Limite de entradas na janela.").setMinValue(2).setMaxValue(100).setRequired(false))
    .addIntegerOption((option) => option.setName("janela_segundos").setDescription("Duração da janela de monitoramento.").setMinValue(5).setMaxValue(600).setRequired(false))
    .addIntegerOption((option) => option.setName("idade_conta_dias").setDescription("Idade considerada recente (sinal de risco, nunca ban automático).").setMinValue(1).setMaxValue(90).setRequired(false))
    .addBooleanOption((option) => option.setName("alertar_contas_recentes").setDescription("Alertar moderação sobre contas novas.").setRequired(false))
    .addBooleanOption((option) => option.setName("usar_verificacao").setDescription("Aplicar temporariamente o cargo durante picos de entrada.").setRequired(false))
    .addRoleOption((option) => option.setName("cargo_verificacao").setDescription("Cargo opcional para verificação durante pico.").setRequired(false))
    .addIntegerOption((option) => option.setName("tempo_verificacao_minutos").setDescription("Tempo até remover o cargo.").setMinValue(1).setMaxValue(1440).setRequired(false))
    .addChannelOption((option) => option.setName("canal_alertas").setDescription("Canal da equipe de moderação.").addChannelTypes(ChannelType.GuildText).setRequired(false))),
  securityCommand("antispam", "Configure a detecção contínua de spam.", (sub) => sub
    .addIntegerOption((option) => option.setName("mensagens").setDescription("Limite em uma janela móvel de 10 s.").setMinValue(3).setMaxValue(30).setRequired(false))
    .addBooleanOption((option) => option.setName("excluir_mensagens").setDescription("Tentar excluir mensagens sinalizadas.").setRequired(false))
    .addBooleanOption((option) => option.setName("timeout").setDescription("Aplicar timeout automático a spam repetido.").setRequired(false))
    .addIntegerOption((option) => option.setName("timeout_minutos").setDescription("Duração do timeout.").setMinValue(1).setMaxValue(60).setRequired(false))
    .addBooleanOption((option) => option.setName("bloquear_convites").setDescription("Sinalizar convites do Discord como spam.").setRequired(false))
    .addChannelOption((option) => option.setName("canal_excecao").setDescription("Canal isento (somente esta configuração).").addChannelTypes(ChannelType.GuildText).setRequired(false))
    .addRoleOption((option) => option.setName("cargo_excecao").setDescription("Cargo isento (somente esta configuração).").setRequired(false))
    .addChannelOption((option) => option.setName("canal_alertas").setDescription("Canal de alertas e logs.").addChannelTypes(ChannelType.GuildText).setRequired(false))),
  securityCommand("antiinvite", "Configure a proteção contínua contra convites não autorizados.", (sub) => sub
    .addStringOption((option) => option.setName("codigo_autorizado").setDescription("Código do convite para adicionar à lista permitida.").setMinLength(2).setMaxLength(64).setRequired(false))
    .addBooleanOption((option) => option.setName("excluir_mensagens").setDescription("Tentar excluir convites bloqueados.").setRequired(false))
    .addBooleanOption((option) => option.setName("timeout_reincidencia").setDescription("Aplicar timeout após reincidência (padrão: 3).").setRequired(false))
    .addIntegerOption((option) => option.setName("limite_reincidencia").setDescription("Ocorrências antes do timeout.").setMinValue(2).setMaxValue(10).setRequired(false))
    .addChannelOption((option) => option.setName("canal_excecao").setDescription("Canal isento (somente esta configuração).").addChannelTypes(ChannelType.GuildText).setRequired(false))
    .addRoleOption((option) => option.setName("cargo_excecao").setDescription("Cargo isento (somente esta configuração).").setRequired(false))
    .addChannelOption((option) => option.setName("canal_alertas").setDescription("Canal da equipe de moderação.").addChannelTypes(ChannelType.GuildText).setRequired(false))),
);

definitions.push(
  new SlashCommandBuilder().setName("logs").setDescription("Configure o canal e os tipos de registro do servidor.")
    .addSubcommand((sub) => sub.setName("configurar").setDescription("Escolher o canal de logs.")
      .addChannelOption((option) => option.setName("canal").setDescription("Canal privado de logs.").addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((sub) => sub.setName("categoria").setDescription("Ativar ou ocultar um tipo de log.")
      .addStringOption((option) => option.setName("tipo").setDescription("Categoria de eventos.").setRequired(true).addChoices(
        { name: "Moderação", value: "moderação" }, { name: "Mensagens", value: "mensagens" },
        { name: "Membros", value: "membros" }, { name: "Estrutura", value: "estrutura" },
        { name: "Tickets", value: "tickets" }, { name: "Configurações", value: "configurações" },
      ))
      .addBooleanOption((option) => option.setName("ativada").setDescription("Enviar este tipo de evento para logs.").setRequired(true)))
    .addSubcommand((sub) => sub.setName("status").setDescription("Ver a configuração atual.")),
  new SlashCommandBuilder().setName("ticketpainel").setDescription("Publique o painel e configure o atendimento.")
    .addSubcommand((sub) => sub.setName("publicar").setDescription("Publicar o painel interativo.")
      .addChannelOption((option) => option.setName("canal").setDescription("Canal público do painel.").addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addStringOption((option) => option.setName("titulo").setDescription("Título da embed.").setMaxLength(100))
      .addStringOption((option) => option.setName("descricao").setDescription("Instruções para os membros.").setMaxLength(1000))
      .addStringOption((option) => option.setName("banner").setDescription("URL HTTPS pública para o banner.").setMaxLength(500))
      .addIntegerOption((option) => option.setName("limite_por_membro").setDescription("Tickets simultâneos por pessoa (1 a 10).").setMinValue(1).setMaxValue(10))
      .addIntegerOption((option) => option.setName("prazo_reabertura_dias").setDescription("Prazo para reabrir (1 a 30 dias).").setMinValue(1).setMaxValue(30))
      .addRoleOption((option) => option.setName("cargo_staff").setDescription("Cargo geral para notificações do painel."))
      .addChannelOption((option) => option.setName("canal_logs").setDescription("Canal para transcrições dos tickets.").addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((sub) => sub.setName("configurar").setDescription("Configurar uma categoria de atendimento.")
      .addStringOption((option) => option.setName("categoria").setDescription("Tipo de atendimento.").setRequired(true).addChoices(
        { name: "Suporte", value: "suporte" }, { name: "Revogação", value: "revogacao" }, { name: "Denúncias", value: "denuncias" },
      ))
      .addChannelOption((option) => option.setName("categoria_canais").setDescription("Categoria do Discord onde os canais serão criados.").addChannelTypes(ChannelType.GuildCategory).setRequired(true))
      .addRoleOption((option) => option.setName("cargo_atendimento").setDescription("Cargo que poderá ver e atender estes tickets."))
      .addStringOption((option) => option.setName("nome").setDescription("Nome apresentado no painel.").setMaxLength(80))
      .addStringOption((option) => option.setName("descricao").setDescription("Descrição desta opção do painel.").setMaxLength(100))
      .addStringOption((option) => option.setName("mensagem_inicial").setDescription("Instrução exibida dentro do ticket.").setMaxLength(1000))
      .addBooleanOption((option) => option.setName("ativada").setDescription("Permitir abertura nesta categoria.").setRequired(false))),
  new SlashCommandBuilder().setName("ticket").setDescription("Gerencie tickets neste servidor.")
    .addSubcommand((sub) => sub.setName("add").setDescription("Autorizar um membro neste ticket.").addUserOption((option) => option.setName("membro").setDescription("Membro autorizado.").setRequired(true)))
    .addSubcommand((sub) => sub.setName("remove").setDescription("Remover acesso de um membro.").addUserOption((option) => option.setName("membro").setDescription("Membro.").setRequired(true)))
    .addSubcommand((sub) => sub.setName("transferir").setDescription("Transferir o atendimento.").addUserOption((option) => option.setName("atendente").setDescription("Novo responsável autorizado.").setRequired(true)))
    .addSubcommand((sub) => sub.setName("prioridade").setDescription("Alterar a prioridade.").addStringOption((option) => option.setName("prioridade").setDescription("Prioridade.").setRequired(true).addChoices({ name: "Baixa", value: "baixa" }, { name: "Normal", value: "normal" }, { name: "Alta", value: "alta" }, { name: "Urgente", value: "urgente" })))
    .addSubcommand((sub) => sub.setName("pendente").setDescription("Marcar ticket como pendente ou retomá-lo.").addBooleanOption((option) => option.setName("pendente").setDescription("Sim para pendente; não para retomar.").setRequired(true)))
    .addSubcommand((sub) => sub.setName("reabrir").setDescription("Reabrir dentro do prazo configurado."))
    .addSubcommand((sub) => sub.setName("arquivar").setDescription("Marcar um ticket fechado como arquivado."))
    .addSubcommand((sub) => sub.setName("estatisticas").setDescription("Consultar volume de atendimentos."))
    .addSubcommand((sub) => sub.setName("historico").setDescription("Consultar o histórico deste ticket.")),
);

const memberOption = (sub, name = "membro") => sub.addUserOption((option) => option.setName(name).setDescription("Membro alvo.").setRequired(true));
const reasonOption = (sub) => sub.addStringOption((option) => option.setName("motivo").setDescription("Justificativa registrada.").setMaxLength(500));
const targetedCommand = (name, description, permission, needsReason = true, addRequiredOptions = null) => {
  const builder = new SlashCommandBuilder().setName(name).setDescription(description).setDefaultMemberPermissions(permission);
  memberOption(builder, "membro");
  if (addRequiredOptions) addRequiredOptions(builder);
  if (needsReason) reasonOption(builder);
  return builder;
};

definitions.push(
  targetedCommand("ban", "Banir um membro após validar hierarquia.", PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder().setName("unban").setDescription("Remover um banimento por ID do usuário.").setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption((option) => option.setName("id").setDescription("ID do usuário banido.").setRequired(true))
    .addStringOption((option) => option.setName("motivo").setDescription("Justificativa.").setMaxLength(500)),
  targetedCommand("kick", "Expulsar um membro após validar hierarquia.", PermissionFlagsBits.KickMembers),
  targetedCommand("timeout", "Aplicar timeout temporário.", PermissionFlagsBits.ModerateMembers, true, (builder) =>
    builder.addIntegerOption((option) => option.setName("minutos").setDescription("Duração em minutos (máx. 40.320).").setMinValue(1).setMaxValue(40320).setRequired(true))),
  targetedCommand("untimeout", "Remover o timeout ativo.", PermissionFlagsBits.ModerateMembers),
  targetedCommand("mute", "Alias de timeout para compatibilidade.", PermissionFlagsBits.ModerateMembers)
    .addIntegerOption((option) => option.setName("minutos").setDescription("Duração em minutos.").setMinValue(1).setMaxValue(40320)),
  targetedCommand("tempmute", "Aplicar timeout com expiração registrada.", PermissionFlagsBits.ModerateMembers)
    .addIntegerOption((option) => option.setName("minutos").setDescription("Duração em minutos.").setMinValue(1).setMaxValue(40320)),
  targetedCommand("tempban", "Aplicar banimento temporário.", PermissionFlagsBits.BanMembers, true, (builder) =>
    builder.addIntegerOption((option) => option.setName("dias").setDescription("Duração em dias.").setMinValue(1).setMaxValue(30).setRequired(true))),
  targetedCommand("softban", "Remover e readmitir membro, apagando mensagens recentes.", PermissionFlagsBits.BanMembers),
  targetedCommand("warn", "Registrar uma advertência persistente.", PermissionFlagsBits.ModerateMembers),
  targetedCommand("warnings", "Consultar advertências de um membro.", PermissionFlagsBits.ModerateMembers, false),
  targetedCommand("history", "Consultar histórico de moderação.", PermissionFlagsBits.ModerateMembers, false),
  targetedCommand("clearwarns", "Arquivar advertências ativas.", PermissionFlagsBits.ManageGuild, false),
  new SlashCommandBuilder().setName("unwarn").setDescription("Desativar uma advertência pelo caso.").setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption((option) => option.setName("caso").setDescription("Número do caso.").setRequired(true)),
  new SlashCommandBuilder().setName("reason").setDescription("Atualizar justificativa mantendo o histórico.").setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption((option) => option.setName("caso").setDescription("Número do caso.").setRequired(true))
    .addStringOption((option) => option.setName("motivo").setDescription("Nova justificativa.").setMinLength(1).setMaxLength(500).setRequired(true)),
  new SlashCommandBuilder().setName("case").setDescription("Consultar um caso de moderação.")
    .addIntegerOption((option) => option.setName("id").setDescription("Número do caso.").setRequired(true)),
  new SlashCommandBuilder().setName("modstats").setDescription("Consultar estatísticas de moderação.").setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName("purge").setDescription("Excluir de 1 a 100 mensagens recentes.").setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((option) => option.setName("quantidade").setDescription("Quantidade de mensagens.").setMinValue(1).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName("slowmode").setDescription("Alterar o intervalo entre mensagens.").setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption((option) => option.setName("segundos").setDescription("0 a 21.600 segundos.").setMinValue(0).setMaxValue(21600).setRequired(true)),
  new SlashCommandBuilder().setName("lock").setDescription("Bloquear envio de mensagens neste canal.").setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName("unlock").setDescription("Desbloquear este canal.").setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName("lockdown").setDescription("Bloquear temporariamente canais de texto.").setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName("unlockdown").setDescription("Restaurar permissões de lockdown.").setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  targetedCommand("nick", "Alterar ou remover o apelido de um membro.", PermissionFlagsBits.ManageNicknames, false)
    .addStringOption((option) => option.setName("apelido").setDescription("Novo apelido; deixe vazio para remover.").setMaxLength(32)),
  new SlashCommandBuilder().setName("role").setDescription("Gerenciar cargos respeitando a hierarquia.")
    .addSubcommand((sub) => sub.setName("add").setDescription("Adicionar cargo a membro.").addUserOption((option) => option.setName("membro").setDescription("Membro.").setRequired(true)).addRoleOption((option) => option.setName("cargo").setDescription("Cargo.").setRequired(true)))
    .addSubcommand((sub) => sub.setName("remove").setDescription("Remover cargo de membro.").addUserOption((option) => option.setName("membro").setDescription("Membro.").setRequired(true)).addRoleOption((option) => option.setName("cargo").setDescription("Cargo.").setRequired(true)))
    .addSubcommand((sub) => sub.setName("info").setDescription("Consultar um cargo.").addRoleOption((option) => option.setName("cargo").setDescription("Cargo.").setRequired(true))),
  new SlashCommandBuilder().setName("userinfo").setDescription("Consultar informações de um membro.").addUserOption((option) => option.setName("membro").setDescription("Membro.")),
  new SlashCommandBuilder().setName("serverinfo").setDescription("Consultar informações deste servidor."),
  new SlashCommandBuilder().setName("avatar").setDescription("Ver o avatar de um membro.").addUserOption((option) => option.setName("membro").setDescription("Membro.")),
  new SlashCommandBuilder().setName("membercount").setDescription("Consultar contagem de membros."),
);

definitions.push(
  new SlashCommandBuilder().setName("mensagem").setDescription("Pré-visualizar e confirmar uma publicação do bot.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addChannelOption((option) => option.setName("canal").setDescription("Canal de destino.").addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption((option) => option.setName("texto").setDescription("Conteúdo da mensagem.").setMaxLength(1800).setRequired(true))
    .addStringOption((option) => option.setName("titulo").setDescription("Título da embed opcional.").setMaxLength(200))
    .addStringOption((option) => option.setName("imagem").setDescription("URL HTTPS pública da imagem.").setMaxLength(500))
    .addStringOption((option) => option.setName("cor").setDescription("Cor hexadecimal da embed, por exemplo #2563eb.").setMinLength(7).setMaxLength(7))
    .addStringOption((option) => option.setName("rodape").setDescription("Texto do rodapé da embed.").setMaxLength(200))
    .addBooleanOption((option) => option.setName("usar_embed").setDescription("Enviar como embed em vez de texto simples.").setRequired(false))
    .addStringOption((option) => option.setName("link").setDescription("URL HTTPS de destino.").setMaxLength(500)),
  new SlashCommandBuilder().setName("enviardm").setDescription("Enviar uma DM confirmada a um membro que autorizou.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName("enviar").setDescription("Prévia e confirmação para um membro opt-in.")
      .addUserOption((option) => option.setName("destinatario").setDescription("Membro que ativou o recebimento de DMs.").setRequired(true))
      .addStringOption((option) => option.setName("texto").setDescription("Mensagem.").setMinLength(1).setMaxLength(1800).setRequired(true))
      .addStringOption((option) => option.setName("titulo").setDescription("Título de embed opcional.").setMaxLength(200))
      .addStringOption((option) => option.setName("imagem").setDescription("URL HTTPS pública da imagem.").setMaxLength(500)))
    .addSubcommand((sub) => sub.setName("estatisticas").setDescription("Consultar resultados de envios individuais.")),
  new SlashCommandBuilder().setName("dmoptin").setDescription("Controlar o consentimento para receber DMs de comunicados.")
    .addSubcommand((sub) => sub.setName("ativar").setDescription("Permitir DMs individuais de comunicados deste servidor."))
    .addSubcommand((sub) => sub.setName("desativar").setDescription("Remover sua autorização para futuros comunicados por DM."))
    .addSubcommand((sub) => sub.setName("status").setDescription("Consultar seu consentimento atual.")),
);

export const commandDefinitions = definitions.map((definition) =>
  definition.setContexts(InteractionContextType.Guild).toJSON(),
);

function hasAdminPermission(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

async function executeProtection(interaction) {
  if (!hasAdminPermission(interaction)) return interaction.reply({ content: "Só administradores do servidor podem alterar proteções.", ephemeral: true });
  const name = interaction.commandName;
  const key = name;
  const old = getSetting(interaction.guildId, key, {});
  const sub = interaction.options.getSubcommand();
  if (sub === "status") {
    const lines = Object.entries(old).filter(([property]) => property !== "exemptRoles" && property !== "exemptChannels" && property !== "allowedCodes")
      .map(([property, value]) => `**${property}:** ${value}`).join("\n");
    const list = name === "antiinvite" ? `\nConvites permitidos: ${(old.allowedCodes ?? []).length}` : "";
    return interaction.reply({ embeds: [makeEmbed(`${name} · ${old.enabled ? "ativo" : "inativo"}`, `${lines || "Sem parâmetros adicionais."}${list}`)], ephemeral: true });
  }
  if (sub === "ativar" || sub === "desativar") {
    const enabled = sub === "ativar";
    if (enabled && name === "antiraid" && !interaction.client.options.intents.has(GatewayIntentBits.GuildMembers)) {
      return interaction.reply({ content: "O anti-raid precisa do Server Members Intent. Habilite-o no Discord Developer Portal e defina DISCORD_ENABLE_GUILD_MEMBERS_INTENT=true no Replit antes de ativar.", ephemeral: true });
    }
    if (enabled && ["antispam", "antiinvite"].includes(name) && !interaction.client.options.intents.has(GatewayIntentBits.MessageContent)) {
      return interaction.reply({ content: "Esta proteção precisa do Message Content Intent. Habilite-o no Discord Developer Portal e defina DISCORD_ENABLE_MESSAGE_CONTENT_INTENT=true no Replit antes de ativar.", ephemeral: true });
    }
    setSetting(interaction.guildId, key, { ...old, enabled });
    await audit(interaction.guild, "configurações", `${name} ${enabled ? "ativado" : "desativado"} por ${interaction.user}.`);
    return interaction.reply({ content: `${name} ${enabled ? "ativado" : "desativado"}. A configuração persiste após reinicializações.`, ephemeral: true });
  }
  const values = { ...old, enabled: old.enabled ?? false };
  if (name === "antiraid") {
    const joins = interaction.options.getInteger("entradas");
    const window = interaction.options.getInteger("janela_segundos");
    const age = interaction.options.getInteger("idade_conta_dias");
    const recent = interaction.options.getBoolean("alertar_contas_recentes");
    const useVerification = interaction.options.getBoolean("usar_verificacao");
    const role = interaction.options.getRole("cargo_verificacao");
    const verificationMinutes = interaction.options.getInteger("tempo_verificacao_minutos");
    const channel = interaction.options.getChannel("canal_alertas");
    if (joins !== null) values.joinsThreshold = joins;
    if (window !== null) values.windowSeconds = window;
    if (age !== null) values.newAccountDays = age;
    if (recent !== null) values.alertNewAccounts = recent;
    if (useVerification !== null) values.enableVerificationRole = useVerification;
    if (role) values.verificationRoleId = role.id;
    if (verificationMinutes !== null) values.verificationMinutes = verificationMinutes;
    if (channel) values.logChannelId = channel.id;
  } else if (name === "antispam") {
    const count = interaction.options.getInteger("mensagens");
    const del = interaction.options.getBoolean("excluir_mensagens");
    const timeout = interaction.options.getBoolean("timeout");
    const minutes = interaction.options.getInteger("timeout_minutos");
    const blockInvites = interaction.options.getBoolean("bloquear_convites");
    const channel = interaction.options.getChannel("canal_excecao");
    const role = interaction.options.getRole("cargo_excecao");
    const logs = interaction.options.getChannel("canal_alertas");
    if (count !== null) values.messagesPerWindow = count;
    if (del !== null) values.deleteMessages = del;
    if (timeout !== null) values.timeoutOnSpam = timeout;
    if (minutes !== null) values.timeoutMinutes = minutes;
    if (blockInvites !== null) values.blockInvites = blockInvites;
    if (logs) values.logChannelId = logs.id;
    if (channel) values.exemptChannels = [...new Set([...(values.exemptChannels ?? []), channel.id])];
    if (role) values.exemptRoles = [...new Set([...(values.exemptRoles ?? []), role.id])];
  } else {
    const code = interaction.options.getString("codigo_autorizado");
    const del = interaction.options.getBoolean("excluir_mensagens");
    const timeout = interaction.options.getBoolean("timeout_reincidencia");
    const strikes = interaction.options.getInteger("limite_reincidencia");
    const channel = interaction.options.getChannel("canal_excecao");
    const role = interaction.options.getRole("cargo_excecao");
    const logs = interaction.options.getChannel("canal_alertas");
    if (code) {
      const cleanCode = code.trim().replace(/^.*(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)/i, "").toLowerCase();
      if (!/^[a-z0-9-]{2,64}$/.test(cleanCode)) return interaction.reply({ content: "Informe um código curto de convite, não um URL inválido.", ephemeral: true });
      values.allowedCodes = [...new Set([...(values.allowedCodes ?? []), cleanCode])];
    }
    if (del !== null) values.deleteMessages = del;
    if (timeout !== null) values.timeoutOnRepeat = timeout;
    if (strikes !== null) values.timeoutAfter = strikes;
    if (logs) values.logChannelId = logs.id;
    if (channel) values.exemptChannels = [...new Set([...(values.exemptChannels ?? []), channel.id])];
    if (role) values.exemptRoles = [...new Set([...(values.exemptRoles ?? []), role.id])];
  }
  if (sub === "configurar" && Object.keys(values).length === (old.enabled === undefined ? 1 : Object.keys(old).length)) {
    return interaction.reply({ content: "Selecione pelo menos um parâmetro para salvar.", ephemeral: true });
  }
  setSetting(interaction.guildId, key, values);
  await audit(interaction.guild, "configurações", `Parâmetros de ${name} atualizados por ${interaction.user}.`);
  return interaction.reply({ content: `Configurações de ${name} salvas. Proteção ${values.enabled ? "ativa" : "inativa"}.`, ephemeral: true });
}

async function previewPublication(interaction) {
  if (!interaction.guild || !hasAdminPermission(interaction)) return interaction.reply({ content: "Somente administradores podem publicar mensagens pelo bot.", ephemeral: true });
  const isDM = interaction.commandName === "enviardm";
  const text = interaction.options.getString("texto", true).trim();
  const title = interaction.options.getString("titulo");
  const image = interaction.options.getString("imagem");
  const link = isDM ? null : interaction.options.getString("link");
  const colorInput = isDM ? null : interaction.options.getString("cor");
  const footer = isDM ? null : interaction.options.getString("rodape");
  const useEmbed = isDM ? true : (interaction.options.getBoolean("usar_embed") ?? Boolean(title || image || link));
  if (image && !/^https:\/\//i.test(image)) return interaction.reply({ content: "A imagem precisa usar URL HTTPS.", ephemeral: true });
  if (link && !/^https:\/\//i.test(link)) return interaction.reply({ content: "O link precisa usar URL HTTPS.", ephemeral: true });
  if (colorInput && !/^#[0-9a-f]{6}$/i.test(colorInput)) return interaction.reply({ content: "Use uma cor hexadecimal como #2563eb.", ephemeral: true });
  if ((image || link || title || footer || colorInput) && !useEmbed) return interaction.reply({ content: "Banner, título, cor, rodapé e botão de link exigem uma embed.", ephemeral: true });
  const target = isDM ? interaction.options.getUser("destinatario", true) : interaction.options.getChannel("canal", true);
  if (isDM && target.bot) return interaction.reply({ content: "Não é possível enviar uma campanha para outro bot.", ephemeral: true });
  if (isDM) {
    const destinationMember = await interaction.guild.members.fetch(target.id).catch(() => null);
    const consent = getSetting(interaction.guildId, "dm-opt-ins", []);
    if (!destinationMember || !consent.includes(target.id)) {
      return interaction.reply({ content: "O destinatário precisa pertencer a este servidor e ter ativado o recebimento de comunicados por DM.", ephemeral: true });
    }
  }
  if (!isDM && !target.permissionsFor(interaction.guild.members.me)?.has(PermissionFlagsBits.SendMessages)) {
    return interaction.reply({ content: "O bot não pode enviar mensagens nesse canal.", ephemeral: true });
  }
  const id = `${interaction.user.id}:${createHash("sha1").update(`${Date.now()}${interaction.id}`).digest("hex").slice(0, 12)}`;
  pendingPublications.set(id, {
    ownerId: interaction.user.id, guildId: interaction.guildId, kind: isDM ? "dm" : "message",
    targetId: target.id, text, title: title ?? null, image: image ?? null, link: link ?? null,
    color: colorInput ?? null, footer: footer ?? null, useEmbed,
    expiresAt: Date.now() + 10 * 60_000,
  });
  const format = (value) => value?.replaceAll("{servidor}", interaction.guild.name)
    .replaceAll("{usuario}", isDM ? target.username : interaction.user.username) ?? null;
  const preview = useEmbed
    ? new EmbedBuilder().setColor(colorInput ? Number.parseInt(colorInput.slice(1), 16) : isDM ? 0x5865f2 : 0x2563eb)
      .setTitle(format(title) ?? undefined).setDescription(format(text))
      .setFooter({ text: format(footer) ?? (isDM ? `Prévia para ${target.tag}` : `Prévia para #${target.name}`) })
    : null;
  if (preview && image) preview.setImage(image);
  const content = preview ? undefined : text;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`publish:confirm:${id}`).setLabel("Confirmar envio").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`publish:cancel:${id}`).setLabel("Cancelar").setStyle(ButtonStyle.Secondary),
  );
  if (preview && link) {
    const urlButton = new ButtonBuilder().setLabel("Abrir link").setStyle(ButtonStyle.Link).setURL(link);
    await interaction.reply({ content: `Prévia pronta. Destino: ${isDM ? target.tag : target.toString()}. ${isDM ? "Somente este destinatário explícito receberá a DM." : ""}`, embeds: [preview], components: [row, new ActionRowBuilder().addComponents(urlButton)], ephemeral: true });
  } else {
    await interaction.reply({ content: `Prévia pronta. Destino: ${isDM ? target.tag : target.toString()}. ${isDM ? "Somente este destinatário explícito receberá a DM." : ""}`, embeds: preview ? [preview] : [], components: [row], ephemeral: true });
  }
}

export async function handlePublicationButton(interaction) {
  if (!interaction.customId.startsWith("publish:")) return false;
  const action = interaction.customId.startsWith("publish:confirm:") ? "confirm" : "cancel";
  const prefix = `publish:${action}:`;
  const id = interaction.customId.slice(prefix.length);
  const draft = pendingPublications.get(id);
  if (!draft || draft.expiresAt < Date.now()) {
    await interaction.update({ content: "Esta prévia expirou. Execute novamente o comando.", embeds: [], components: [] });
    return true;
  }
  if (draft.ownerId !== interaction.user.id || draft.guildId !== interaction.guildId) {
    await interaction.reply({ content: "Somente quem criou a prévia pode confirmar este envio.", ephemeral: true });
    return true;
  }
  pendingPublications.delete(id);
  if (action === "cancel") {
    await interaction.update({ content: "Envio cancelado.", embeds: [], components: [] });
    return true;
  }
  await interaction.deferUpdate();
  let sent = 0;
  let failed = 0;
  if (draft.kind === "dm") {
    const currentConsent = getSetting(draft.guildId, "dm-opt-ins", []);
    if (!currentConsent.includes(draft.targetId)) {
      await interaction.editReply({ content: "O destinatário retirou a autorização. Nenhuma DM foi enviada.", embeds: [], components: [] });
      return true;
    }
    const user = await interaction.client.users.fetch(draft.targetId).catch(() => null);
    const format = (value) => value?.replaceAll("{servidor}", interaction.guild.name)
      .replaceAll("{usuario}", user?.username ?? "membro") ?? null;
    const dmEmbed = draft.useEmbed
      ? new EmbedBuilder().setColor(draft.color ? Number.parseInt(draft.color.slice(1), 16) : 0x5865f2)
        .setTitle(format(draft.title) ?? undefined).setDescription(format(draft.text))
        .setFooter({ text: format(draft.footer) ?? interaction.guild.name })
      : null;
    if (dmEmbed && draft.image) dmEmbed.setImage(draft.image);
    const payload = dmEmbed
      ? { embeds: [dmEmbed], allowedMentions: { parse: [] } }
      : { content: format(draft.text), allowedMentions: { parse: [] } };
    const success = await user?.send(payload).then(() => true).catch(() => false);
    sent = Number(Boolean(success));
    failed = Number(!success);
    recordCampaign({ guildId: draft.guildId, actorId: draft.ownerId, kind: "dm-single", sent, failed });
    await audit(interaction.guild, "configurações", `DM individual solicitada por <@${draft.ownerId}>; resultado: ${sent ? "enviada" : "falha"}.`, { Destinatário: `<@${draft.targetId}>` });
  } else {
    const channel = await interaction.guild.channels.fetch(draft.targetId).catch(() => null);
    if (channel?.isTextBased()) {
      const format = (value) => value?.replaceAll("{servidor}", interaction.guild.name)
        .replaceAll("{usuario}", interaction.user.username) ?? null;
      const embed = draft.useEmbed
        ? new EmbedBuilder().setColor(draft.color ? Number.parseInt(draft.color.slice(1), 16) : 0x2563eb)
          .setTitle(format(draft.title) ?? undefined).setDescription(format(draft.text))
          .setFooter({ text: format(draft.footer) ?? interaction.guild.name })
        : null;
      if (embed && draft.image) embed.setImage(draft.image);
      await channel.send({
        content: embed ? undefined : draft.text,
        embeds: embed ? [embed] : [],
        components: embed && draft.link ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Saiba mais").setStyle(ButtonStyle.Link).setURL(draft.link))] : [],
        allowedMentions: { parse: [] },
      }).then(() => { sent = 1; }).catch(() => { failed = 1; });
    } else failed = 1;
    recordCampaign({ guildId: draft.guildId, actorId: draft.ownerId, kind: "channel-message", sent, failed });
    await audit(interaction.guild, "mensagens", `Mensagem de bot publicada por <@${draft.ownerId}>.`, { Destino: `<#${draft.targetId}>`, Resultado: sent ? "enviada" : "falha" });
  }
  await interaction.editReply({ content: `Envio concluído. Enviadas: ${sent} · falhas: ${failed}.`, embeds: [], components: [] });
  return true;
}

export async function handleCommand(interaction) {
  if (["antiraid", "antispam", "antiinvite"].includes(interaction.commandName)) return executeProtection(interaction);
  if (["logs"].includes(interaction.commandName)) {
    if (!hasAdminPermission(interaction)) return interaction.reply({ content: "Só administradores podem alterar os registros.", ephemeral: true });
    const action = interaction.options.getSubcommand();
    const config = getSetting(interaction.guildId, "logs", {});
    if (action === "configurar") {
      const channel = interaction.options.getChannel("canal", true);
      if (!channel.permissionsFor(interaction.guild.members.me).has(PermissionFlagsBits.SendMessages)) return interaction.reply({ content: "O bot não consegue enviar mensagens nesse canal.", ephemeral: true });
      setSetting(interaction.guildId, "logs", { ...config, channelId: channel.id });
      await audit(interaction.guild, "configurações", `Canal de logs definido por ${interaction.user}.`, { Canal: channel.toString() });
      return interaction.reply({ content: `Canal de logs configurado: ${channel}.`, ephemeral: true });
    }
    if (action === "categoria") {
      const category = interaction.options.getString("tipo", true);
      const enabled = interaction.options.getBoolean("ativada", true);
      setSetting(interaction.guildId, "logs", { ...config, categories: { ...(config.categories ?? {}), [category]: enabled } });
      return interaction.reply({ content: `Logs de **${category}** ${enabled ? "ativados" : "desativados"}.`, ephemeral: true });
    }
    return interaction.reply({ content: `Canal: ${config.channelId ? `<#${config.channelId}>` : "não configurado"}\nCategorias configuráveis: moderação, mensagens, membros, estrutura, tickets e configurações.`, ephemeral: true });
  }
  if (["ticketpainel", "ticket"].includes(interaction.commandName)) return executeTicketCommand(interaction);
  if (interaction.commandName === "dmoptin") {
    const consent = new Set(getSetting(interaction.guildId, "dm-opt-ins", []));
    const action = interaction.options.getSubcommand();
    if (action === "ativar") consent.add(interaction.user.id);
    if (action === "desativar") consent.delete(interaction.user.id);
    setSetting(interaction.guildId, "dm-opt-ins", [...consent]);
    return interaction.reply({
      content: action === "status"
        ? `Recebimento de comunicados por DM: **${consent.has(interaction.user.id) ? "ativado" : "desativado"}**.`
        : `Recebimento de comunicados por DM ${action === "ativar" ? "ativado" : "desativado"}.`,
      ephemeral: true,
    });
  }
  if (interaction.commandName === "enviardm") {
    if (interaction.options.getSubcommand() === "estatisticas") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild) && !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: "Você precisa de permissão para gerenciar o servidor.", ephemeral: true });
      }
      const stats = db.prepare(`
        SELECT COUNT(*) AS campaigns, COALESCE(SUM(sent), 0) AS sent, COALESCE(SUM(failed), 0) AS failed
        FROM campaign_runs WHERE guild_id = ? AND kind = 'dm-single'
      `).get(interaction.guildId);
      const recent = db.prepare("SELECT actor_id, sent, failed, created_at FROM campaign_runs WHERE guild_id = ? AND kind = 'dm-single' ORDER BY id DESC LIMIT 5").all(interaction.guildId);
      const detail = recent.length ? recent.map((row) => `<@${row.actor_id}> · ${row.sent} enviada(s), ${row.failed} falha(s) · <t:${Math.floor(new Date(`${row.created_at}Z`).getTime() / 1000)}:R>`).join("\n") : "Nenhum envio confirmado.";
      return interaction.reply({ embeds: [makeEmbed("Estatísticas de DMs", `Envios: **${stats.campaigns}** · entregues: **${stats.sent}** · falhas: **${stats.failed}**\n\n${detail}`)], ephemeral: true });
    }
    return previewPublication(interaction);
  }
  if (interaction.commandName === "mensagem") return previewPublication(interaction);
  return executeModeration(interaction);
}

export function clearPendingPublications() {
  const now = Date.now();
  for (const [id, draft] of pendingPublications) if (draft.expiresAt < now) pendingPublications.delete(id);
}
