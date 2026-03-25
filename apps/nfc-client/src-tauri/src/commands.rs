use crate::config;
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> config::AppConfig {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_config(
    state: State<'_, AppState>,
    config: config::AppConfig,
) -> Result<(), String> {
    config::save_config(&config)?;
    *state.config.lock().unwrap() = config;
    Ok(())
}

#[tauri::command]
pub fn get_reader_status(state: State<'_, AppState>) -> bool {
    state
        .reader_connected
        .load(std::sync::atomic::Ordering::SeqCst)
}

#[tauri::command]
pub fn get_queue_size() -> usize {
    crate::api::queue::load_queue().len()
}
