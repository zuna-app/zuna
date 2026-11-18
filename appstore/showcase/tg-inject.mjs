// Made-up Telegram chats for the screenshots, fed to the app's core as TDLib updates over the control
// channel. They never reach TDLib or the account, and are gone when the app restarts.
import { readFileSync } from "node:fs";
const files = readFileSync(process.argv[2], "utf8").trim();
const self = 5002099240;
const now = Math.floor(Date.now() / 1000);
const min = 60, hour = 3600, day = 86400;
const mid = (n) => n * 1048576;
let fileId = 9100;
const map = {};
const photo = (name) => {
  const id = ++fileId;
  map[id] = `${files}/${name}.png`;
  return { "@type": "chatPhotoInfo", small: { "@type": "file", id, size: 0, expected_size: 0, local: { "@type": "localFile", path: "", is_downloading_completed: false }, remote: { "@type": "remoteFile", id: "", unique_id: "", is_uploading_completed: true } }, big: null, has_animation: false, is_personal: false };
};
const users = [
  [7001, "Mom", "", "tg_mom"],
  [7002, "Ola", "Zielińska", "tg_ola"],
  [7003, "Anna", "Kowalczyk", "tg_anna"],
  [7004, "Tomek", "Lis", "tg_tomek"],
  [7005, "Jakub", "Nowak", "tg_jakub"],
  [7006, "Kasia", "Wiśniewska", "tg_kasia"],
];
const updates = [];
for (const [id, first, last] of users) {
  updates.push({ "@type": "updateUser", user: { "@type": "user", id, first_name: first, last_name: last, usernames: null, phone_number: "", status: { "@type": "userStatusRecently" }, profile_photo: null, type: { "@type": "userTypeRegular" }, is_contact: true } });
}
const text = (t) => ({ "@type": "messageText", text: { "@type": "formattedText", text: t, entities: [] } });
const message = (chat, n, from, date, content) => ({ "@type": "message", id: mid(n), chat_id: chat, sender_id: { "@type": "messageSenderUser", user_id: from }, date, is_outgoing: from === self, content });
const chat = ({ id, title, type, avatar, last, unread = 0, readOut = 0, pinned = false }) => ({
  "@type": "chat", id, type, title, photo: avatar ? photo(avatar) : null,
  positions: [{ "@type": "chatPosition", list: { "@type": "chatListMain" }, order: String((BigInt(last.date) << 32n) + BigInt(Math.abs(id))), is_pinned: pinned }],
  last_message: last, unread_count: unread, unread_mention_count: 0, last_read_inbox_message_id: unread ? 0 : last.id, last_read_outbox_message_id: readOut,
  notification_settings: { "@type": "chatNotificationSettings", use_default_mute_for: true, mute_for: 0 }, is_marked_as_unread: false, message_auto_delete_time: 0, draft_message: null, block_list: null,
});
const dm = (user) => ({ "@type": "chatTypePrivate", user_id: user });
const group = (id) => ({ "@type": "chatTypeBasicGroup", basic_group_id: id });
const chats = [
  chat({ id: 7001, title: "Mom", type: dm(7001), avatar: "avatar-tg_mom", unread: 2, last: message(7001, 41, 7001, now - 9 * min, text("Call me when you land ❤️")) }),
  chat({ id: -9201, title: "Climbing club 🧗", type: group(9201), avatar: "photo-ridge", unread: 5, last: message(-9201, 812, 7002, now - 26 * min, text("Wall's open till 10 tonight, who's in?")) }),
  chat({ id: 7003, title: "Anna Kowalczyk", type: dm(7003), avatar: "avatar-tg_anna", readOut: mid(230), last: message(7003, 230, self, now - 72 * min, text("Sending the slides in 5")) }),
  chat({ id: -9202, title: "Game jam crew", type: group(9202), avatar: "icon-pixel", last: message(-9202, 1544, 7004, now - 3 * hour - 12 * min, text("New build is up, the jump finally feels right 🎮")) }),
  chat({ id: 7005, title: "Jakub Nowak", type: dm(7005), avatar: "avatar-tg_jakub", last: message(7005, 97, 7005, now - day - 2 * hour, text("See you at 7 then!")) }),
  chat({ id: 7006, title: "Kasia Wiśniewska", type: dm(7006), avatar: "avatar-tg_kasia", readOut: mid(64), last: message(7006, 64, self, now - day - 5 * hour, text("Thank you so much, it was perfect 🙏")) }),
  chat({ id: 7004, title: "Tomek Lis", type: dm(7004), avatar: "avatar-tg_tomek", last: message(7004, 120, 7004, now - 2 * day - 3 * hour, text("😂😂 I can't believe that worked")) }),
];
for (const c of chats) updates.push({ "@type": "updateNewChat", chat: c });

const script = `(function(){ try {
const s = __zunaTest.client().telegramSession;
const map = ${JSON.stringify(map)};
if (!s.__showcaseOriginal) s.__showcaseOriginal = s.downloadFile.bind(s);
s.downloadFile = async (ref) => {
  const m = /^tg:(\\d+)/.exec(ref.fileId);
  const path = m && map[m[1]];
  return path ? s.adapter.file(path, "image/png") : s.__showcaseOriginal(ref);
};
for (const update of ${JSON.stringify(updates)}) s.onUpdate(update);
return "fed " + ${updates.length} + ", chats " + s.chats.size;
} catch (e) { return "error: " + e.message + " " + e.stack; } })()`;
process.stdout.write(script);
