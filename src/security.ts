import { GuildBasedChannel, GuildMember, Interaction, Message } from 'discord.js'
import { asyncForEach } from './helpers'

// TODO: type these
export function isMod(message: any, userId: string) {
  let modIds = message.guild.members.cache
    .filter((u: any) => u._roles.includes(process.env.MODS_ROLE_ID))
    .map((u: any) => u.user.id)
  return modIds.includes(userId)
}

export function isSenderPatron(message: any) {
  // TODO: Lock this down once Patreon tiers are set up properly
  return true
  return message.member?.roles.cache.has(process.env.PATRON_ROLE_ID as string)
}

// TODO: type these
export async function sendModBroadcast(guild: any, messageContent: string) {
  let mods = guild.members.cache
    .filter((u: any) => u._roles.includes(process.env.MODS_ROLE_ID))

  await asyncForEach(mods, async (mod: any) => {
    await mod.send(messageContent);
  })
}

export function getMemberPermittedChannels(message: Message | Interaction) {
  return message.guild?.channels.cache
    .filter((c: GuildBasedChannel) => c.permissionsFor(message.member as GuildMember).has("ViewChannel"))
    .map((c: GuildBasedChannel) => c.id)
}