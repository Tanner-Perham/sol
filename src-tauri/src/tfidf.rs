use std::collections::{HashMap, HashSet};

/// Simple tokenizer that splits text into lowercase words
fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|s| s.len() >= 3 && s.len() <= 25) // Skip very short or very long tokens
        .filter(|s| !s.chars().all(|c| c.is_numeric())) // Skip pure numbers
        .map(|s| s.trim_matches('\'').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Comprehensive stopword list
fn is_stopword(word: &str) -> bool {
    const STOPWORDS: &[&str] = &[
        // Common English stopwords
        "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
        "her", "was", "one", "our", "out", "has", "have", "been", "were", "they",
        "this", "that", "with", "from", "what", "when", "where", "which", "who",
        "will", "would", "there", "their", "about", "into", "more", "some", "than",
        "them", "then", "these", "could", "other", "just", "also", "only", "your",
        "very", "should", "now", "such", "like", "being", "over", "because",
        "through", "before", "after", "most", "same", "how", "its", "may", "each",
        "make", "way", "could", "been", "call", "who", "oil", "its", "find",
        "long", "down", "day", "did", "get", "come", "made", "part", "take",
        "got", "here", "much", "still", "well", "back", "even", "want", "first",
        "any", "new", "work", "know", "need", "feel", "right", "use", "think",
        "good", "look", "help", "going", "really", "something", "anything",
        "everything", "nothing", "things", "thing", "using", "used", "does",
        "don", "doesn", "didn", "won", "wouldn", "couldn", "shouldn", "isn",
        "aren", "wasn", "weren", "haven", "hasn", "hadn", "let", "say", "said",
        "see", "seen", "able", "lot", "lots", "many", "must", "might", "maybe",
        "without", "within", "while", "always", "often", "never", "sometimes",
        "actually", "probably", "basically", "definitely", "certainly",
        "however", "therefore", "although", "though", "already", "yet",
        "another", "both", "either", "neither", "whether", "rather", "quite",
        "enough", "almost", "around", "since", "until", "during", "between",
        "under", "above", "below", "again", "once", "ever", "every", "few",
        "those", "own", "why", "too", "else", "keep", "put", "set", "seem",
        "show", "try", "ask", "tell", "give", "mean", "means", "point",
        // Markdown/document terms
        "http", "https", "www", "com", "org", "net", "html", "markdown", "note",
        "notes", "file", "files", "link", "links", "page", "pages", "image",
        "images", "text", "document", "documents", "section", "sections",
        // Common verbs
        "create", "created", "creating", "update", "updated", "updating",
        "add", "added", "adding", "remove", "removed", "removing",
        "change", "changed", "changing", "move", "moved", "moving",
        "start", "started", "starting", "end", "ended", "ending",
        "write", "wrote", "written", "writing", "read", "reading",
    ];
    STOPWORDS.contains(&word)
}

/// Check if a word looks like a meaningful term (not gibberish)
fn is_meaningful_term(word: &str) -> bool {
    // Must have at least one vowel
    let has_vowel = word.chars().any(|c| "aeiou".contains(c));

    // Must not be all consonants or all vowels
    let vowel_count = word.chars().filter(|c| "aeiou".contains(*c)).count();
    let consonant_count = word.len() - vowel_count;

    // Reasonable vowel/consonant ratio
    let ratio_ok = vowel_count > 0 && consonant_count > 0 &&
                   (vowel_count as f32 / word.len() as f32) > 0.15 &&
                   (vowel_count as f32 / word.len() as f32) < 0.8;

    // No more than 3 consecutive consonants
    let mut consecutive_consonants = 0;
    let mut max_consecutive = 0;
    for c in word.chars() {
        if !"aeiou".contains(c) {
            consecutive_consonants += 1;
            max_consecutive = max_consecutive.max(consecutive_consonants);
        } else {
            consecutive_consonants = 0;
        }
    }

    has_vowel && ratio_ok && max_consecutive <= 4
}

/// Extract bigrams (two-word phrases) from tokens
fn extract_bigrams(tokens: &[String]) -> Vec<String> {
    if tokens.len() < 2 {
        return Vec::new();
    }

    tokens.windows(2)
        .filter(|pair| !is_stopword(&pair[0]) && !is_stopword(&pair[1]))
        .filter(|pair| is_meaningful_term(&pair[0]) && is_meaningful_term(&pair[1]))
        .map(|pair| format!("{} {}", pair[0], pair[1]))
        .collect()
}

/// Compute term frequency for a document
fn compute_tf(tokens: &[String], bigrams: &[String]) -> HashMap<String, f32> {
    let mut tf: HashMap<String, f32> = HashMap::new();

    // Count unigrams
    for token in tokens {
        if !is_stopword(token) && is_meaningful_term(token) {
            *tf.entry(token.clone()).or_insert(0.0) += 1.0;
        }
    }

    // Count bigrams (weighted higher)
    for bigram in bigrams {
        *tf.entry(bigram.clone()).or_insert(0.0) += 2.0;
    }

    // Normalize
    let total: f32 = tf.values().sum();
    if total > 0.0 {
        for count in tf.values_mut() {
            *count /= total;
        }
    }

    tf
}

/// c-TF-IDF: Class-based TF-IDF for finding representative terms of a cluster
pub struct CTfIdf {
    cluster_tf: HashMap<usize, HashMap<String, f32>>,
    df: HashMap<String, usize>,
    num_clusters: usize,
}

impl CTfIdf {
    /// Build c-TF-IDF from documents and their cluster assignments
    pub fn new(documents: &[String], cluster_ids: &[usize]) -> Self {
        let num_clusters = cluster_ids.iter().max().map(|&x| x + 1).unwrap_or(0);
        let mut cluster_tf: HashMap<usize, HashMap<String, f32>> = HashMap::new();
        let mut df: HashMap<String, HashSet<usize>> = HashMap::new();

        for (doc, &cluster_id) in documents.iter().zip(cluster_ids.iter()) {
            let tokens = tokenize(doc);
            let bigrams = extract_bigrams(&tokens);
            let doc_tf = compute_tf(&tokens, &bigrams);

            let cluster_entry = cluster_tf.entry(cluster_id).or_default();

            for (term, freq) in doc_tf {
                *cluster_entry.entry(term.clone()).or_insert(0.0) += freq;
                df.entry(term).or_default().insert(cluster_id);
            }
        }

        let df: HashMap<String, usize> = df.into_iter()
            .map(|(term, clusters)| (term, clusters.len()))
            .collect();

        Self {
            cluster_tf,
            df,
            num_clusters,
        }
    }

    /// Get top-k terms for a cluster, ranked by c-TF-IDF score
    pub fn top_terms(&self, cluster_id: usize, k: usize) -> Vec<(String, f32)> {
        let Some(tf) = self.cluster_tf.get(&cluster_id) else {
            return Vec::new();
        };

        let mut scores: Vec<(String, f32)> = tf.iter()
            .filter(|(term, _)| {
                // Prefer bigrams and longer meaningful terms
                term.contains(' ') || term.len() >= 4
            })
            .map(|(term, &tf_score)| {
                let df_count = self.df.get(term).copied().unwrap_or(1) as f32;
                let idf = (self.num_clusters as f32 / df_count).ln() + 1.0;

                // Boost bigrams
                let boost = if term.contains(' ') { 1.5 } else { 1.0 };

                (term.clone(), tf_score * idf * boost)
            })
            .collect();

        scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scores.truncate(k);
        scores
    }

    /// Generate a readable label for a cluster from its top terms
    pub fn generate_label(&self, cluster_id: usize) -> String {
        let top = self.top_terms(cluster_id, 5);

        if top.is_empty() {
            return format!("Topic {}", cluster_id + 1);
        }

        // Prefer a bigram if available, otherwise use top 2 terms
        for (term, _) in &top {
            if term.contains(' ') {
                // Capitalize each word
                return term.split_whitespace()
                    .map(|w| {
                        let mut chars = w.chars();
                        match chars.next() {
                            None => String::new(),
                            Some(c) => c.to_uppercase().chain(chars).collect(),
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
            }
        }

        // Fall back to top 2 single terms
        top.iter()
            .take(2)
            .map(|(term, _)| {
                let mut chars = term.chars();
                match chars.next() {
                    None => String::new(),
                    Some(c) => c.to_uppercase().chain(chars).collect(),
                }
            })
            .collect::<Vec<_>>()
            .join(" & ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tokenize() {
        let tokens = tokenize("Hello, World! This is a test.");
        assert!(tokens.contains(&"hello".to_string()));
        assert!(tokens.contains(&"world".to_string()));
        assert!(tokens.contains(&"test".to_string()));
    }

    #[test]
    fn test_meaningful_term() {
        assert!(is_meaningful_term("programming"));
        assert!(is_meaningful_term("data"));
        assert!(!is_meaningful_term("xyzqw")); // No vowels in right places
    }

    #[test]
    fn test_bigrams() {
        let tokens = vec![
            "machine".to_string(),
            "learning".to_string(),
            "algorithm".to_string(),
        ];
        let bigrams = extract_bigrams(&tokens);
        assert!(bigrams.contains(&"machine learning".to_string()));
    }
}
