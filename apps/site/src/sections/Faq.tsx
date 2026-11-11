import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { DownloadButton, HostButton } from "../components/Download";
import { doc } from "../pages";

const QUESTIONS: { q: string; a: ReactNode }[] = [
  {
    q: "Can whoever runs the server read my messages?",
    a: "No. Messages, files, reactions, group names and link previews are encrypted on your device before they're sent, with keys the server never has. That holds whoever runs it.",
  },
  {
    q: "So what can they see?",
    a: (
      <>
        Who you talk to and when: who's in each conversation, when a message was sent to which, and roughly how big it was. It isn't told who in a conversation
        sent each message, though one set on finding out can often tell from addresses and timing. Also usernames, IP addresses and online status. The <a href={doc("SECURITY.md")}>security model</a> lists all of it.
      </>
    ),
  },
  {
    q: "Do I need my own server?",
    a: "Someone does. If a friend already runs one, all you need is their invite link. If not, one of you can host it on any small Linux machine with a domain.",
  },
  {
    q: "Is it really free?",
    a: "Yes. Zuna is open source under the AGPL-3.0, with no paid tier and no company behind it selling anything. Hosting costs whatever your server costs.",
  },
  {
    q: "Has it been audited?",
    a: "The MLS library at its core, OpenMLS, has been independently audited, though the post-quantum code it now uses is newer than that audit. Zuna's own code, including how it uses that library, hasn't been yet. It's on the roadmap, and we'd rather say so than let you assume.",
  },
  {
    q: "Do I need a phone number?",
    a: "No. A name and a password are all an account needs, and nobody asks for your ID or your face.",
  },
  {
    q: "What if I forget my password?",
    a: "At sign-up you get a recovery key. With it you can set a new password. Without either, and with no device still signed in, nobody can get your messages back, not even your server's admins.",
  },
  {
    q: "How many people can a server hold?",
    a: "A few hundred active people, with its built-in database. A larger one can keep its data in PostgreSQL instead.",
  },
  {
    q: "Can I use it without the push relay?",
    a: "Yes. A server can turn pushes off, and phones then see new messages when the app opens. Desktop and web apps don't use the relay at all.",
  },
  {
    q: "When is Android coming?",
    a: (
      <>
        It's planned, with the same core and crypto as the iPhone app. The <a href={doc("docs/ROADMAP.md")}>roadmap</a> says how.
      </>
    ),
  },
];

export function Faq() {
  return (
    <section className="section" id="faq">
      <div className="wrap faq">
        <div className="section-head reveal">
          <p className="eyebrow">Questions</p>
          <h2 className="heading">Fair questions.</h2>
        </div>
        <div className="faq-list reveal">
          {QUESTIONS.map((item) => (
            <details key={item.q}>
              <summary>
                {item.q}
                <ChevronDown size={18} aria-hidden="true" />
              </summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function FinalCall() {
  return (
    <section className="final">
      <div className="final-light" aria-hidden="true" />
      <div className="wrap final-inner reveal">
        <h2 className="display final-heading">Stop renting your group chat.</h2>
        <p className="lead">Bring your friends, keep your history, and let nobody else read along.</p>
        <div className="actions">
          <DownloadButton />
          <HostButton />
        </div>
      </div>
    </section>
  );
}
