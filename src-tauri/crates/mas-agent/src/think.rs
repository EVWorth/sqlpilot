//! Separating reasoning from an answer when the harness does not.
//!
//! ACP has an event for reasoning — `agent_thought_chunk` — and Copilot uses
//! it for some models. The model it currently defaults to instead writes its
//! reasoning inline as `<think>…</think>` in the ordinary message stream, and
//! the tags arrive split across chunks: `"<thi"`, `"nk>The user"`, and so on.
//!
//! Rendering that verbatim puts the model's private reasoning in the middle of
//! its answer, which is both wrong and jarring. Dropping it loses the part a
//! user often most wants to see. So it is split out, and the session view
//! shows it as reasoning — the same as it shows a harness that reports it
//! properly.
//!
//! The splitter is a state machine over a stream, not a regex over a string,
//! because there is no point at which the whole text exists.

/// Where the stream currently is.
#[derive(Debug, Default)]
pub struct ThinkSplitter {
    inside: bool,
    /// A partial tag held back, waiting for the rest of it. Never longer than
    /// the longest tag, so this cannot grow without bound.
    held: String,
}

/// A run of text, and what it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Piece {
    Answer(String),
    Thought(String),
}

const OPEN: &str = "<think>";
const CLOSE: &str = "</think>";

impl ThinkSplitter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk; get whatever can now be classified.
    ///
    /// Text that might be the start of a tag is held back until the next chunk
    /// settles it, which is why this returns nothing for `"<thi"`.
    pub fn push(&mut self, chunk: &str) -> Vec<Piece> {
        let mut buffer = std::mem::take(&mut self.held);
        buffer.push_str(chunk);

        let mut pieces = Vec::new();
        loop {
            let tag = if self.inside { CLOSE } else { OPEN };
            match buffer.find(tag) {
                Some(at) => {
                    let before = &buffer[..at];
                    if !before.is_empty() {
                        pieces.push(self.piece(before.to_string()));
                    }
                    self.inside = !self.inside;
                    buffer = buffer[at + tag.len()..].to_string();
                }
                None => {
                    // Hold back anything that could still turn into the tag we
                    // are watching for, and emit the rest.
                    let keep = partial_tail(&buffer, tag);
                    let split = buffer.len() - keep;
                    let emit = buffer[..split].to_string();
                    self.held = buffer[split..].to_string();
                    if !emit.is_empty() {
                        pieces.push(self.piece(emit));
                    }
                    return pieces;
                }
            }
        }
    }

    /// Whatever is still held, at the end of the stream.
    ///
    /// A stream that ends mid-tag — or inside an unclosed `<think>` — should
    /// not silently swallow its last few characters.
    pub fn finish(&mut self) -> Vec<Piece> {
        let rest = std::mem::take(&mut self.held);
        if rest.is_empty() {
            return Vec::new();
        }
        vec![self.piece(rest)]
    }

    fn piece(&self, text: String) -> Piece {
        if self.inside {
            Piece::Thought(text)
        } else {
            Piece::Answer(text)
        }
    }
}

/// How many trailing bytes of `text` are a prefix of `tag`.
///
/// `"...<thi"` with tag `<think>` gives 4, so those four bytes wait for the
/// next chunk. Byte comparison is safe here because both tags are ASCII and a
/// UTF-8 continuation byte can never equal `<`.
fn partial_tail(text: &str, tag: &str) -> usize {
    // At most the whole tag minus one byte — a complete tag is not a partial
    // one, it is a match, and `push` has already looked for it.
    let max = (tag.len() - 1).min(text.len());
    (1..=max)
        .rev()
        .find(|&n| {
            text.is_char_boundary(text.len() - n) && tag.starts_with(&text[text.len() - n..])
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feed chunks and collect everything, including whatever `finish` holds.
    fn run(chunks: &[&str]) -> Vec<Piece> {
        let mut splitter = ThinkSplitter::new();
        let mut pieces: Vec<Piece> = chunks.iter().flat_map(|c| splitter.push(c)).collect();
        pieces.extend(splitter.finish());
        pieces
    }

    fn answer(pieces: &[Piece]) -> String {
        pieces
            .iter()
            .filter_map(|p| match p {
                Piece::Answer(text) => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    fn thought(pieces: &[Piece]) -> String {
        pieces
            .iter()
            .filter_map(|p| match p {
                Piece::Thought(text) => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn text_with_no_reasoning_passes_straight_through() {
        assert_eq!(
            run(&["hello ", "world"]),
            vec![
                Piece::Answer("hello ".into()),
                Piece::Answer("world".into()),
            ]
        );
    }

    #[test]
    fn reasoning_is_separated_from_the_answer() {
        let pieces = run(&["<think>weighing it up</think>the answer"]);
        assert_eq!(thought(&pieces), "weighing it up");
        assert_eq!(answer(&pieces), "the answer");
    }

    #[test]
    fn a_tag_split_across_chunks_is_still_a_tag() {
        // The case that actually happens: "<thi" arrives, then "nk>The user".
        let pieces = run(&["<thi", "nk>The user", " asked", "</thi", "nk>", "pong"]);
        assert_eq!(thought(&pieces), "The user asked");
        assert_eq!(answer(&pieces), "pong");
    }

    #[test]
    fn a_partial_tag_is_held_rather_than_shown() {
        // Emitting "<thi" and then correcting it would flash the tag on
        // screen, which is worse than a few characters of latency.
        let mut splitter = ThinkSplitter::new();
        assert!(splitter.push("<thi").is_empty());
        assert_eq!(splitter.push("nk>x"), vec![Piece::Thought("x".into())]);
    }

    #[test]
    fn a_less_than_that_is_not_a_tag_comes_through() {
        let pieces = run(&["a < b", " and ", "c<d"]);
        assert_eq!(answer(&pieces), "a < b and c<d");
        assert!(thought(&pieces).is_empty());
    }

    #[test]
    fn text_held_at_the_end_of_a_stream_is_not_lost() {
        // A model whose last characters happen to look like the start of a tag
        // should not have them swallowed.
        let pieces = run(&["done<"]);
        assert_eq!(answer(&pieces), "done<");
    }

    #[test]
    fn an_unclosed_think_block_stays_reasoning() {
        // Better than retroactively reclassifying it as the answer, which
        // would put the model's reasoning in the transcript as its reply.
        let pieces = run(&["<think>still going"]);
        assert_eq!(thought(&pieces), "still going");
        assert!(answer(&pieces).is_empty());
    }

    #[test]
    fn several_blocks_in_one_stream_all_separate() {
        let pieces = run(&["<think>one</think>a<think>two</think>b"]);
        assert_eq!(thought(&pieces), "onetwo");
        assert_eq!(answer(&pieces), "ab");
    }

    #[test]
    fn multibyte_text_is_not_split_through_a_character() {
        // The holdback looks at trailing bytes; slicing through a UTF-8
        // sequence would panic.
        let pieces = run(&["héllo — ", "wörld"]);
        assert_eq!(answer(&pieces), "héllo — wörld");
    }

    #[test]
    fn an_empty_chunk_changes_nothing() {
        assert!(run(&[""]).is_empty());
    }

    #[test]
    fn the_held_buffer_cannot_grow_without_bound() {
        // Only a prefix of a tag is ever held, so a long stream of "<" does
        // not accumulate.
        let mut splitter = ThinkSplitter::new();
        for _ in 0..1000 {
            splitter.push("<<<<<<<<<<");
        }
        assert!(splitter.held.len() < CLOSE.len());
    }
}
