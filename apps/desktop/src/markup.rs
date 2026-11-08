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
}

static URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\bhttps?://(?:[^\s<>"'()]|\([^\s<>"'()]*\))*(?:[^\s<>"'.,;:!?()\]}]|\([^\s<>"'()]*\))"#).unwrap()
});
static MENTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^@([A-Za-z0-9_][A-Za-z0-9_.-]{1,31})([.,:;!?]*)$").unwrap());
static FENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"```([^\s`]*)\n?((?s:.)*?)```").unwrap());
static QUOTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^>\s?").unwrap());
static EMOJI_ONLY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u{200d}|\u{fe0f}|\s)+$").unwrap());
static HAS_EMOJI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{20e3}").unwrap());

#[derive(Clone, Copy)]
enum Rule {
    Code,
    Spoiler,
    Bold,
    Strike,
    Italic,
}

// JavaScript's \w is ASCII only, so these spell it out.
static RULES: LazyLock<Vec<(Rule, FancyRegex)>> = LazyLock::new(|| {
    vec![
        (Rule::Code, FancyRegex::new(r"`([^`\n]+)`").unwrap()),
        (Rule::Spoiler, FancyRegex::new(r"\|\|([^\n]+?)\|\|").unwrap()),
        (Rule::Bold, FancyRegex::new(r"\*\*([^\n]+?)\*\*").unwrap()),
        (Rule::Strike, FancyRegex::new(r"~~([^\n]+?)~~").unwrap()),
        (Rule::Italic, FancyRegex::new(r"(?<![A-Za-z0-9_*])\*([^\s*](?:[^\n*]*[^\s*])?)\*(?![A-Za-z0-9_*])").unwrap()),
        (Rule::Italic, FancyRegex::new(r"(?<![A-Za-z0-9_])_([^\s_](?:[^\n_]*[^\s_])?)_(?![A-Za-z0-9_])").unwrap()),
    ]
});

/// Formatting inside formatting, this deep. Further in, it's just text.
const MAX_INLINE_DEPTH: usize = 8;

