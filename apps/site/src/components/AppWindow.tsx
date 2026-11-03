import { Bookmark, ChevronDown, Hash, Lock, Mic, Paperclip, Pin, Search, Send, Settings, Smile, SquarePen, Users, Volume2 } from "lucide-react";

/**
 * The desktop app, drawn with its own colors so it's sharp at any size and takes the accent switcher.
 * It follows the layout of packages/ui: the server rail, the conversation list, the open chat.
 */
export function AppWindow() {
  return (
    <div className="app-window" aria-hidden="true">
      <div className="aw-titlebar">
        <span className="aw-titlebar-icon">Z</span>
        Zuna
      </div>
      <div className="aw-body">
        <div className="aw-rail">
          <span className="aw-server is-active">F</span>
          <span className="aw-server aw-server-b">LN</span>
          <span className="aw-server aw-server-c">
            DV<i className="aw-rail-badge">4</i>
          </span>
          <span className="aw-rail-add">+</span>
          <span className="aw-rail-spacer" />
          <Settings size={16} className="aw-rail-icon" />
          <span className="aw-avatar aw-avatar-you aw-avatar-sm">AR</span>
        </div>

        <div className="aw-sidebar">
          <div className="aw-sidebar-head">
            <span>
              Friends <ChevronDown size={13} />
            </span>
            <SquarePen size={15} />
          </div>
          <div className="aw-search">
            <Search size={13} /> Search
          </div>
          <div className="aw-tabs">
            <span className="is-active">All</span>
            <span>People</span>
            <span>Groups</span>
            <span>Channels</span>
          </div>
          <div className="aw-heading">
            <ChevronDown size={11} /> Channels
          </div>
          <div className="aw-channel is-unread">
            <Hash size={15} /> general
          </div>
          <div className="aw-channel">
            <Volume2 size={15} /> Lounge
          </div>
          <div className="aw-voice-member is-speaking">
            <span className="aw-avatar aw-avatar-xs aw-c2">PN</span> Priya Nair
          </div>
          <div className="aw-voice-member">
            <span className="aw-avatar aw-avatar-xs aw-c4">MK</span> Marek Kowalski
          </div>
          <div className="aw-heading">
            <ChevronDown size={11} /> Chats
          </div>
          <Row initials="WT" name="Weekend trip" text="Jordan: Love it. I'll bring coffee too" time="7:21 PM" tone="aw-c1" active group />
          <Row initials="PN" name="Priya Nair" text="Can you check config.yaml when…" time="7:18 PM" tone="aw-c2" badge={1} online />
          <Row initials="JB" name="Jordan Blake" text="Here's the retry logic: [code]" time="7:02 PM" tone="aw-c3" online />
          <Row initials="SC" name="Sam Chen" text="(7TV) peepoHappy" time="6:47 PM" tone="aw-c5" badge={3} online />
          <div className="aw-row">
            <span className="aw-avatar aw-saved">
              <Bookmark size={15} />
            </span>
            <span className="aw-row-main">
              <span className="aw-row-name">Saved messages</span>
              <span className="aw-row-text">Notes to yourself</span>
            </span>
          </div>
        </div>

        <div className="aw-chat">
          <div className="aw-chat-head">
            <span className="aw-avatar aw-c1">WT</span>
            <span className="aw-chat-title">
              <b>Weekend trip</b>
              <span>5 members, 5 online</span>
            </span>
            <span className="aw-chat-tools">
              <Search size={16} />
              <Pin size={16} />
              <Users size={16} />
            </span>
          </div>
          <div className="aw-messages">
            <span className="aw-day">Today</span>
            <Message initials="SC" name="Sam Chen" tone="aw-c5" text="Okay so who's bringing what?" time="7:14 PM" reactions={["🔥 2", "😄 1"]} />
            <Message initials="JB" name="Jordan Blake" tone="aw-c3" text="I can drive. Leaving around 9?" time="7:15 PM" />
            <Message initials="PN" name="Priya Nair" tone="aw-c2" text="Works for me. I'll sort out the food." time="7:16 PM" />
            <Message initials="MK" name="Marek Kowalski" tone="aw-c4" text="I'll bring the tent and the speaker 🎶" time="7:18 PM" />
            <div className="aw-msg aw-msg-own">
              <div className="aw-bubble aw-bubble-own">
                Booking the campsite by the lake now
                <span className="aw-time">
                  7:20 PM <span className="aw-ticks">✓✓</span>
                </span>
              </div>
            </div>
            <div className="aw-typing">
              <span className="aw-dots">
                <i />
                <i />
                <i />
              </span>
              Jordan is typing
            </div>
            <div className="aw-msg aw-msg-last">
              <span className="aw-avatar aw-c3">JB</span>
              <div className="aw-bubble">
                <span className="aw-name aw-c3-text">Jordan Blake</span>
                <span className="aw-quote">
                  <b>You</b>
                  Booking the campsite by the lake now
                </span>
                Love it. I'll bring coffee too ☕<span className="aw-time">7:21 PM</span>
              </div>
            </div>
          </div>
          <div className="aw-composer">
            <Paperclip size={17} />
            <span className="aw-composer-text">Message Weekend trip</span>
            <Lock size={13} className="aw-composer-lock" />
            <Smile size={17} />
            <Mic size={17} />
            <Send size={17} className="aw-send" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Row(props: { initials: string; name: string; text: string; time: string; tone: string; active?: boolean; group?: boolean; badge?: number; online?: boolean }) {
  return (
    <div className={`aw-row ${props.active ? "is-active" : ""}`}>
      <span className={`aw-avatar ${props.tone}`}>
        {props.initials}
        {props.online && <i className="aw-online" />}
      </span>
      <span className="aw-row-main">
        <span className="aw-row-name">
          {props.group && <Users size={12} />}
          {props.name}
          <span className="aw-row-time">{props.time}</span>
        </span>
        <span className="aw-row-text">
          <span className="aw-ellipsis">{props.text}</span>
          {props.badge && <i className="aw-badge">{props.badge}</i>}
        </span>
      </span>
    </div>
  );
}

function Message(props: { initials: string; name: string; tone: string; text: string; time: string; reactions?: string[] }) {
  return (
    <div className="aw-msg">
      <span className={`aw-avatar ${props.tone}`}>{props.initials}</span>
      <div className="aw-bubble">
        <span className={`aw-name ${props.tone}-text`}>{props.name}</span>
        {props.text}
        <span className="aw-time">{props.time}</span>
        {props.reactions && (
          <span className="aw-reactions">
            {props.reactions.map((reaction) => (
              <span key={reaction}>{reaction}</span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
