import { PermissionFlagsBits } from "discord.js";
import { getSetting } from "./database.js";

export function isAdmin(member) {
  const permissions = typeof member?.has === "function" ? member : member?.permissions;
  if (typeof permissions?.has === "function") {
    return permissions.has(PermissionFlagsBits.Administrator) || permissions.has(PermissionFlagsBits.ManageGuild);
  }
  try {
    const value = BigInt(permissions ?? 0);
    return (value & PermissionFlagsBits.Administrator) !== 0n || (value & PermissionFlagsBits.ManageGuild) !== 0n;
  } catch {
    return Array.isArray(permissions)
      && (permissions.includes("Administrator") || permissions.includes("ManageGuild"));
  }
}

export function isTicketStaff(member, guildId) {
  if (isAdmin(member)) return true;
  const ticketSettings = getSetting(guildId, "tickets", {});
  const staffRoleIds = [
    ticketSettings.staffRoleId,
    ...(ticketSettings.categories ? Object.values(ticketSettings.categories).map((item) => item.staffRoleId) : []),
  ].filter(Boolean);
  const memberRoleIds = member?.roles?.cache
    ? [...member.roles.cache.keys()]
    : Array.isArray(member?.roles) ? member.roles : [];
  return memberRoleIds.some((id) => staffRoleIds.includes(id));
}

export function canModerateTarget(executor, target, botMember, guildOwnerId) {
  if (!executor || !target || !botMember) return { allowed: false, reason: "Não foi possível validar a hierarquia de cargos." };
  if (target.id === guildOwnerId) return { allowed: false, reason: "O proprietário do servidor não pode ser alvo desta ação." };
  if (target.id === executor.id && executor.id !== guildOwnerId) return { allowed: false, reason: "Você não pode aplicar esta ação a si mesmo." };
  if (target.id === botMember.id) return { allowed: false, reason: "O bot não pode ser alvo desta ação." };
  if (executor.id !== guildOwnerId && target.roles.highest.comparePositionTo(executor.roles.highest) >= 0) {
    return { allowed: false, reason: "O cargo do alvo precisa estar abaixo do seu cargo mais alto." };
  }
  if (target.roles.highest.comparePositionTo(botMember.roles.highest) >= 0) {
    return { allowed: false, reason: "O cargo do alvo precisa estar abaixo do cargo mais alto do bot." };
  }
  return { allowed: true, reason: "" };
}
