import { Check, Minus, X } from "lucide-react";
import { Logo } from "../components/brand";

type Mark = "yes" | "partly" | "no";
type Cell = { mark?: Mark; text: string };
type Row = { what: string; zuna: Cell; matrix: Cell; fluxer: Cell };

/**
 * Matrix as Element and Synapse ship it, and Fluxer as fluxer.com and its self-hosted server do, from each project's own pages as of November 2026.
 * The page doesn't date it, so check it again when either ships something, such as MLS in Matrix, or Fluxer's encrypted calls and DMs. Behind each line:
 *
 * Matrix: Element's help says messages are "only encrypted in rooms with encryption enabled"; its encryption is Olm and Megolm, with MLS still a
 * work-in-progress proposal (MSC2883, MSC4244, MSC4256) and not in spec v1.19; Element Call is end-to-end encrypted (Element's blog, 22 October 2026),
 * with screen sharing "with audio (on some platforms, at least)"; no voice channels of Discord's kind are documented, only calls in rooms; from Element
 * Web 1.12.33 a new device has to be verified with another device or the recovery key to read encrypted history (blog, 6 November 2026); search in
 * encrypted rooms "only works on Desktop"; Synapse fetches link previews (preview_url in the spec); matrix.org needs no phone number, and email is
 * optional; files are encrypted only where messages are; Synapse's max_upload_size is 50M unless its admins change it; Element Web strips no
 * metadata (element-web #4426, open since 2017), and Element X on iPhones takes out a photo's location "by design" (element-x-ios #4706); Element
 * Desktop is "just the Electron wrapper for Element Web" (element-desktop's README), Element X on phones is native, on the Rust SDK, and Element Web
 * runs in a browser; Element Server Suite Community is a Helm chart on Kubernetes, with Synapse, its authentication service and Element Call's
 * backend; Synapse and Element are AGPL-3.0.
 *
 * Fluxer: "Nothing on Fluxer is end-to-end encrypted yet" (help, Fluxer vs Discord), and its servers "can access their content"; encrypted DMs are a
 * draft in 2026 and communities "are not part of this plan" (Roadmap 2026); "Calls on the voice system we use today aren't end-to-end encrypted", with
 * DAVE planned on a new one; voice channels hold up to 99 people; screen sharing is 720p at 30 fps free on fluxer.com and 4K at 60 with Plutonium,
 * which self-hosted servers get free; its servers fetch link previews and run search (Elasticsearch or Meilisearch); an account made with only a name
 * can't send messages until it adds an email; files are up to 25 MB, or 500 MB with Plutonium (help, Files and links; self-hosted, the same by
 * default); none of its help, its media proxy's docs or its issues says it takes metadata out of photos, and "Does Fluxer shrink my images? No.";
 * its desktop app "is built with Electron and shares its code with the web app" (help, Apps), its phone apps are Flutter, Android's in public beta
 * and iOS's not yet out, and it runs in a browser at fluxer.com/app; self-hosting is one command (rexctl, on Docker); AGPL-3.0.
 *
 * Zuna's lines are the ones the rest of the page makes, from the code: MLS in every chat and channel, encrypted voice channels and calls, the sender's
 * previews, the search index on each device, history from the server on a new device, a username and password, and deploy/install.sh. Its frame rate
 * and resolution are each the most a share can be set to, not one share doing both, and one app's sound goes with a share from the desktop apps on
 * Windows, Linux and macOS, as the Streaming section says. Files are sealed on the device, names and all; "No limits" is the maintainers' word, though a
 * server's max_upload_mb is 100 MB unless its admins raise it, to at most 100,000 MB (server/internal/api/admin.go); packages/core/src/metadata.ts takes location, camera and time out of photos and videos, on unless
 * someone turns it off in Privacy. Its native apps are claimed for the first release, on the maintainers' word: today the desktop's native app is
 * GPUI on Windows and Linux, macOS has only the Electron app, and the iPhone and iPad app isn't out (docs/SITE_PLAN.md says what's left).
 */
