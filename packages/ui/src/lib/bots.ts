// What the interface needs to know about bots: who may add one, which are in a chat,
// and the words it says once before one is added.

import type { BotCommand, ConversationView, UserView } from "@zuna/core";

/**
 * Whether someone may add a bot to a group: its owner always, and for a listed bot
 * whoever its owner chose. The server holds everyone to it, and the bot itself does too.
 */
export function mayAddBot(user: UserView, selfId: string | undefined, serverAdmin: boolean): boolean {
  const bot = user.bot;
  if (!bot) return true;
  return bot.ownerId === selfId || (bot.listed && (bot.add === "anyone" || (bot.add === "admins" && serverAdmin)));
}

/** The bots in a chat: the one a direct message is with, or the ones among a group's or channel's members. */
export function botsIn(conversation: ConversationView, users: Record<string, UserView>): UserView[] {
  const ids = conversation.kind === "dm" ? (conversation.peerId ? [conversation.peerId] : []) : conversation.members.map((member) => member.userId);
  return ids.map((id) => users[id]).filter((user): user is UserView => !!user?.bot && !user.deleted && !user.banned);
}

export interface OfferedCommand extends BotCommand {
  bot: UserView;
  /** What picking it writes: the command, and whose it is where more than one bot could answer. */
  insert: string;
}

/** The commands a chat's bots answer to, for what's typed after the "/". */
export function commandsFor(conversation: ConversationView, users: Record<string, UserView>, typed: string): OfferedCommand[] {
  const bots = botsIn(conversation, users);
  const offered: OfferedCommand[] = [];
  for (const bot of bots) {
    for (const command of bot.commands) {
      if (!command.command.startsWith(typed)) continue;
      offered.push({ ...command, bot, insert: `/${command.command}${bots.length > 1 ? `@${bot.username}` : ""} ` });
    }
  }
  return offered;
}

/** What someone is told before they add a bot to a group. */
export const BOT_READS = "A bot is a program. It reads everything said here from now on, on whichever machine runs it, and gets nothing from before.";
