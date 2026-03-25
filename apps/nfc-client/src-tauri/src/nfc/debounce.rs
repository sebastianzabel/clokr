use std::collections::HashMap;
use std::time::{Duration, Instant};

const DEBOUNCE_SECS: u64 = 5;

pub struct Debouncer {
    last_seen: HashMap<String, Instant>,
}

impl Debouncer {
    pub fn new() -> Self {
        Self {
            last_seen: HashMap::new(),
        }
    }

    /// Returns true if this UID should be processed (not debounced).
    pub fn should_process(&mut self, uid: &str) -> bool {
        let now = Instant::now();
        if let Some(last) = self.last_seen.get(uid) {
            if now.duration_since(*last) < Duration::from_secs(DEBOUNCE_SECS) {
                return false;
            }
        }
        self.last_seen.insert(uid.to_string(), now);
        // Clean old entries
        self.last_seen
            .retain(|_, t| now.duration_since(*t) < Duration::from_secs(30));
        true
    }
}
