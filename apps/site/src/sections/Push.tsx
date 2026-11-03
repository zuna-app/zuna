import { ArrowRight, BellRing, Server, Shuffle, Smartphone } from "lucide-react";
import { doc } from "../pages";

const STEPS = [
  { icon: Server, name: "Your server", sees: "Seals the message's IDs for your phone" },
  { icon: Shuffle, name: "zuna-push", sees: "Sees a sealed handle, a sealed payload and the time" },
  { icon: BellRing, name: "Apple", sees: "Delivers a sealed blob it can't open" },
  { icon: Smartphone, name: "Your iPhone", sees: "Fetches the message from your server and decrypts it" },
];

export function Push() {
  return (
    <section className="section" id="notifications">
      <div className="wrap">
        <div className="section-head center reveal">
          <p className="eyebrow">Notifications</p>
          <h2 className="heading">Your phone buzzes. Nobody else learns why.</h2>
          <p className="lead">
            Apple only takes pushes from whoever publishes the app, so servers wake phones through zuna-push, a small relay the project runs. A push carries
            nothing but sealed IDs.
          </p>
        </div>
        <ol className="flow reveal">
          {STEPS.map((step, index) => (
            <li key={step.name} className="flow-step">
              <span className="flow-icon">
                <step.icon size={20} aria-hidden="true" />
              </span>
              <b>{step.name}</b>
              <span>{step.sees}</span>
              {index < STEPS.length - 1 && <ArrowRight className="flow-arrow" size={16} aria-hidden="true" />}
            </li>
          ))}
        </ol>
        <div className="push-notes reveal">
          <div>
            <h3>They go where you are</h3>
            <p>While you're at your desk, your phone waits, and skips what you've already read there. Calls ring on the lock screen like any phone call.</p>
          </div>
          <div>
            <h3>What the relay does see</h3>
            <p>
              Which server woke which phone, and when, and whether it was a call. It keeps no list of devices, and never learns who wrote what.
            </p>
          </div>
          <div>
            <h3>Rather not use it?</h3>
            <p>
              A server can turn pushes off with one setting. Everything else works, and phones catch up when the app opens.{" "}
              <a href={doc("docs/PUSH_RELAY.md")}>How the relay works</a>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
