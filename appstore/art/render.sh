#!/bin/zsh
# Draws the App Store art in appstore/ from the captures in appstore/captures, with headless Chrome:
#
#   appstore/art/render.sh [set] [name]
#
# set is iphone, iphone-pl, ipad or product-page, every set when left out, and name one image of it, by its file
# name without .png. Needs Google Chrome (CHROME names another), Python 3, sips, and the repository's node_modules,
# for Inter. Every image is written without an alpha channel, which App Store Connect refuses.
set -euo pipefail
ART=${0:A:h}
H=${ART:h}
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
SET=${1:-}
ONLY=${2:-}
enc() { python3 -I -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$1"; }

# A page drawn to <out>: url, width, height, out.
shoot() {
  python3 -I $ART/capture.py "$CHROME" "$1" $2 $3 $4.rgba.png
  flatten $4.rgba.png $4
}
# A PNG written again from a JPEG of it, which leaves no alpha channel.
flatten() {
  sips -s format jpeg -s formatOptions 95 $1 --out $2.jpg >/dev/null
  sips -s format png $2.jpg --out $2 >/dev/null
  rm $1 $2.jpg
  echo ${2#$H/}
}

# The iPhone's eight, at 6.9" and scaled to 6.3". Each is the output name, the capture, a second capture behind it
# ("-" for none), the style, the headline's lines and the line under it.
iphone() {
  local captures=$1 big=$2 small=$3; shift 3
  mkdir -p $H/$big $H/$small
  for out raw raw2 style title sub in "$@"; do
    [[ -n "$ONLY" && "$out" != "$ONLY" ]] && continue
    url="file://$ART/frame.html?device=iphone&style=$style&screen=$(enc $H/captures/$captures/$raw.png)&title=$(enc $title)&sub=$(enc $sub)"
    [[ "$raw2" != "-" ]] && url="$url&screen2=$(enc $H/captures/$captures/$raw2.png)"
    shoot "$url" 1320 2868 $H/$big/$out.png
    sips -z 2622 1206 $H/$big/$out.png --out $H/$small/$out.big.png >/dev/null
    flatten $H/$small/$out.big.png $H/$small/$out.png
  done
}

if [[ -z "$SET" || "$SET" == iphone ]]; then
  iphone iphone iphone-6.9 iphone-6.3 \
    1-hero     1-chats    7-channels 3d   "The chat app|nobody owns." "End-to-end encrypted chat, voice and screen sharing, on servers you run." \
    2-telegram 2-telegram -          flat "Your Telegram,|in the same app." "Link your own account. Zuna isn't made by Telegram." \
    3-chat     3-chat     -          flat "Private by math,|not by promise." "Every message is end-to-end encrypted." \
    4-voice    6-voice    -          flat "Pull up a chair|in voice." "Voice channels and calls, end-to-end encrypted." \
    5-channel  4-channel  -          flat "Channels for|the whole crew." "Open to everyone on your server, and hidden from the server itself." \
    6-verify   5-verify   -          flat "Know it's|really them." "Compare emoji to know nobody is listening in." \
    7-servers  9-servers  -          flat "All your servers,|one app." "Your friends, your games, your family, and your Telegram, side by side." \
    8-invite   8-invite   -          flat "Got an invite?|You're three steps away." "Join a friend's server with one link. No phone number, no email."
fi

if [[ -z "$SET" || "$SET" == iphone-pl ]]; then
  iphone iphone-pl iphone-pl-6.9 iphone-pl-6.3 \
    1-hero     1-chats    7-channels 3d   "Czat, który|do nikogo nie należy." "Szyfrowane end-to-end wiadomości, głos i udostępnianie ekranu na serwerach, które sam prowadzisz." \
    2-telegram 2-telegram -          flat "Twój Telegram|w tej samej aplikacji." "Połącz własne konto. Zuna nie jest aplikacją Telegrama." \
    3-chat     3-chat     -          flat "Prywatność|z matematyki." "Nie z obietnic. Każda wiadomość jest szyfrowana end-to-end." \
    4-voice    6-voice    -          flat "Wpadnij|na kanał głosowy." "Kanały głosowe i rozmowy, szyfrowane end-to-end." \
    5-channel  4-channel  -          flat "Kanały dla|całej ekipy." "Otwarte dla wszystkich na serwerze. Sam serwer nie przeczyta ani słowa." \
    6-verify   5-verify   -          flat "Upewnij się,|że to naprawdę oni." "Porównaj emoji i miej pewność, że nikt nie podsłuchuje." \
    7-servers  9-servers  -          flat "Wszystkie serwery,|jedna aplikacja." "Znajomi, granie, rodzina i Telegram, wszystko w jednym miejscu." \
    8-invite   8-invite   -          flat "Masz zaproszenie?|Trzy kroki i jesteś." "Dołącz do serwera znajomych jednym linkiem. Bez numeru telefonu i maila."
fi

# The iPad's eight, at 13", lying on its side: the output name and capture are the same.
if [[ -z "$SET" || "$SET" == ipad ]]; then
  mkdir -p $H/ipad-13
  for out title sub in \
    1-hero     "The chat app|nobody owns." "End-to-end encrypted chat, voice and screen sharing, on servers you run." \
    2-telegram "Your Telegram,|in the same app." "Link your own account. Zuna isn't made by Telegram." \
    3-chat     "Private by math,|not by promise." "Every message is end-to-end encrypted." \
    4-voice    "Pull up a chair|in voice." "Voice channels and calls, end-to-end encrypted." \
    5-channel  "Channels for|the whole crew." "Open to everyone on your server, and hidden from the server itself." \
    6-verify   "Know it's|really them." "Compare emoji to know nobody is listening in." \
    7-servers  "All your servers,|one app." "Your friends, your games, your family, and your Telegram, side by side." \
    8-invite   "Got an invite?|You're three steps away." "Join a friend's server with one link. No phone number, no email."
  do
    [[ -n "$ONLY" && "$out" != "$ONLY" ]] && continue
    shoot "file://$ART/frame.html?device=ipad&landscape=1&style=flat&screen=$(enc $H/captures/ipad/$out.png)&title=$(enc $title)&sub=$(enc $sub)" 2752 2064 $H/ipad-13/$out.png
  done
fi

# The product page's header, a plainer one, and the artwork for search results.
want() { [[ -z "$ONLY" || "$ONLY" == "$1" ]]; }
if [[ -z "$SET" || "$SET" == product-page ]]; then
  mkdir -p $H/product-page
  if want header; then
    shoot "file://$ART/header.html?avatar=$(enc $H/showcase/assets/avatar-theo.png)" 3840 1646 $H/product-page/header.png
  fi
  if want header-basic; then
    shoot "file://$ART/header-basic.html" 3840 1646 $H/product-page/header-basic.png
  fi
  if want search-result; then
    shoot "file://$ART/search.html?layout=ipad&ipad=$(enc $H/captures/ipad/1-hero.png)&iphone=$(enc $H/captures/iphone/4-channel.png)&sub=$(enc 'Encrypted chat and voice, on servers you run.')" 3840 2560 $H/product-page/search-result.png
  fi
fi
