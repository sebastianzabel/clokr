use chrono::{DateTime, Utc};
use log::{error, info};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const MAX_QUEUE_SIZE: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueuedPunch {
    pub nfc_card_id: String,
    pub terminal_secret: Option<String>,
    pub scanned_at: DateTime<Utc>,
    pub retry_count: u32,
}

fn queue_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("com.clokr.nfc-client").join("queue.json")
}

pub fn load_queue() -> Vec<QueuedPunch> {
    let path = queue_path();
    match fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub fn save_queue(queue: &[QueuedPunch]) -> Result<(), String> {
    let path = queue_path();
    let json = serde_json::to_string_pretty(queue).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

pub fn enqueue(nfc_card_id: &str, terminal_secret: Option<&str>) {
    let mut queue = load_queue();
    if queue.len() >= MAX_QUEUE_SIZE {
        queue.remove(0); // Drop oldest
    }
    queue.push(QueuedPunch {
        nfc_card_id: nfc_card_id.to_string(),
        terminal_secret: terminal_secret.map(|s| s.to_string()),
        scanned_at: Utc::now(),
        retry_count: 0,
    });
    if let Err(e) = save_queue(&queue) {
        error!("Failed to save queue: {e}");
    }
    info!("Queued punch for {nfc_card_id} (queue size: {})", queue.len());
}

pub async fn flush_queue(client: &reqwest::Client, api_url: &str) -> usize {
    let mut queue = load_queue();
    if queue.is_empty() {
        return 0;
    }

    let mut flushed = 0;
    let mut remaining = Vec::new();

    for mut punch in queue.drain(..) {
        match super::nfc_punch(
            client,
            api_url,
            &punch.nfc_card_id,
            punch.terminal_secret.as_deref(),
        )
        .await
        {
            Ok(_) => {
                info!("Flushed queued punch for {}", punch.nfc_card_id);
                flushed += 1;
            }
            Err(super::PunchError::Network(_)) => {
                punch.retry_count += 1;
                remaining.push(punch);
                break; // Stop flushing, API is still down
            }
            Err(_) => {
                // Non-network error (404, 403) — discard, not retryable
                info!("Discarding queued punch for {} (non-retryable)", punch.nfc_card_id);
                flushed += 1;
            }
        }
    }

    // Keep any remaining items after the failed one
    if let Err(e) = save_queue(&remaining) {
        error!("Failed to save queue after flush: {e}");
    }

    flushed
}
