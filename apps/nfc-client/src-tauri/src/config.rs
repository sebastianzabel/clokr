use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub api_url: String,
    pub terminal_secret: Option<String>,
    pub auto_start: bool,
    pub sound_enabled: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            api_url: "http://localhost:4000".to_string(),
            terminal_secret: None,
            auto_start: false,
            sound_enabled: true,
        }
    }
}

fn config_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("com.clokr.nfc-client");
    fs::create_dir_all(&dir).ok();
    dir.join("config.json")
}

pub fn load_config() -> AppConfig {
    let path = config_path();
    match fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => {
            let config = AppConfig::default();
            save_config(&config).ok();
            config
        }
    }
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let path = config_path();
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}
