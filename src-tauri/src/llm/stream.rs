#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessResult {
    Emit(String),   // clean delta to send as Token
    Stop(String),   // final delta (may be empty), generation should halt
    Continue,       // nothing to emit yet
}

pub struct StreamPostProcessor {
    stop_sequences: Vec<String>,
    pub(crate) accumulated: String,
    pub(crate) emitted_len: usize,
}

impl StreamPostProcessor {
    pub fn new(stop_sequences: Vec<String>) -> Self {
        Self {
            stop_sequences,
            accumulated: String::new(),
            emitted_len: 0,
        }
    }

    #[allow(dead_code)]
    pub fn push(&mut self, delta: &str) -> ProcessResult {
        self.accumulated.push_str(delta);
        self.process()
    }

    pub fn push_all(&mut self, full_text: &str) -> ProcessResult {
        self.accumulated = full_text.to_string();
        self.process()
    }

    pub fn process(&mut self) -> ProcessResult {
        // Drop leading whitespace/newlines: models frequently open with '\n',
        // which must not trigger the '\n' stop sequence or be emitted as ghost text.
        let current_text = self.accumulated.trim_start();

        // Check stop sequences
        let mut earliest_stop = None;
        for stop_seq in &self.stop_sequences {
            let mut start_search = 0;
            while let Some(relative_idx) = current_text[start_search..].find(stop_seq) {
                let idx = start_search + relative_idx;
                
                if stop_seq == "." && !is_sentence_end_period(current_text, idx) {
                    start_search = idx + stop_seq.len();
                    continue;
                }

                match earliest_stop {
                    None => earliest_stop = Some((idx, stop_seq.len(), stop_seq.clone())),
                    Some((earliest_idx, _, _)) if idx < earliest_idx => {
                        earliest_stop = Some((idx, stop_seq.len(), stop_seq.clone()));
                    }
                    _ => {}
                }
                break;
            }
        }

        if let Some((idx, len, stop_seq)) = earliest_stop {
            let include_len = if stop_seq == "." {
                len
            } else {
                0
            };
            let final_text = &current_text[..idx + include_len];
            if final_text.len() > self.emitted_len {
                let new_part = &final_text[self.emitted_len..];
                self.emitted_len = final_text.len();
                ProcessResult::Stop(new_part.to_string())
            } else {
                ProcessResult::Stop(String::new())
            }
        } else {
            if current_text.len() > self.emitted_len {
                let new_part = &current_text[self.emitted_len..];
                self.emitted_len = current_text.len();
                ProcessResult::Emit(new_part.to_string())
            } else {
                ProcessResult::Continue
            }
        }
    }
}

/// Check if the period character at `idx` in `text` is the end of a sentence
/// (excluding abbreviations, acronyms, or multiple consecutive periods/ellipses).
fn is_sentence_end_period(text: &str, idx: usize) -> bool {
    let bytes = text.as_bytes();
    // 1. Check for ellipsis / multiple dots
    if idx > 0 && bytes[idx - 1] == b'.' {
        return false;
    }
    if idx + 1 < bytes.len() && bytes[idx + 1] == b'.' {
        return false;
    }

    // 2. Extract the word immediately preceding the period
    let mut start = idx;
    while start > 0 {
        let prev_char = text[..start].chars().next_back().unwrap();
        if prev_char.is_alphanumeric() || prev_char == '\'' || prev_char == '-' {
            start -= prev_char.len_utf8();
        } else {
            break;
        }
    }
    let word = &text[start..idx];
    if word.is_empty() {
        return true;
    }

    // 3. Check for single-letter initials (middle initials, acronyms like U.S.)
    if word.chars().count() == 1 && word.chars().next().unwrap().is_alphabetic() {
        return false;
    }

    // 4. Check against common abbreviations
    let lower_word = word.to_lowercase();
    let common_abbrevs = [
        "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "vs", "ie", "eg", "etc", 
        "al", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
        "st", "rd", "th", "ave", "blvd", "co", "corp", "inc", "ltd", "approx", "ca"
    ];
    if common_abbrevs.contains(&lower_word.as_str()) {
        return false;
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_sentence_end_period() {
        // End of sentence
        assert!(is_sentence_end_period("Hello world.", 11));
        assert!(is_sentence_end_period("This is a sentence. And another.", 18));
        assert!(is_sentence_end_period("This is a sentence. And another.", 31));

        // Ellipsis / multiple dots
        assert!(!is_sentence_end_period("Wait...", 4));
        assert!(!is_sentence_end_period("Wait...", 5));
        assert!(!is_sentence_end_period("Wait...", 6));

        // Acronyms / initials
        assert!(!is_sentence_end_period("U.S.A.", 1));
        assert!(!is_sentence_end_period("U.S.A.", 3));
        assert!(!is_sentence_end_period("U.S.A.", 5));
        
        // Abbreviations
        assert!(!is_sentence_end_period("Mr. Smith", 2));
        assert!(!is_sentence_end_period("i.e. something", 3));
        assert!(!is_sentence_end_period("etc. and so on", 3));
    }

    #[test]
    fn test_leading_whitespace_trim() {
        let mut processor = StreamPostProcessor::new(vec!["\n".to_string()]);
        
        // Feeding initial newlines/whitespace
        assert_eq!(processor.push("\n"), ProcessResult::Continue);
        assert_eq!(processor.push("   "), ProcessResult::Continue);
        
        // Emitting actual text
        assert_eq!(processor.push("Hello"), ProcessResult::Emit("Hello".to_string()));
        
        // Stop sequence check
        assert_eq!(processor.push("\n"), ProcessResult::Stop("".to_string()));
    }

    #[test]
    fn test_period_heuristic() {
        let mut processor = StreamPostProcessor::new(vec![".".to_string()]);
        
        // Mr. shouldn't trigger period stop
        assert_eq!(processor.push("Mr"), ProcessResult::Emit("Mr".to_string()));
        assert_eq!(processor.push("."), ProcessResult::Emit(".".to_string()));
        
        // Space
        assert_eq!(processor.push(" "), ProcessResult::Emit(" ".to_string()));
        
        // Smith. should trigger period stop
        assert_eq!(processor.push("Smith"), ProcessResult::Emit("Smith".to_string()));
        assert_eq!(processor.push("."), ProcessResult::Stop(".".to_string()));
    }

    #[test]
    fn test_stop_at_mid_word_boundary() {
        let mut processor = StreamPostProcessor::new(vec!["stop".to_string()]);
        
        assert_eq!(processor.push("hel"), ProcessResult::Emit("hel".to_string()));
        assert_eq!(processor.push("lost"), ProcessResult::Emit("lost".to_string()));
        assert_eq!(processor.push("op"), ProcessResult::Stop("".to_string()));
    }

    #[test]
    fn test_stop_sequence_at_position_0() {
        let mut processor = StreamPostProcessor::new(vec!["stop".to_string()]);
        
        assert_eq!(processor.push("stop"), ProcessResult::Stop("".to_string()));
    }

    #[test]
    fn test_multiple_overlapping_stop_sequences() {
        let mut processor = StreamPostProcessor::new(vec!["stop".to_string(), "top".to_string()]);
        
        assert_eq!(processor.push("astop"), ProcessResult::Stop("a".to_string()));
    }
}
