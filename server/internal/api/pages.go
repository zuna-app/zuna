package api

import (
	"bytes"
	"html/template"
	"net/http"
)

// Small pages for people opening a link in a normal browser. They never ask for
// passwords or keys: all of that happens inside the app.

var pageTemplate = template.Must(template.New("page").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>{{.Title}}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #ececee; background: #0f0f11;
  }
  main { width: 100%; max-width: 380px; text-align: center; }
  .icon { width: 64px; height: 64px; border-radius: 16px; margin: 0 auto 18px; display: grid; place-items: center;
    background: #232326; font-size: 28px; font-weight: 600; color: #ececee; object-fit: cover; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 6px; }
  p { margin: 0 0 22px; color: #a0a0a6; }
  a.button, button { display: block; width: 100%; padding: 11px 16px; border-radius: 8px; border: 0;
    font: inherit; font-weight: 500; cursor: pointer; text-decoration: none; margin-top: 8px; }
  .primary { background: #ececee; color: #111113; }
  .secondary { background: #232326; color: #ececee; }
  small { display: block; margin-top: 18px; color: #6e6e75; }
</style>
</head>
<body>
<main>
  {{if .HasIcon}}<img class="icon" src="/api/icon" alt="">{{else}}<div class="icon">Z</div>{{end}}
  <h1>{{.Heading}}</h1>
  <p>{{.Body}}</p>
  {{if .Invite}}
  <a class="button primary" id="open" href="#">Open in Zuna</a>
  <button class="secondary" id="copy">Copy invite link</button>
  <a class="button secondary" href="{{.OfficialURL}}" rel="noreferrer">Download Zuna</a>
  {{if .DownloadURL}}<a class="button secondary" href="{{.DownloadURL}}" rel="noreferrer">Download from this server's link</a>{{end}}
  <small>Don't have the app yet? Install it, then paste this link into it. Only the official download is published by the Zuna project.</small>
  <script>
    // The part of the link after # holds the server's community key. Browsers
    // don't send it to the server, and this page only passes it on to the app.
    var link = location.href;
    var open = "zuna://join?link=" + encodeURIComponent(link);
    document.getElementById("open").href = open;
    document.getElementById("copy").onclick = function () {
      navigator.clipboard.writeText(link);
      this.textContent = "Copied";
    };
  </script>
  {{end}}
</main>
</body>
</html>
`))

// officialDownloads is where the project publishes the app, whatever a server's
// operator chooses to link to as well.
const officialDownloads = "https://github.com/SocketByte/zuna-chat/releases"

type pageData struct {
	Title       string
	Heading     string
	Body        string
	HasIcon     bool
	Invite      bool
	OfficialURL string
	DownloadURL string
}

func (s *Server) renderPage(w http.ResponseWriter, status int, data pageData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy",
		"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	w.Header().Set("X-Frame-Options", "DENY")
	// Rendered whole before anything is sent, so that a failure can still answer with an error.
	var page bytes.Buffer
	if err := pageTemplate.Execute(&page, data); err != nil {
		writeFailure(w, err)
		return
	}
	w.WriteHeader(status)
	w.Write(page.Bytes())
}

func (s *Server) handleHome(w http.ResponseWriter, r *http.Request) {
	info, err := s.serverInfo(r)
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.renderPage(w, http.StatusOK, pageData{
		Title:   info.Name,
		Heading: info.Name,
		Body:    "This is a Zuna server: private, end-to-end encrypted chat. Ask a member for an invite link to join.",
		HasIcon: info.HasIcon,
	})
}

func (s *Server) handleInvitePage(w http.ResponseWriter, r *http.Request) {
	info, err := s.serverInfo(r)
	if err != nil {
		writeFailure(w, err)
		return
	}
	invite, err := s.db.ValidInvite(r.Context(), r.PathValue("code"))
	if err != nil {
		s.renderPage(w, http.StatusNotFound, pageData{
			Title:   "Invite expired",
			Heading: "This invite isn't valid anymore",
			Body:    "It may have expired or already been used. Ask for a new link.",
			HasIcon: info.HasIcon,
		})
		return
	}
	heading := "You're invited to " + info.Name
	body := "Zuna is private, end-to-end encrypted chat. Open this invite in the app to join."
	if invite.GrantsRole == "owner" {
		heading = "Finish setting up your server"
		body = "Open this link in the Zuna app to create the owner account. It works once."
	}
	s.renderPage(w, http.StatusOK, pageData{
		Title:       info.Name,
		Heading:     heading,
		Body:        body,
		HasIcon:     info.HasIcon,
		Invite:      true,
		OfficialURL: officialDownloads,
		DownloadURL: s.cfg.DownloadURL,
	})
}
