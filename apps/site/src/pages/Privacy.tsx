import { doc, REPO } from "../pages";

export function Privacy() {
  return (
    <article className="page prose">
      <div className="wrap prose-wrap">
        <p className="eyebrow">Privacy</p>
        <h1 className="display">What Zuna learns about you.</h1>
        <p className="lead">
          Very little, by design. Zuna has no central service. Your account and messages live on the server you joined, run by whoever runs it, and encrypted so
          that they can't read them. The project itself runs two things: this website, and zuna-push, the relay that wakes iPhones and iPads. Neither sees what
          you write.
        </p>
        <p className="prose-updated">Last changed on 6 November 2026.</p>

        <h2>The apps</h2>
        <p>The apps for Windows, macOS, Linux, the web, iPhone and iPad send the project nothing: no analytics, no crash reports, and no account with us.</p>
        <p>They connect to:</p>
        <ul>
          <li>The servers you join, and the media server those servers' admins run for voice and calls.</li>
          <li>On iPhone and iPad, zuna-push and Apple's push service, for notifications.</li>
          <li>
            A site you link to, when you send the link, so your device can make its preview. In the web app, the page is fetched by the web app's host, which
            your server's admins run.
          </li>
          <li>GitHub, from the signed Windows app, to check for updates every six hours.</li>
        </ul>

        <h2>Your server</h2>
        <p>
          Each server is run by its admins, not by the project. It stores your account and your messages, encrypted on your device with keys the server never
          has. It does see some things: your username, who is in each conversation, who sent a message to which conversation, when, and roughly how big, your IP
          address and your online status. The <a href={doc("SECURITY.md")}>security model</a> lists exactly what it can and can't see.
        </p>
        <p>
          You can delete your account on a server in the app's settings, with your password. The server then erases your profile, your keys and what it kept
          to sign you in, and frees your username. What you sent stays with the people you sent it to, shown as from a deleted account.
        </p>
        <p>
          If you report someone, the server keeps whom and why for its admins, but not who reported them, and nothing of what was said, which it can't read.
        </p>
        <p>How long a server keeps its logs and backups is up to its admins. For anything about your account, ask them.</p>

        <h2 id="push">zuna-push, the push relay</h2>
        <p>
          Apple only accepts pushes from whoever publishes an app, and a self-hosted server can't hold that key. So servers wake phones through zuna-push, which
          the project's maintainers run at <code>relay.zuna.chat</code>. Its code is in the{" "}
          <a href={`${REPO}/tree/main/server/internal/relay`}>repository</a>, and <a href={doc("docs/PUSH_RELAY.md")}>how it works</a> is written up in full.
        </p>
        <h3>What it receives</h3>
        <ul>
          <li>
            When your phone signs up for notifications, about once a week, its Apple push token, and where CallKit is allowed a second token for calls. It checks the
            first with Apple through a silent push with nothing in it, and hands both back sealed with its own key, as a different handle for each of your
            servers, and keeps no list of them. Servers only ever see the handles, and can't tell that theirs are for the same phone.
          </li>
          <li>When a server sends a push, a handle and a payload that the server sealed for your phone, holding nothing but a conversation's and a message's IDs.</li>
        </ul>
        <h3>What it can tell</h3>
        <p>
          Which server addresses send pushes, when, how big the sealed payloads are, which phone each push is for, and whether it's a call. It never learns who
          wrote what, or anything in a message: your phone fetches the message from your server and decrypts it itself.
        </p>
        <h3>What it keeps</h3>
        <p>
          On disk, only its own key. Its rate limits, by phone and by the address asking, and for a day the tokens Apple says don't exist, are held in memory
          and gone when it restarts.
        </p>
        <h3>Apple</h3>
        <p>
          Apple delivers each push to your phone, under <a href="https://www.apple.com/legal/privacy/">Apple's privacy policy</a>. It sees a sealed payload it
          can't open.
        </p>
        <h3>Not using it</h3>
        <p>
          A server's admins can turn pushes off, or send them through a relay of their own. Phones then see new messages when the app opens. The desktop and
          web apps don't use the relay at all.
        </p>

        <h2>This website</h2>
        <p>
          zuna.chat is a set of static pages on the maintainers' own server. It sets no cookies, runs no analytics, and makes no requests to other sites: even
          its fonts come from here. Like most web servers, the one serving it may log visitors' IP addresses. Downloads come from GitHub's releases, under the{" "}
          <a href="https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement">GitHub privacy statement</a>.
        </p>

        <h2>Changes and questions</h2>
        <p>
          This page is part of the project's repository, so every change to it is in{" "}
          <a href={`${REPO}/commits/main/apps/site/src/pages/Privacy.tsx`}>its history</a>, with a date and a reason. Questions go to the project's{" "}
          <a href={`${REPO}/issues`}>issues</a>, and anything about security to the repository's private "Report a vulnerability".
        </p>
      </div>
    </article>
  );
}