const GROUPS: { name: string; rows: Row[] }[] = [
  {
    name: "Privacy",
    rows: [
      {
        what: "Messages encrypted end to end",
        zuna: { mark: "yes", text: "Every chat and channel, always" },
        matrix: { mark: "partly", text: "Only where it's turned on" },
        fluxer: { mark: "no", text: "Not yet, and not planned for communities" },
      },
      {
        what: "Group encryption",
        zuna: { text: "MLS, the IETF standard" },
        matrix: { text: "Megolm, with MLS in the works" },
        fluxer: { text: "None" },
      },
      {
        what: "Voice, video and screens encrypted",
        zuna: { mark: "yes", text: "Every call and voice channel" },
        matrix: { mark: "yes", text: "In Element Call" },
        fluxer: { mark: "no", text: "Not yet" },
      },
      {
        what: "Private link previews",
        zuna: { mark: "yes", text: "Made on your device" },
        matrix: { mark: "no", text: "Fetched by your server" },
        fluxer: { mark: "no", text: "Fetched by Fluxer's servers" },
      },
      {
        what: "Private search",
        zuna: { mark: "yes", text: "Runs on your device" },
        matrix: { mark: "partly", text: "Only in the desktop app" },
        fluxer: { mark: "no", text: "Runs on the server" },
      },
    ],
  },
  {
    name: "Files",
    rows: [
      {
        what: "Files encrypted end to end",
        zuna: { mark: "yes", text: "Everything" },
        matrix: { mark: "partly", text: "Only in encrypted rooms" },
        fluxer: { mark: "no", text: "Not yet" },
      },
      {
        what: "Largest file",
        zuna: { mark: "yes", text: "No limits" },
        matrix: { mark: "yes", text: "50 MB by default" },
        fluxer: { mark: "partly", text: "25 MB, or 500 MB if you pay" },
      },
      {
        what: "Photo metadata removed",
        zuna: { mark: "yes", text: "Photos and videos, by default" },
        matrix: { mark: "partly", text: "Location only, on iPhone" },
        fluxer: { mark: "no", text: "Not documented" },
      },
    ],
  },
  {
    name: "Every day",
    rows: [
      {
        what: "Text and voice channels",
        zuna: { mark: "yes", text: "Both" },
        matrix: { mark: "partly", text: "Rooms with calls" },
        fluxer: { mark: "yes", text: "Up to 99 per voice channel" },
      },
      {
        what: "Screen sharing",
        zuna: { mark: "yes", text: "Up to 240 fps or 4K, with sound" },
        matrix: { mark: "yes", text: "Sound only on some systems" },
        fluxer: { mark: "partly", text: "720p, 4K if you pay" },
      },
      {
        what: "Whole history on a new device",
        zuna: { mark: "yes", text: "Just sign in" },
        matrix: { mark: "partly", text: "Needs another device or a recovery key" },
        fluxer: { mark: "yes", text: "Stored unencrypted" },
      },
      {
        what: "Sign up without email or phone",
        zuna: { mark: "yes", text: "Just a username and password" },
        matrix: { mark: "yes", text: "Email is optional" },
        fluxer: { mark: "partly", text: "Email required to chat" },
      },
    ],
  },
  {
    name: "Performance",
    rows: [
      {
        what: "Native desktop apps",
        zuna: { mark: "yes", text: "Rust, GPU-rendered" },
        matrix: { mark: "no", text: "Electron" },
        fluxer: { mark: "no", text: "Electron" },
      },
      {
        what: "Native phone apps",
        zuna: { mark: "yes", text: "Swift, on iPhone and iPad" },
        matrix: { mark: "yes", text: "Element X" },
        fluxer: { mark: "partly", text: "Flutter, in beta" },
      },
      {
        what: "Works in a browser",
        zuna: { mark: "yes", text: "Chrome, Firefox and Safari" },
        matrix: { mark: "yes", text: "Element Web" },
        fluxer: { mark: "yes", text: "On fluxer.com" },
      },
    ],
  },
  {
    name: "Hosting",
    rows: [
      {
        what: "Run your own server",
        zuna: { mark: "yes", text: "One command" },
        matrix: { mark: "partly", text: "Several services to set up" },
        fluxer: { mark: "yes", text: "One command, with Docker" },
      },
      {
        what: "Every feature free",
        zuna: { mark: "yes", text: "No paid tier" },
        matrix: { mark: "yes", text: "Free when self-hosted" },
        fluxer: { mark: "partly", text: "Paid extras on fluxer.com" },
      },
      {
        what: "Open source",
        zuna: { mark: "yes", text: "AGPL-3.0" },
        matrix: { mark: "yes", text: "AGPL-3.0" },
        fluxer: { mark: "yes", text: "AGPL-3.0" },
      },
    ],
  },
];

const SAYS: Record<Mark, string> = { yes: "Yes", partly: "Partly", no: "No" };
const ICONS: Record<Mark, typeof Check> = { yes: Check, partly: Minus, no: X };

function Value({ who, cell }: { who: string; cell: Cell }) {
  const Icon = cell.mark && ICONS[cell.mark];
  return (
    <td className={cell.mark ? `is-${cell.mark}` : "is-text"}>
      <span className="compare-who" aria-hidden="true">
        {who}
      </span>
      <span className="compare-value">
        {Icon && (
          <span className="compare-mark">
            <Icon size={13} strokeWidth={3} aria-hidden="true" />
            <span className="sr-only">{SAYS[cell.mark!]}: </span>
          </span>
        )}
        <span className="compare-text">{cell.text}</span>
      </span>
    </td>
  );
}

export function Compare() {
  return (
    <section className="section" id="compare">
      <div className="wrap">
        <div className="section-head center reveal">
          <p className="eyebrow">Compared</p>
          <h2 className="heading">Zuna next to Matrix and Fluxer.</h2>
          <p className="lead">
            All three are open source and run on your own server. Only Zuna encrypts every message, call and file by default, and still feels like the chat app your
            friends already use.
          </p>
        </div>
        <div className="compare reveal">
          {/* Zuna's column, lit from behind as one piece, through the rows and the groups' headings alike. */}
          <span className="compare-band" aria-hidden="true" />
          <table className="compare-table">
            <caption className="sr-only">Zuna, Matrix and Fluxer, feature by feature</caption>
            <colgroup>
              <col className="compare-col-what" />
              <col className="compare-col-zuna" />
              <col />
              <col />
            </colgroup>
            <thead>
              <tr>
                <td />
                <th scope="col" className="compare-zuna">
                  <span className="compare-name">
                    <Logo size={26} /> Zuna
                  </span>
                </th>
                <th scope="col">
                  <span className="compare-name">Matrix</span>
                  <span className="compare-sub">with Element</span>
                </th>
                <th scope="col">
                  <span className="compare-name">Fluxer</span>
                </th>
              </tr>
            </thead>
            {GROUPS.map((group) => (
              <tbody key={group.name}>
                <tr className="compare-group">
                  <th scope="colgroup" colSpan={4}>
                    {group.name}
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <tr key={row.what}>
                    <th scope="row">{row.what}</th>
                    <Value who="Zuna" cell={row.zuna} />
                    <Value who="Matrix" cell={row.matrix} />
                    <Value who="Fluxer" cell={row.fluxer} />
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
        <p className="note center">From each project's own documentation: Element and Synapse for Matrix, fluxer.com for Fluxer.</p>
      </div>
    </section>
  );
}
