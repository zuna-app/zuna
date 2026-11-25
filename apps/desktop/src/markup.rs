//! Message text to formatted runs, by the web's rules (packages/ui/src/lib/markup.tsx).
//! Nothing here interprets the text as anything but text: a message can't make the
//! app do more than show bold, links and the rest.

use std::collections::HashMap;
use std::ops::Range;
use std::sync::LazyLock;

use fancy_regex::Regex as FancyRegex;
use regex::Regex;
use unicode_segmentation::UnicodeSegmentation;

use crate::models::EmoteRef;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SpanStyle {
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
    pub code: bool,
    pub spoiler: bool,
    pub link: Option<String>,
    /// The user it mentions, and whether that's whoever is reading.
    pub mention: Option<(String, bool)>,
    /// An emote, by the word that stands for it.
    pub emote: Option<(String, EmoteRef)>,
}

/// One block's text, and how each part of it looks.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Rich {
    pub text: String,
    pub spans: Vec<(Range<usize>, SpanStyle)>,
}

impl Rich {
    fn push(&mut self, text: &str, style: &SpanStyle) {
        if text.is_empty() {
            return;
        }
        let start = self.text.len();
        self.text.push_str(text);
        if let Some((range, last)) = self.spans.last_mut() {
            if range.end == start && last == style {
                range.end = self.text.len();
                return;
            }
        }
        self.spans.push((start..self.text.len(), style.clone()));
    }

    pub fn has_emotes(&self) -> bool {
        self.spans.iter().any(|(_, style)| style.emote.is_some())
    }
}

#[derive(Clone, Debug)]
pub enum Block {
    Text(Rich),
    Quote(Rich),
    Code { text: String, language: Option<String> },
}

pub struct Context<'a> {
    pub emotes: &'a HashMap<String, EmoteRef>,
    /// username (lowercase) -> user ID.
    pub mentionable: &'a HashMap<String, String>,
    pub self_id: &'a str,
    /// A chat of the linked Telegram account, where a mention by name is drawn as the name alone.
    /// Nowhere else, where its words could make anyone look mentioned.
    pub telegram: bool,
}

static URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\bhttps?://(?:[^\s<>"'()]|\([^\s<>"'()]*\))*(?:[^\s<>"'.,;:!?()\]}]|\([^\s<>"'()]*\))"#).unwrap()
});
static MENTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^@([A-Za-z0-9_][A-Za-z0-9_.-]{1,31})([.,:;!?]*)$").unwrap());
static FENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"```([^\s`]*)\n?((?s:.)*?)```").unwrap());
static EMOJI_ONLY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u{200d}|\u{fe0f}|\s)+$").unwrap());
static HAS_EMOJI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{20e3}").unwrap());

