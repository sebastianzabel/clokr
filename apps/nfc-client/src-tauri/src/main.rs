#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod commands;
mod config;
mod nfc;
mod tray;

use api::queue;
use log::info;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Listener, Manager};
use tauri_plugin_autostart::MacosLauncher;

pub struct AppState {
    pub config: Mutex<config::AppConfig>,
    pub reader_connected: Arc<AtomicBool>,
}

fn main() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // Hide from Dock on macOS (LSUIElement behavior)
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            let cfg = config::load_config();
            let reader_connected = Arc::new(AtomicBool::new(false));

            app.manage(AppState {
                config: Mutex::new(cfg),
                reader_connected: reader_connected.clone(),
            });

            // Setup system tray
            tray::setup_tray(app.handle())?;

            // Hide settings window on close (don't quit)
            if let Some(window) = app.get_webview_window("settings") {
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }

            // Spawn NFC polling thread
            let app_handle = app.handle().clone();
            nfc::spawn_nfc_thread(app_handle.clone(), reader_connected);

            // Listen for card scans and call API
            let handle_for_listener = app_handle.clone();
            app.listen("nfc:card-scanned", move |event: tauri::Event| {
                let uid = event.payload().trim_matches('"').to_string();
                let handle = handle_for_listener.clone();

                tauri::async_runtime::spawn(async move {
                    let (api_url, secret) = {
                        let state = handle.state::<AppState>();
                        let cfg = state.config.lock().unwrap();
                        (cfg.api_url.clone(), cfg.terminal_secret.clone())
                    };

                    let client = reqwest::Client::new();
                    match api::nfc_punch(&client, &api_url, &uid, secret.as_deref()).await {
                        Ok(resp) => {
                            let (title, body) = match resp.action.as_str() {
                                "IN" => {
                                    let name = resp
                                        .employee
                                        .as_ref()
                                        .map(|e| format!("{} {}", e.first_name, e.last_name))
                                        .unwrap_or_default();
                                    let time = format_time(&resp.time);
                                    (name, format!("Eingestempelt {time}"))
                                }
                                "OUT" => {
                                    let name = resp
                                        .employee
                                        .as_ref()
                                        .map(|e| format!("{} {}", e.first_name, e.last_name))
                                        .unwrap_or_default();
                                    let time = format_time(&resp.time);
                                    (name, format!("Ausgestempelt {time}"))
                                }
                                "BLOCKED" => {
                                    let name = resp
                                        .employee
                                        .as_ref()
                                        .map(|e| format!("{} {}", e.first_name, e.last_name))
                                        .unwrap_or_default();
                                    (name, "Gesperrt (Urlaub genehmigt)".to_string())
                                }
                                "UNKNOWN" => {
                                    ("Unbekannte Karte".to_string(), uid.clone())
                                }
                                "FORBIDDEN" => {
                                    ("Zugriff verweigert".to_string(), "Mitarbeiter deaktiviert oder falsches Secret".to_string())
                                }
                                _ => ("Clokr".to_string(), resp.action.clone()),
                            };

                            send_notification(&handle, &title, &body);
                        }
                        Err(api::PunchError::Network(_)) => {
                            // Queue for retry
                            queue::enqueue(&uid, secret.as_deref());
                            let queue_size = queue::load_queue().len();
                            let _ = handle.emit("nfc:queue-size", queue_size);
                            send_notification(
                                &handle,
                                "Offline",
                                "Stempelung gespeichert (Warteschlange)",
                            );
                        }
                        Err(e) => {
                            send_notification(
                                &handle,
                                "Fehler",
                                &format!("{e:?}"),
                            );
                        }
                    }
                });
            });

            // Spawn queue retry task
            let handle_for_queue = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;

                    let (api_url, _) = {
                        let state = handle_for_queue.state::<AppState>();
                        let cfg = state.config.lock().unwrap();
                        (cfg.api_url.clone(), cfg.terminal_secret.clone())
                    };

                    let client = reqwest::Client::new();
                    let flushed = queue::flush_queue(&client, &api_url).await;
                    if flushed > 0 {
                        info!("Flushed {flushed} queued punches");
                        let remaining = queue::load_queue().len();
                        let _ = handle_for_queue.emit("nfc:queue-size", remaining);
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_config,
            commands::get_reader_status,
            commands::get_queue_size,
        ])
        .run(tauri::generate_context!())
        .expect("error running Clokr NFC client");
}

fn format_time(iso: &Option<String>) -> String {
    iso.as_ref()
        .and_then(|t| {
            chrono::DateTime::parse_from_rfc3339(t)
                .ok()
                .map(|dt| dt.format("%H:%M").to_string())
        })
        .unwrap_or_else(|| "—".to_string())
}

fn send_notification(app: &tauri::AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();
}
