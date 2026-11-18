// Made-up history for the Mom chat on the iPad, answered in the core's place for getChatHistory alone.
// Never reaches TDLib.
const self = 5002099240;
const at = (h, m) => Math.floor(new Date(2026, 10, 18, h, m).getTime() / 1000);
const mid = (n) => n * 1048576;
const text = (t) => ({ "@type": "messageText", text: { "@type": "formattedText", text: t, entities: [] } });
const msg = (n, from, date, t) => ({ "@type": "message", id: mid(n), chat_id: 7001, sender_id: { "@type": "messageSenderUser", user_id: from }, date, is_outgoing: from === self, content: text(t) });
const mom = 7001;
const yesterday = (h, m) => Math.floor(new Date(2026, 10, 17, h, m).getTime() / 1000);
const history = [
  msg(30, mom, yesterday(19, 2), "Are you coming for lunch on Sunday?"),
  msg(31, self, yesterday(19, 10), "Yes! I'll bring dessert 🍰"),
  msg(32, mom, yesterday(19, 11), "Grandma will be so happy 🥰"),
  msg(33, mom, yesterday(19, 12), "Don't forget your passport tomorrow"),
  msg(34, self, yesterday(19, 20), "Already packed 👍"),
  msg(35, mom, at(11, 48), "Did you pack the warm jacket? 🧥"),
  msg(36, self, at(11, 50), "Yes mom, and the gloves 😄"),
  msg(37, mom, at(11, 51), "What time is your flight?"),
  msg(38, self, at(11, 53), "Boarding at 12:40 ✈️"),
  msg(39, self, at(12, 25), "At the gate now, all good"),
  msg(40, mom, at(12, 27), "Have a safe flight, sweetheart"),
  msg(41, mom, at(12, 28), "Call me when you land ❤️"),
];
const script = `(function(){ try {
const s = __zunaTest.client().telegramSession;
const history = ${JSON.stringify(history)};
if (!s.engine.__showcaseRequest) s.engine.__showcaseRequest = s.engine.request.bind(s.engine);
s.engine.request = async (q) => {
  if (q && q["@type"] === "getChatHistory" && Number(q.chat_id) === 7001) {
    const from = Number(q.from_message_id) || Infinity;
    const page = history.filter((m) => m.id <= from).sort((a, b) => b.id - a.id).slice(0, q.limit || 50);
    return { "@type": "messages", total_count: page.length, messages: page };
  }
  if (q && ["openChat", "closeChat", "viewMessages"].includes(q["@type"])) return { "@type": "ok" };
  return s.engine.__showcaseRequest(q);
};
s.onUpdate({ "@type": "updateChatReadInbox", chat_id: 7001, last_read_inbox_message_id: 40894464, unread_count: 2 });
return "history ready";
} catch (e) { return "error: " + e.message; } })()`;
process.stdout.write(script);