/// A mention of someone on Telegram by name, as the core writes one (telegram/markup.ts): what it
/// says, and their user ID.
static NAMED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\[\]\n]{1,100})\]\(tg://user\?id=([1-9][0-9]{0,15})\)").unwrap());

/// JavaScript's largest exact integer, past which a user's number is no one's.
const MOST_USER_ID: u64 = (1 << 53) - 1;

#[derive(Clone, Copy)]
enum Rule {
    Named,
    Code,
    Spoiler,
    Bold,
    Strike,
    Italic,
}

enum InlinePattern {
    Fast(Regex),
    Fancy(FancyRegex),
}

impl InlinePattern {
    fn find(&self, text: &str, from: usize) -> Option<Found> {
        let slice = &text[from..];
        match self {
            InlinePattern::Fast(re) => {
                let captures = re.captures(slice)?;
                let whole = captures.get(0)?;
                let inner = captures.get(1).map(|m| m.range()).unwrap_or(0..0);
                Some((from + whole.start(), from + whole.end(), from + inner.start..from + inner.end))
            }
            InlinePattern::Fancy(re) => {
                let captures = re.captures(slice).ok().flatten()?;
                let whole = captures.get(0)?;
                let inner = captures.get(1).map(|m| m.range()).unwrap_or(0..0);
                Some((from + whole.start(), from + whole.end(), from + inner.start..from + inner.end))
            }
        }
    }
}

// JavaScript's \w is ASCII only, so these spell it out.
static RULES: LazyLock<Vec<(Rule, InlinePattern)>> = LazyLock::new(|| {
    vec![
        (Rule::Named, InlinePattern::Fast(Regex::new(NAMED.as_str()).unwrap())),
        (Rule::Code, InlinePattern::Fast(Regex::new(r"`([^`\n]+)`").unwrap())),
        (Rule::Spoiler, InlinePattern::Fast(Regex::new(r"\|\|([^\n]+?)\|\|").unwrap())),
        (Rule::Bold, InlinePattern::Fast(Regex::new(r"\*\*([^\n]+?)\*\*").unwrap())),
        (Rule::Strike, InlinePattern::Fast(Regex::new(r"~~([^\n]+?)~~").unwrap())),
        (Rule::Italic, InlinePattern::Fancy(FancyRegex::new(r"(?<![A-Za-z0-9_*])\*([^\s*](?:[^\n*]*[^\s*])?)\*(?![A-Za-z0-9_*])").unwrap())),
    ]
});

/// Cheap literal check before invoking the regex engine for an inline rule.
#[inline]
fn rule_possible(rule: Rule, slice: &str) -> bool {
    match rule {
        Rule::Named => slice.contains("tg://user?id="),
        Rule::Code => slice.as_bytes().contains(&b'`'),
        Rule::Spoiler => slice.contains("||"),
        Rule::Bold => slice.contains("**"),
        Rule::Strike => slice.contains("~~"),
        Rule::Italic => slice.as_bytes().contains(&b'*'),
    }
}

/// Formatting inside formatting, this deep. Further in, it's just text.
const MAX_INLINE_DEPTH: usize = 8;

fn render_plain(out: &mut Rich, text: &str, style: &SpanStyle, context: &Context) {
    if text.is_empty() {
        return;
    }
    let has_emotes = !context.emotes.is_empty();
    let has_mentions = !context.mentionable.is_empty() && text.as_bytes().contains(&b'@');
    if !has_emotes && !has_mentions {
        out.push(text, style);
        return;
    }
    let mut buffer = String::new();
    let flush = |out: &mut Rich, buffer: &mut String| {
        out.push(buffer, style);
        buffer.clear();
    };
    for token in split_keeping_whitespace(text) {
        if has_emotes {
            if let Some(emote) = context.emotes.get(token) {
                flush(out, &mut buffer);
                out.push(token, &SpanStyle { emote: Some((token.to_string(), emote.clone())), ..style.clone() });
                continue;
            }
        }
        if has_mentions && token.starts_with('@') {
            if let Some(captures) = MENTION.captures(token) {
                let name = &captures[1];
                if let Some(user_id) = context.mentionable.get(&name.to_lowercase()) {
                    flush(out, &mut buffer);
                    let is_self = user_id == context.self_id;
                    out.push(&format!("@{name}"), &SpanStyle { mention: Some((user_id.clone(), is_self)), ..style.clone() });
                    buffer.push_str(&captures[2]);
                    continue;
                }
            }
        }
        buffer.push_str(token);
    }
    flush(out, &mut buffer);
}

/// Like JavaScript's split(/(\s+)/): words and the whitespace between them.
fn split_keeping_whitespace(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut in_space = None;
    for (index, ch) in text.char_indices() {
        let space = ch.is_whitespace();
        match in_space {
            None => in_space = Some(space),
            Some(previous) if previous != space => {
                parts.push(&text[start..index]);
                start = index;
                in_space = Some(space);
            }
            _ => {}
        }
    }
    if start < text.len() {
        parts.push(&text[start..]);
    }
    parts
}

fn render_links(out: &mut Rich, text: &str, style: &SpanStyle, context: &Context) {
    if !text.contains("://") {
        render_plain(out, text, style, context);
        return;
    }
    let mut last = 0;
    for found in URL.find_iter(text) {
        if found.start() > last {
            render_plain(out, &text[last..found.start()], style, context);
        }
        out.push(found.as_str(), &SpanStyle { link: Some(found.as_str().to_string()), ..style.clone() });
        last = found.end();
    }
    if last < text.len() {
        render_plain(out, &text[last..], style, context);
    }
}

/// The rules that look at the character before a match, again anchored to where a search
/// starts: there, the text before no longer counts, so one may match where it didn't before.
static ANCHORED: LazyLock<Vec<Option<InlinePattern>>> = LazyLock::new(|| {
    RULES
        .iter()
        .map(|(_, pattern)| match pattern {
            InlinePattern::Fancy(re) if re.as_str().starts_with("(?<!") => {
                Some(InlinePattern::Fancy(FancyRegex::new(&format!("^(?:{})", re.as_str())).unwrap()))
            }
            _ => None,
        })
        .collect()
});

/// A rule's match: where it starts and ends, and what it holds, in the whole text.
type Found = (usize, usize, Range<usize>);

/// The earliest rule's match goes first, and the text from its end is formatted the same way.
/// Each rule's next match is kept while it's still ahead, so a long message with many spans is
/// read once by each rule rather than again after every span, with the same result as asking
/// every rule afresh from each position (`formats_as_rescanning_does`).
fn render_inline(out: &mut Rich, text: &str, style: &SpanStyle, context: &Context, depth: usize) {
    if depth >= MAX_INLINE_DEPTH {
        return render_links(out, text, style, context);
    }
    // Fast path for plain messages with no inline formatting characters at all.
    let bytes = text.as_bytes();
    let any_marker = bytes.iter().any(|&b| matches!(b, b'`' | b'|' | b'*' | b'~'))
        || (context.telegram && text.contains("tg://user?id="));
    if !any_marker {
        return render_links(out, text, style, context);
    }
    let mut position = 0;
    // For each rule: not looked for yet, nothing further on, or its next match.
    let mut next: [Option<Option<Found>>; 6] = [None, None, None, None, None, None];
    loop {
        let rest = &text[position..];
        for (index, (rule, pattern)) in RULES.iter().enumerate() {
            if matches!(rule, Rule::Named) && !context.telegram {
                next[index] = Some(None);
                continue;
            }
            match &next[index] {
                Some(Some((start, _, _))) if *start < position => {
                    next[index] = Some(if rule_possible(*rule, rest) { pattern.find(text, position) } else { None });
                }
                None => {
                    next[index] = Some(if rule_possible(*rule, rest) { pattern.find(text, position) } else { None });
                }
                _ => {
                    if let Some(anchored) = &ANCHORED[index] {
                        if next[index].as_ref().unwrap().as_ref().is_none_or(|(start, _, _)| *start > position) {
                            if rule_possible(*rule, rest) {
                                if let Some(here) = anchored.find(text, position) {
                                    next[index] = Some(Some(here));
                                }
                            }
                        }
                    }
                }
            }
        }
        let mut earliest: Option<(Rule, Found)> = None;
        for (index, found) in next.iter().enumerate() {
            if let Some(Some(found)) = found {
                if earliest.as_ref().is_none_or(|(_, (start, _, _))| found.0 < *start) {
                    earliest = Some((RULES[index].0, found.clone()));
                }
            }
        }
        let Some((rule, (start, end, inner))) = earliest else { break };
        render_links(out, &text[position..start], style, context);
        let inner_text = &text[inner];
        match rule {
            Rule::Named => match NAMED.captures(&text[start..end]).map(|captures| captures[2].to_string()).filter(|id| id.parse::<u64>().is_ok_and(|id| id <= MOST_USER_ID)) {
                Some(user_id) => {
                    let is_self = user_id == context.self_id;
                    out.push(inner_text, &SpanStyle { mention: Some((user_id, is_self)), ..style.clone() });
                }
                None => render_links(out, &text[start..end], style, context),
            },
            Rule::Code => out.push(inner_text, &SpanStyle { code: true, ..style.clone() }),
            Rule::Spoiler => render_inline(out, inner_text, &SpanStyle { spoiler: true, ..style.clone() }, context, depth + 1),
            Rule::Bold => render_inline(out, inner_text, &SpanStyle { bold: true, ..style.clone() }, context, depth + 1),
            Rule::Strike => render_inline(out, inner_text, &SpanStyle { strike: true, ..style.clone() }, context, depth + 1),
            Rule::Italic => render_inline(out, inner_text, &SpanStyle { italic: true, ..style.clone() }, context, depth + 1),
        }
        position = end;
    }
    render_links(out, &text[position..], style, context);
}

fn inline(text: &str, context: &Context) -> Rich {
    let mut rich = Rich::default();
    render_inline(&mut rich, text, &SpanStyle::default(), context, 0);
    rich
}

/// A message's blocks: paragraphs, quotes and code.
pub fn parse(text: &str, context: &Context) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut last = 0;
    let push_text = |blocks: &mut Vec<Block>, chunk: &str| {
        let trimmed = chunk.trim_matches('\n');
        if trimmed.is_empty() && chunk.is_empty() {
            return;
        }
        if chunk.is_empty() {
            return;
        }
        let mut current: Option<(bool, String)> = None;
        for line in trimmed.split('\n') {
            let (is_quote, rest) = if let Some(after) = line.strip_prefix('>') {
                let after = after.chars().next().filter(|c| c.is_whitespace()).map_or(after, |c| &after[c.len_utf8()..]);
                (true, after)
            } else {
                (false, line)
            };
            match &mut current {
                Some((quote, text)) if *quote == is_quote => {
                    text.push('\n');
                    text.push_str(rest);
                }
                _ => {
                    if let Some((quote, text)) = current.take() {
                        blocks.push(if quote { Block::Quote(inline(&text, context)) } else { Block::Text(inline(&text, context)) });
                    }
                    current = Some((is_quote, rest.to_string()));
                }
            }
        }
        if let Some((quote, text)) = current {
            blocks.push(if quote { Block::Quote(inline(&text, context)) } else { Block::Text(inline(&text, context)) });
        }
    };
    if text.contains("```") {
        for captures in FENCE.captures_iter(text) {
            let whole = captures.get(0).unwrap();
            push_text(&mut blocks, &text[last..whole.start()]);
            let code = captures[2].strip_suffix('\n').unwrap_or(&captures[2]).to_string();
            let language = Some(captures[1].to_string()).filter(|language| !language.is_empty());
            blocks.push(Block::Code { text: code, language });
            last = whole.end();
        }
    }
    push_text(&mut blocks, &text[last..]);
    blocks
}