fn render_plain(out: &mut Rich, text: &str, style: &SpanStyle, context: &Context) {
    let mut buffer = String::new();
    let flush = |out: &mut Rich, buffer: &mut String| {
        out.push(buffer, style);
        buffer.clear();
    };
    for token in split_keeping_whitespace(text) {
        if let Some(emote) = context.emotes.get(token) {
            flush(out, &mut buffer);
            out.push(token, &SpanStyle { emote: Some((token.to_string(), emote.clone())), ..style.clone() });
            continue;
        }
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
static ANCHORED: LazyLock<Vec<Option<FancyRegex>>> =
    LazyLock::new(|| RULES.iter().map(|(_, pattern)| pattern.as_str().starts_with("(?<!").then(|| FancyRegex::new(&format!("^(?:{})", pattern.as_str())).unwrap())).collect());

/// A rule's match: where it starts and ends, and what it holds, in the whole text.
type Found = (usize, usize, Range<usize>);

fn find(pattern: &FancyRegex, text: &str, from: usize) -> Option<Found> {
    let captures = pattern.captures(&text[from..]).ok().flatten()?;
    let whole = captures.get(0)?;
    let inner = captures.get(1).map(|inner| inner.range()).unwrap_or(0..0);
    Some((from + whole.start(), from + whole.end(), from + inner.start..from + inner.end))
}

/// The earliest rule's match goes first, and the text from its end is formatted the same way.
/// Each rule's next match is kept while it's still ahead, so a long message with many spans is
/// read once by each rule rather than again after every span, with the same result as asking
/// every rule afresh from each position (`formats_as_rescanning_does`).
fn render_inline(out: &mut Rich, text: &str, style: &SpanStyle, context: &Context, depth: usize) {
    if depth >= MAX_INLINE_DEPTH {
        return render_links(out, text, style, context);
    }
    let mut position = 0;
    // For each rule: not looked for yet, nothing further on, or its next match.
    let mut next: Vec<Option<Option<Found>>> = vec![None; RULES.len()];
    loop {
        for (index, (_, pattern)) in RULES.iter().enumerate() {
            match &next[index] {
                Some(Some((start, _, _))) if *start < position => next[index] = Some(find(pattern, text, position)),
                None => next[index] = Some(find(pattern, text, position)),
                _ => {
                    if let Some(anchored) = &ANCHORED[index] {
                        if next[index].as_ref().unwrap().as_ref().is_none_or(|(start, _, _)| *start > position) {
                            if let Some(here) = find(anchored, text, position) {
                                next[index] = Some(Some(here));
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
            let is_quote = QUOTE.is_match(line);
            let value = if is_quote { QUOTE.replace(line, "").into_owned() } else { line.to_string() };
            match &mut current {
                Some((quote, text)) if *quote == is_quote => {
                    text.push('\n');
                    text.push_str(&value);
                }
                _ => {
                    if let Some((quote, text)) = current.take() {
                        blocks.push(if quote { Block::Quote(inline(&text, context)) } else { Block::Text(inline(&text, context)) });
                    }
                    current = Some((is_quote, value));
                }
            }
        }
        if let Some((quote, text)) = current {
            blocks.push(if quote { Block::Quote(inline(&text, context)) } else { Block::Text(inline(&text, context)) });
        }
    };
    for captures in FENCE.captures_iter(text) {
        let whole = captures.get(0).unwrap();
        push_text(&mut blocks, &text[last..whole.start()]);
        let code = captures[2].strip_suffix('\n').unwrap_or(&captures[2]).to_string();
        let language = Some(captures[1].to_string()).filter(|language| !language.is_empty());
        blocks.push(Block::Code { text: code, language });
        last = whole.end();
    }
    push_text(&mut blocks, &text[last..]);
    blocks
}

/// Messages that are only emoji or emotes show larger: 2 for up to three of them, 1 for up to eight.
pub fn jumbo_size(text: &str, emotes: &HashMap<String, EmoteRef>) -> u8 {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() || words.len() > 6 {
        return 0;
    }
    let only = words.iter().all(|word| emotes.contains_key(*word) || (EMOJI_ONLY.is_match(word) && HAS_EMOJI.is_match(word)));
    if !only {
        return 0;
    }
    let glyphs: usize = words.iter().map(|word| if emotes.contains_key(*word) { 1 } else { word.graphemes(true).count() }).sum();
    if glyphs > 8 {
        0
    } else if glyphs <= 3 {
        2
    } else {
        1
    }
}

static PLAIN_RULES: LazyLock<Vec<(FancyRegex, &'static str)>> = LazyLock::new(|| {
    vec![
        (FancyRegex::new(r"```(?s:.)*?```").unwrap(), "[code]"),
        (FancyRegex::new(r"\|\|[^\n]+?\|\|").unwrap(), "[spoiler]"),
        (FancyRegex::new(r"`([^`\n]+)`").unwrap(), "$1"),
        (FancyRegex::new(r"\*\*([^\n]+?)\*\*").unwrap(), "$1"),
        (FancyRegex::new(r"~~([^\n]+?)~~").unwrap(), "$1"),
        (FancyRegex::new(r"(?<![A-Za-z0-9_*])\*([^\s*](?:[^\n*]*[^\s*])?)\*(?![A-Za-z0-9_*])").unwrap(), "$1"),
        (FancyRegex::new(r"(?<![A-Za-z0-9_])_([^\s_](?:[^\n_]*[^\s_])?)_(?![A-Za-z0-9_])").unwrap(), "$1"),
        (FancyRegex::new(r"(?m)^>\s?").unwrap(), ""),
        (FancyRegex::new(r"\s+").unwrap(), " "),
    ]
});

/// A message as one line of plain text, for previews (core's plain-text.ts). Spoilers stay hidden.
pub fn plain_text(text: &str) -> String {
    let mut out: String = text.chars().take(4096).collect();
    for (pattern, replacement) in PLAIN_RULES.iter() {
        out = pattern.replace_all(&out, *replacement).into_owned();
    }
    out.trim().to_string()
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
                let Ok(Some(captures)) = pattern.captures(rest) else { continue };
                let whole = captures.get(0).unwrap();
                let inner = captures.get(1).map(|inner| inner.range()).unwrap_or(0..0);
                if earliest.as_ref().is_none_or(|(_, start, _, _)| whole.start() < *start) {
                    earliest = Some((*rule, whole.start(), whole.end(), inner));
                }
            }
            let Some((rule, start, end, inner)) = earliest else { break };
            render_links(out, &rest[..start], style, context);
            let inner_text = &rest[inner];
            match rule {
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
        let context = context(&emotes, &mentionable);
        let pieces = ["**b**", "_i_", "*i*", "`c`", "||s||", "~~x~~", "a", " ", "_", "*", "**", "`", "|", "~", "w_", "_w", "x*y", "\n", "é", "😀"];
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
        Context { emotes, mentionable, self_id: "me" }
    }

    #[test]
    fn formats_spans() {
        let emotes = HashMap::new();
        let mentionable = HashMap::from([("sam".to_string(), "u1".to_string())]);
        let blocks = parse("hi **bold** and _it_ @sam https://example.com/a(b) `x`", &context(&emotes, &mentionable));
        let Block::Text(rich) = &blocks[0] else { panic!() };
        assert_eq!(rich.text, "hi bold and it @sam https://example.com/a(b) x");
        assert!(rich.spans.iter().any(|(range, style)| style.bold && &rich.text[range.clone()] == "bold"));
        assert!(rich.spans.iter().any(|(range, style)| style.italic && &rich.text[range.clone()] == "it"));
        assert!(rich.spans.iter().any(|(_, style)| style.mention.as_ref().map(|m| m.0.as_str()) == Some("u1")));
        assert!(rich.spans.iter().any(|(_, style)| style.link.as_deref() == Some("https://example.com/a(b)")));
        assert!(rich.spans.iter().any(|(range, style)| style.code && &rich.text[range.clone()] == "x"));
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
        assert_eq!(jumbo_size("😀😀", &HashMap::new()), 2);
        assert_eq!(jumbo_size("hello 😀", &HashMap::new()), 0);
    }
}
