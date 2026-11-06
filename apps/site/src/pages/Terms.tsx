import { REPO } from "../pages";

export function Terms() {
  return (
    <article className="page prose">
      <div className="wrap prose-wrap">
        <p className="eyebrow">Terms of use</p>
        <h1 className="display">The rules for using Zuna.</h1>
        <p className="lead">
          You agree to these when you create an account in a Zuna app. They're short, because the project runs no service of its own: each server is run by
          the people who host it.
        </p>
        <p className="prose-updated">Last changed on 6 November 2026.</p>

        <h2>Who's who</h2>
        <p>
          Zuna is free software, made by the project's maintainers. Your account and your messages live on the server you joined, run by its owner and its
          admins, not by the project. The project can't read your messages, and it can't remove anything from a server it doesn't run.
        </p>

        <h2>What you can't post</h2>
        <p>There is no tolerance for objectionable content or abusive users. Don't use Zuna to send or share:</p>
        <ul>
          <li>Anything illegal where you or the server are, and above all anything that sexualizes or endangers children.</li>
          <li>Harassment, threats, or encouraging anyone to hurt themselves or others.</li>
          <li>Hate against people for who they are.</li>
          <li>Sexual images of anyone without their consent.</li>
          <li>Spam, scams, or malware.</li>
          <li>Anything that pretends to be someone it isn't.</li>
        </ul>

        <h2>What happens if someone does</h2>
        <p>
          You can block anyone, and report them to the server's admins from the bottom of their profile. Messages are end-to-end encrypted, so a report says
          whom and why, never what was said. A server's admins can ban anyone who breaks these rules, which signs them out everywhere and takes them out of
          every conversation.
        </p>

        <h2>If you run a server</h2>
        <p>
          You're responsible for your server and the people on it. By running one, you agree to look at reports within 24 hours, and to ban anyone who breaks
          these rules.
        </p>

        <h2>Who can use it</h2>
        <p>You have to be at least 13, or older if the law where you live says so.</p>

        <h2>No warranty</h2>
        <p>
          Zuna is free software under the <a href={`${REPO}/blob/main/LICENSE`}>GNU Affero General Public License</a>, and comes without any warranty. The
          project isn't responsible for what happens on servers it doesn't run, or for what people send there.
        </p>

        <h2>Changes and questions</h2>
        <p>
          This page is part of the project's repository, so every change to it is in{" "}
          <a href={`${REPO}/commits/main/apps/site/src/pages/Terms.tsx`}>its history</a>, with a date and a reason. Questions go to the project's{" "}
          <a href={`${REPO}/issues`}>issues</a>, and anything about your account to your server's admins, as the <a href="/support/">support page</a> says.
        </p>
      </div>
    </article>
  );
}
