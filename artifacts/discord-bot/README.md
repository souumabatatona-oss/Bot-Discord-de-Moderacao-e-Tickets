# Bot Discord de Moderação e Atendimento

Bot em JavaScript com discord.js v14, comandos slash em português, SQLite persistente e controles de permissão por servidor.

## Requisitos

- Node.js 24 e pnpm.
- Um aplicativo e bot criados no [Discord Developer Portal](https://discord.com/developers/applications).
- O bot convidado ao servidor em que será usado.

## Credenciais

Guarde `DISCORD_BOT_TOKEN` em **Tools → Secrets** no Replit. Não cole o token no chat, em arquivos versionados ou em logs. `DISCORD_APPLICATION_ID`, `DISCORD_DEV_GUILD_ID` e `BOT_DATABASE_PATH` são opcionais; exemplos estão em `.env.example`.

Se `DISCORD_DEV_GUILD_ID` estiver definido antes do primeiro início, os comandos serão registrados nesse servidor de desenvolvimento e ficarão disponíveis mais rápido. Sem ele, são registrados globalmente e o Discord pode levar algum tempo para propagá-los.

## Configurar no Discord

1. No Developer Portal, crie uma aplicação e, na seção **Bot**, crie o bot.
2. Em **Bot → Privileged Gateway Intents**, habilite **Server Members Intent** e **Message Content Intent**. Os dois são necessários, respectivamente, para detectar entradas e inspecionar mensagens. Alguns aplicativos precisam de aprovação do Discord para usar esses intents privilegiados.
3. Em **OAuth2 → URL Generator**, marque os escopos `bot` e `applications.commands`.
4. Conceda somente as permissões necessárias: **View Channels**, **Send Messages**, **Embed Links**, **Attach Files**, **Read Message History**, **Manage Messages**, **Manage Channels**, **Manage Roles**, **Ban Members**, **Kick Members**, **Moderate Members** e **View Audit Log**. Não conceda `Administrator` ao próprio bot se os cargos e as permissões específicas bastarem.
5. Abra a URL gerada, escolha o servidor que você administra e autorize o bot.
6. Mova o cargo do bot acima dos cargos que ele precisa moderar ou gerenciar, mas abaixo dos administradores humanos.
7. Salve o token do bot em Replit Secrets como `DISCORD_BOT_TOKEN`. Em **Tools → Secrets**, defina `DISCORD_ENABLE_GUILD_MEMBERS_INTENT=true` e `DISCORD_ENABLE_MESSAGE_CONTENT_INTENT=true` depois de habilitá-los no Developer Portal; reinicie o workflow **Discord Bot**.

Permissões continuam sujeitas à hierarquia e às permissões do servidor. Mesmo com uma permissão configurada no portal, o bot não consegue agir sobre um cargo acima do próprio cargo mais alto.

## Executar

No Replit, o workflow **Discord Bot** mantém a conexão enquanto o processo estiver em execução:

```bash
pnpm --filter @workspace/discord-bot run dev
```

Os dados ficam em `artifacts/discord-bot/data/moderation.sqlite`; o banco usa WAL para resistir a reinícios normais. Para escolher outro local, defina `BOT_DATABASE_PATH` como uma variável não secreta. Faça cópias de segurança do arquivo e de seus arquivos `-wal`/`-shm` apenas com o processo parado.

Sem os dois intents privilegiados, o bot ainda conecta e aceita os comandos que não precisam ler mensagens ou eventos de membros. O log de inicialização avisa quais recursos estão pausados; os comandos de ativação recusam proteger um servidor nesse modo.

Comandos locais de verificação:

```bash
pnpm --filter @workspace/discord-bot run check
pnpm --filter @workspace/discord-bot test
pnpm run typecheck
```

## Comandos implementados

### Proteções

- `/antiraid`: ativar, desativar, consultar e configurar limite/janela, alertas para contas novas e cargo de verificação temporário durante picos. A idade da conta sozinha nunca causa punição.
- `/antispam`: frequência, repetição, menções, remoção, timeout, exceções de canal/cargo e alertas.
- `/antiinvite`: convites não autorizados, códigos permitidos, reincidência, remoção, timeout, exceções e alertas.

As configurações são separadas por servidor e persistem no SQLite. A análise em tempo real trabalha enquanto o bot está conectado. Se uma mensagem suspeita exigir uma ação, o bot tenta executá-la e registra o resultado; permissões ausentes não são tratadas como sucesso.

### Tickets

- `/ticketpainel publicar`: publicar o painel com as três categorias, título, instruções, banner, limite de tickets por pessoa, prazo para reabertura, cargo geral e canal de transcrições.
- `/ticketpainel configurar`: escolher a categoria de canais, cargo atendente, nome, descrição, mensagem inicial e ativar/desativar cada categoria.
- `/ticket`: assumir pelo botão do ticket; renomear, marcar equipe, fechar com confirmação, enviar DM e adicionar observação interna; além de adicionar/remover participantes, transferir, priorizar, marcar pendente, reabrir, arquivar, consultar estatísticas e histórico.

Canais são privados por padrão. O encerramento gera uma transcrição em texto, envia-a aos destinos configurados quando disponíveis e mantém o canal fechado para consulta. Falha ao entregar uma DM ou transcrição não apaga o ticket.

### Moderação e informações

`/ban`, `/unban`, `/kick`, `/timeout`, `/untimeout`, `/mute`, `/warn`, `/warnings`, `/clearwarns`, `/softban`, `/tempban`, `/tempmute`, `/purge`, `/slowmode`, `/lock`, `/unlock`, `/lockdown`, `/unlockdown`, `/nick`, `/role`, `/userinfo`, `/serverinfo`, `/avatar`, `/membercount`, `/modstats`, `/case`, `/history`, `/unwarn` e `/reason`.

Punições criam casos persistentes. Banimentos temporários e timeouts com prazo registrado são reavaliados depois de reinícios. O bloqueio de emergência exige confirmação, salva as permissões anteriores e oferece `/unlockdown` para restaurá-las.

### Logs e publicação

- `/logs`: escolher canal, ativar/desativar categorias e consultar configuração.
- `/mensagem`: visualizar e confirmar uma publicação para canal; escolher texto ou embed, título, cor, rodapé, banner e botão com link; suporta `{servidor}` e `{usuario}`.
- `/dmoptin ativar|desativar|status`: cada membro controla se aceita comunicados individuais por DM.
- `/enviardm enviar`: prévia e confirmação para **um membro do servidor que ativou o opt-in**. A autorização é verificada novamente ao confirmar. `/enviardm estatisticas` resume entregas e falhas.
- DMs usam embed com título/imagem opcionais e não criam campanhas em massa: o bot não varre membros, não envia para vários servidores e não tenta contornar bloqueios ou limites de DMs.

Registros observáveis incluem moderação, mensagens editadas/excluídas, membros, canais, cargos, tickets e alterações administrativas. Quando os registros de auditoria do Discord permitem atribuição confiável, o bot tenta identificar o autor; em caso contrário, indica que o autor é desconhecido.

## Privacidade e limites conhecidos

- Os convites, o conteúdo de mensagens, os eventos e a hierarquia de cargos são limitados pelos intents, permissões e dados que a API do Discord disponibiliza para o bot.
- O intent privilegiado `Message Content Intent` precisa de habilitação explícita no portal e, conforme o tamanho/uso do bot, pode exigir aprovação do Discord.
- DMs podem falhar se o destinatário desativou mensagens diretas ou bloqueou o bot. O bot não tenta contornar essa configuração.
- O Discord não expõe o autor de todos os eventos administrativos com certeza. O canal de logs informa quando a autoria não pôde ser determinada.
- A janela recente de mensagens e a janela de entradas são mantidas em memória e reiniciam com o processo; configurações, casos, tickets e prazos agendados ficam persistidos.
- Proteções podem alertar e registrar entradas suspeitas mesmo quando o bot não tem permissão suficiente para remover conteúdo ou aplicar cargos/timeouts. Revise as permissões mostradas no Discord.
- Este projeto registra DMs somente quando um administrador confirma um envio individual a um usuário escolhido. Campanhas em massa e contato com membros que não esperam a mensagem não estão habilitados.

## O que ainda não está implementado

O briefing original pede recursos além desta primeira entrega. Ainda faltam: fluxo de avaliação pós-ticket e avisos automáticos de inatividade; filtros para excluir exceções individuais e relatórios detalhados para todos os tipos de log; e alternativas de distribuição de comunicados para públicos consentidos em lote, com lista de exclusão e relatórios detalhados. A entrega atual intencionalmente limita cada DM a um membro escolhido que ativou o opt-in.