/// Messages that are only emoji or emotes show larger: 2 for up to three of them, 1 for up to eight.
pub fn jumbo_size(text: &str, emotes: &HashMap<String, EmoteRef>) -> u8 {
    // Pure ASCII can contain no emoji, so without emotes it can never be jumbo.
    if emotes.is_empty() && text.is_ascii() {
        return 0;
    }
    let mut words = 0usize;
    let mut glyphs = 0usize;
    for word in text.split_whitespace() {
        words += 1;
        if words > 6 {
            return 0;
        }
        if emotes.contains_key(word) {
            glyphs += 1;
        } else if !word.is_ascii() && EMOJI_ONLY.is_match(word) && HAS_EMOJI.is_match(word) {
            glyphs += word.graphemes(true).count();
        } else {
            return 0;
        }
        if glyphs > 8 {
            return 0;
        }
    }
    if words == 0 {
        0
    } else if glyphs <= 3 {
        2
    } else {
        1
    }
}

/// What a rule of `plain_text` puts in place of what it finds: words, looked up by their key as
/// the text is made plain, or a replacement of the pattern's own.
enum Plain {
    Words(&'static str),
    Pattern(&'static str),
}

enum PlainRegex {
    Fast(Regex, &'static str),
    Fancy(FancyRegex, &'static str),
}

static PLAIN_RULES: LazyLock<Vec<(PlainRegex, Plain)>> = LazyLock::new(|| {
    vec![
        (PlainRegex::Fast(Regex::new(r"```(?s:.)*?```").unwrap(), "```"), Plain::Words(crate::i18n::mark("message.preview.code"))),
        (PlainRegex::Fast(Regex::new(r"\|\|[^\n]+?\|\|").unwrap(), "||"), Plain::Words(crate::i18n::mark("message.preview.spoiler"))),
        (PlainRegex::Fast(Regex::new(r"`([^`\n]+)`").unwrap(), "`"), Plain::Pattern("$1")),
        (PlainRegex::Fast(Regex::new(r"\*\*([^\n]+?)\*\*").unwrap(), "**"), Plain::Pattern("$1")),
        (PlainRegex::Fast(Regex::new(r"~~([^\n]+?)~~").unwrap(), "~~"), Plain::Pattern("$1")),
        (PlainRegex::Fancy(FancyRegex::new(r"(?<![A-Za-z0-9_*])\*([^\s*](?:[^\n*]*[^\s*])?)\*(?![A-Za-z0-9_*])").unwrap(), "*"), Plain::Pattern("$1")),
        // A mention by name in a Telegram chat, which says the name alone.
        (PlainRegex::Fast(Regex::new(r"\[([^\[\]\n]{1,100})\]\(tg://user\?id=[1-9][0-9]{0,15}\)").unwrap(), "tg://user?id="), Plain::Pattern("$1")),
        (PlainRegex::Fast(Regex::new(r"(?m)^>\s?").unwrap(), ">"), Plain::Pattern("")),
    ]
});

/// A message as one line of plain text, for previews (core's plain-text.ts). Spoilers stay hidden.
pub fn plain_text(text: &str) -> String {
    let mut out = if text.len() <= 4096 {
        text.to_string()
    } else {
        text.chars().take(4096).collect()
    };
    for (pattern, replacement) in PLAIN_RULES.iter() {
        match pattern {
            PlainRegex::Fast(re, needle) => {
                if !out.contains(needle) {
                    continue;
                }
                let replaced = match replacement {
                    Plain::Words(key) => re.replace_all(&out, regex::NoExpand(crate::i18n::t(*key))),
                    Plain::Pattern(with) => re.replace_all(&out, *with),
                };
                if let std::borrow::Cow::Owned(next) = replaced {
                    out = next;
                }
            }
            PlainRegex::Fancy(re, needle) => {
                if !out.contains(needle) {
                    continue;
                }
                let replaced = match replacement {
                    Plain::Words(key) => re.replace_all(&out, fancy_regex::NoExpand(crate::i18n::t(*key))),
                    Plain::Pattern(with) => re.replace_all(&out, *with),
                };
                if let std::borrow::Cow::Owned(next) = replaced {
                    out = next;
                }
            }
        }
    }
    // Collapse whitespace runs to a single space and trim in one linear pass (replaces `\s+` regex + trim).
    let mut collapsed = String::with_capacity(out.len());
    let mut in_space = true;
    for ch in out.chars() {
        if ch.is_whitespace() {
            if !in_space {
                collapsed.push(' ');
                in_space = true;
            }
        } else {
            collapsed.push(ch);
            in_space = false;
        }
    }
    if collapsed.ends_with(' ') {
        collapsed.pop();
    }
    collapsed
}

/// The first link in a text that can have a preview, leaving out those in code and
/// spoilers (`findLink` in links.ts).
pub fn find_link(text: &str) -> Option<String> {
    shared_links(text).into_iter().find(|link| url::Url::parse(link).is_ok_and(|url| crate::host::web::previewable(&url)))
}

/// The links a message shares, leaving out those in code and spoilers (`sharedLinks` in links.ts).
pub fn shared_links(text: &str) -> Vec<String> {
    static HIDDEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)```.*?(?:```|\z)|`[^`\n]*`|\|\|.*?\|\|").unwrap());
    let visible = HIDDEN.replace_all(text, " ");
    URL.find_iter(&visible).map(|found| found.as_str().to_string()).collect()
}

/// A mention by name in the message box of a Telegram chat: where its words are in what's written,
/// and whose user ID it is. The box shows the name alone, and what's sent, and kept as the draft,
/// has it written out as the markup holds it.
pub type Named = (Range<usize>, String);

/// The most a mention by name says, in UTF-16 code units as the core counts them.
const MOST_NAMED: usize = 100;

/// Text with its mentions by name as the names alone, for the message box, and where each is.
pub fn take_named(markup: &str) -> (String, Vec<Named>) {
    let mut text = String::with_capacity(markup.len());
    let mut named = Vec::new();
    let mut last = 0;
    for captures in NAMED.captures_iter(markup) {
        let (whole, name, id) = (captures.get(0).unwrap(), &captures[1], &captures[2]);
        if !id.parse::<u64>().is_ok_and(|id| id <= MOST_USER_ID) {
            continue;
        }
        text.push_str(&markup[last..whole.start()]);
        named.push((text.len()..text.len() + name.len(), id.to_string()));
        text.push_str(name);
        last = whole.end();
    }
    text.push_str(&markup[last..]);
    (text, named)
}

/// What the message box holds, with each mention by name still there written out again.
pub fn put_named(text: &str, named: &[Named]) -> String {
    let mut ordered: Vec<&Named> = named
        .iter()
        .filter(|(range, id)| {
            let words = text.get(range.clone()).unwrap_or_default();
            !words.is_empty() && words.encode_utf16().count() <= MOST_NAMED && !words.contains(['[', ']', '\n']) && id.parse::<u64>().is_ok_and(|id| id > 0 && id <= MOST_USER_ID)
        })
        .collect();
    ordered.sort_by_key(|(range, _)| range.start);
    let mut out = String::with_capacity(text.len() + ordered.len() * 32);
    let mut last = 0;
    for (range, id) in ordered {
        if range.start < last {
            continue;
        }
        out.push_str(&text[last..range.start]);
        out.push_str(&format!("[{}](tg://user?id={id})", &text[range.clone()]));
        last = range.end;
    }
    out.push_str(&text[last..]);
    out
}

/// Follows the mentions by name through a change to the message box, from `before` to `after`
/// with the caret at `caret`, which is where what was typed or pasted ends: those before or after
/// the change move with the text, and one the change reached into is plain words from then on.
pub fn follow_named(before: &str, after: &str, caret: usize, named: &mut Vec<Named>) {
    if named.is_empty() || before == after {
        return;
    }
    let caret = caret.min(after.len());
    // What's the same at the end, up to the caret, then at the start, up to what's left.
    let mut suffix = before.bytes().rev().zip(after.bytes().rev()).take_while(|(a, b)| a == b).count().min(after.len() - caret);
    while !before.is_char_boundary(before.len() - suffix) || !after.is_char_boundary(after.len() - suffix) {
        suffix -= 1;
    }
    let most = caret.min(before.len() - suffix).min(after.len() - suffix);
    let mut prefix = before.bytes().zip(after.bytes()).take_while(|(a, b)| a == b).count().min(most);
    while !before.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let changed_end = before.len() - suffix;
    named.retain_mut(|(range, _)| {
        if range.end <= prefix {
            true
        } else if range.start >= changed_end {
            *range = range.start + after.len() - before.len()..range.end + after.len() - before.len();
            true
        } else {
            false
        }
    });
}

/// The user IDs a message mentions (Composer.tsx's mentionsIn).
pub fn mentions_in(text: &str, users: &HashMap<String, String>) -> Vec<String> {
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|\s)@([A-Za-z0-9_][A-Za-z0-9_.-]{1,31})").unwrap());
    let mut ids = Vec::new();
    for captures in PATTERN.captures_iter(text) {
        if let Some(id) = users.get(&captures[1].to_lowercase()) {
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The parser as it was, asking every rule afresh from each position.
    fn rescanning(out: &mut Rich, text: &str, style: &SpanStyle, context: &Context, depth: usize) {
        if depth >= MAX_INLINE_DEPTH {
            return render_links(out, text, style, context);
        }
        let mut position = 0;
        loop {
            let rest = &text[position..];
            let mut earliest: Option<(Rule, usize, usize, Range<usize>)> = None;
            for (rule, pattern) in RULES.iter() {
                if matches!(rule, Rule::Named) && !context.telegram {
                    continue;
                }
                let Some((w_start, w_end, inner)) = pattern.find(rest, 0) else { continue };
                if earliest.as_ref().is_none_or(|(_, start, _, _)| w_start < *start) {
                    earliest = Some((*rule, w_start, w_end, inner));
                }
            }
            let Some((rule, start, end, inner)) = earliest else { break };
            render_links(out, &rest[..start], style, context);
            let inner_text = &rest[inner];
            match rule {
                Rule::Named => {
                    let id = NAMED.captures(&rest[start..end]).unwrap()[2].to_string();
                    out.push(inner_text, &SpanStyle { mention: Some((id, false)), ..style.clone() });
                }
                Rule::Code => out.push(inner_text, &SpanStyle { code: true, ..style.clone() }),
                Rule::Spoiler => rescanning(out, inner_text, &SpanStyle { spoiler: true, ..style.clone() }, context, depth + 1),
                Rule::Bold => rescanning(out, inner_text, &SpanStyle { bold: true, ..style.clone() }, context, depth + 1),
                Rule::Strike => rescanning(out, inner_text, &SpanStyle { strike: true, ..style.clone() }, context, depth + 1),
                Rule::Italic => rescanning(out, inner_text, &SpanStyle { italic: true, ..style.clone() }, context, depth + 1),
            }
            position += end;
        }
        render_links(out, &text[position..], style, context);
    }

    #[test]
    fn formats_as_rescanning_does() {
        let emotes = HashMap::new();
        let mentionable = HashMap::new();
        let mut context = context(&emotes, &mentionable);
        context.telegram = true;
        let pieces = ["**b**", "_i_", "*i*", "`c`", "||s||", "~~x~~", "a", " ", "_", "*", "**", "`", "|", "~", "w_", "_w", "x*y", "\n", "é", "😀", "[Ann](tg://user?id=5)", "[", "]"];
        // Every mix of a few pieces, then long ones built from all of them.
        let mut texts: Vec<String> = Vec::new();
        for a in pieces {
            for b in pieces {
                for c in pieces {
                    texts.push(format!("{a}{b}{c}"));
                }
            }
        }
        let mut seed = 7u64;
        for _ in 0..300 {
            let mut text = String::new();
            for _ in 0..60 {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                text.push_str(pieces[(seed >> 33) as usize % pieces.len()]);
            }
            texts.push(text);
        }
        for text in texts {
            let (mut linear, mut rescanned) = (Rich::default(), Rich::default());
            render_inline(&mut linear, &text, &SpanStyle::default(), &context, 0);
            rescanning(&mut rescanned, &text, &SpanStyle::default(), &context, 0);
            assert_eq!(linear, rescanned, "{text:?}");
        }
    }

    fn context<'a>(emotes: &'a HashMap<String, EmoteRef>, mentionable: &'a HashMap<String, String>) -> Context<'a> {
        Context { emotes, mentionable, self_id: "me", telegram: false }
    }

    #[test]
    fn draws_a_mention_by_name_only_in_telegram_chats() {
        let (emotes, mentionable) = (HashMap::new(), HashMap::new());
        let text = "hi **[Łukasz Ż](tg://user?id=42)**, [me](tg://user?id=7) and [no one](tg://user?id=99999999999999999) [x](tg://user?id=9999999999999999)";
        let mut telegram = context(&emotes, &mentionable);
        telegram.telegram = true;
        telegram.self_id = "7";
        let Block::Text(rich) = &parse(text, &telegram)[0] else { panic!() };
        assert_eq!(rich.text, "hi Łukasz Ż, me and [no one](tg://user?id=99999999999999999) [x](tg://user?id=9999999999999999)");
        let mentions: Vec<(&str, &(String, bool), bool)> = rich.spans.iter().filter_map(|(range, style)| style.mention.as_ref().map(|mention| (&rich.text[range.clone()], mention, style.bold))).collect();
        assert_eq!(mentions, vec![("Łukasz Ż", &("42".to_string(), false), true), ("me", &("7".to_string(), true), false)]);
        // Elsewhere its words are what was written.
        let Block::Text(rich) = &parse(text, &context(&emotes, &mentionable))[0] else { panic!() };
        assert!(rich.text.contains("[me](tg://user?id=7)") && rich.spans.iter().all(|(_, style)| style.mention.is_none()));
        assert_eq!(plain_text("**hi** [Grace](tg://user?id=2000), [*you*](tg://user?id=7)"), "hi Grace, you");
    }

    #[test]
    fn keeps_mentions_by_name_in_the_message_box() {
        let markup = "hi [Łukasz](tg://user?id=42) and [Ann](tg://user?id=5)!";
        let (text, named) = take_named(markup);
        assert_eq!(text, "hi Łukasz and Ann!");
        assert_eq!(named, vec![(3..10, "42".to_string()), (15..18, "5".to_string())]);
        assert_eq!(put_named(&text, &named), markup);
        // Typing before one moves it, even where the letters typed are its own.
        let mut moved = named.clone();
        follow_named(&text, "Ahi Łukasz and Ann!", 1, &mut moved);
        assert_eq!(put_named("Ahi Łukasz and Ann!", &moved), "Ahi [Łukasz](tg://user?id=42) and [Ann](tg://user?id=5)!");
        let mut ann = vec![(0..3, "5".to_string())];
        follow_named("Ann", "AAnn", 1, &mut ann);
        assert_eq!(put_named("AAnn", &ann), "A[Ann](tg://user?id=5)");
        // Typing right after one leaves it as it was.
        let mut ann = vec![(0..3, "5".to_string())];
        follow_named("Ann", "Anna", 4, &mut ann);
        assert_eq!(put_named("Anna", &ann), "[Ann](tg://user?id=5)a");
        // Changing its words makes them plain, and taking text out between moves what follows.
        let mut changed = named.clone();
        follow_named(&text, "hi Łukaz and Ann!", 8, &mut changed);
        assert_eq!(put_named("hi Łukaz and Ann!", &changed), "hi Łukaz and [Ann](tg://user?id=5)!");
        let mut cut = named.clone();
        follow_named(&text, "hi Łukasz Ann!", 10, &mut cut);
        assert_eq!(put_named("hi Łukasz Ann!", &cut), "hi [Łukasz](tg://user?id=42) [Ann](tg://user?id=5)!");
        // What can't be written out stays the words it is.
        assert_eq!(put_named("a]b c", &[(0..3, "5".to_string()), (4..5, "0".to_string()), (9..12, "5".to_string())]), "a]b c");
    }

    #[test]
    fn formats_spans() {
        let emotes = HashMap::new();
        let mentionable = HashMap::from([("sam".to_string(), "u1".to_string())]);
        let blocks = parse("hi **bold** and *it* @sam https://example.com/a(b) `x`", &context(&emotes, &mentionable));
        let Block::Text(rich) = &blocks[0] else { panic!() };
        assert_eq!(rich.text, "hi bold and it @sam https://example.com/a(b) x");
        assert!(rich.spans.iter().any(|(range, style)| style.bold && &rich.text[range.clone()] == "bold"));
        assert!(rich.spans.iter().any(|(range, style)| style.italic && &rich.text[range.clone()] == "it"));
        assert!(rich.spans.iter().any(|(_, style)| style.mention.as_ref().map(|m| m.0.as_str()) == Some("u1")));
        assert!(rich.spans.iter().any(|(_, style)| style.link.as_deref() == Some("https://example.com/a(b)")));
        assert!(rich.spans.iter().any(|(range, style)| style.code && &rich.text[range.clone()] == "x"));
        // Underscores are only underscores.
        let Block::Text(rich) = &parse("_not it_ snake_case", &context(&emotes, &mentionable))[0] else { panic!() };
        assert_eq!(rich.text, "_not it_ snake_case");
        assert!(rich.spans.iter().all(|(_, style)| !style.italic));
    }

    #[test]
    fn splits_code_and_quotes() {
        let emotes = HashMap::new();
        let mentionable = HashMap::new();
        let blocks = parse("> quoted\nplain\n```rust\nfn x() {}\n```", &context(&emotes, &mentionable));
        assert!(matches!(&blocks[0], Block::Quote(rich) if rich.text == "quoted"));
        assert!(matches!(&blocks[1], Block::Text(rich) if rich.text == "plain"));
        assert!(matches!(&blocks[2], Block::Code { text, language } if text == "fn x() {}" && language.as_deref() == Some("rust")));
    }

    #[test]
    fn plain_text_strips_markup() {
        assert_eq!(plain_text("**a** ||secret|| `b`\n> c"), "a [spoiler] b c");
        assert_eq!(plain_text("*a* _b_"), "a _b_");
        assert_eq!(jumbo_size("😀😀", &HashMap::new()), 2);
        assert_eq!(jumbo_size("hello 😀", &HashMap::new()), 0);
    }
}
