pub mod debounce;

use debounce::Debouncer;
use log::{error, info, warn};
use pcsc::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// GET DATA APDU command to read card UID
const GET_UID_APDU: [u8; 5] = [0xFF, 0xCA, 0x00, 0x00, 0x00];

/// Spawn the NFC polling thread. Returns a handle to check reader status.
pub fn spawn_nfc_thread(app: AppHandle, reader_connected: Arc<AtomicBool>) {
    thread::spawn(move || {
        let mut debouncer = Debouncer::new();

        loop {
            match Context::establish(Scope::System) {
                Ok(ctx) => poll_loop(&ctx, &app, &mut debouncer, &reader_connected),
                Err(e) => {
                    error!("PC/SC context failed: {e}");
                    reader_connected.store(false, Ordering::SeqCst);
                    let _ = app.emit("nfc:reader-status", false);
                }
            }
            // Retry after delay
            thread::sleep(Duration::from_secs(3));
        }
    });
}

fn poll_loop(
    ctx: &Context,
    app: &AppHandle,
    debouncer: &mut Debouncer,
    reader_connected: &Arc<AtomicBool>,
) {
    loop {
        // List available readers
        let mut readers_buf = [0u8; 2048];
        let readers = match ctx.list_readers(&mut readers_buf) {
            Ok(r) => r,
            Err(e) => {
                warn!("Failed to list readers: {e}");
                reader_connected.store(false, Ordering::SeqCst);
                let _ = app.emit("nfc:reader-status", false);
                thread::sleep(Duration::from_secs(2));
                return; // Re-establish context
            }
        };

        let reader_names: Vec<_> = readers.collect();
        if reader_names.is_empty() {
            if reader_connected.swap(false, Ordering::SeqCst) {
                info!("No readers found");
                let _ = app.emit("nfc:reader-status", false);
            }
            thread::sleep(Duration::from_secs(2));
            continue;
        }

        let reader = reader_names[0];
        if !reader_connected.swap(true, Ordering::SeqCst) {
            info!("Reader connected: {:?}", reader.to_str());
            let _ = app.emit("nfc:reader-status", true);
        }

        // Wait for card
        let mut reader_states = vec![ReaderState::new(reader, State::UNAWARE)];
        match ctx.get_status_change(Duration::from_secs(1), &mut reader_states) {
            Ok(()) => {}
            Err(Error::Timeout) => continue,
            Err(e) => {
                warn!("Status change error: {e}");
                reader_connected.store(false, Ordering::SeqCst);
                let _ = app.emit("nfc:reader-status", false);
                return;
            }
        }

        let state = reader_states[0].event_state();
        if !state.contains(State::PRESENT) {
            continue;
        }

        // Card is present — connect and read UID
        match ctx.connect(reader, ShareMode::Shared, Protocols::ANY) {
            Ok(card) => {
                let mut response = [0u8; 256];
                match card.transmit(&GET_UID_APDU, &mut response) {
                    Ok(data) => {
                        // Last 2 bytes are SW1 SW2 (0x90 0x00 = success)
                        if data.len() >= 2 {
                            let sw = &data[data.len() - 2..];
                            if sw == [0x90, 0x00] {
                                let uid_bytes = &data[..data.len() - 2];
                                let uid: String = uid_bytes
                                    .iter()
                                    .map(|b| format!("{b:02X}"))
                                    .collect();

                                if debouncer.should_process(&uid) {
                                    info!("Card scanned: {uid}");
                                    let _ = app.emit("nfc:card-scanned", uid.clone());
                                }
                            }
                        }
                    }
                    Err(e) => warn!("APDU transmit failed: {e}"),
                }
            }
            Err(e) => warn!("Card connect failed: {e}"),
        }

        // Wait for card removal before next poll
        let mut remove_states = vec![ReaderState::new(reader, State::PRESENT)];
        let _ = ctx.get_status_change(Duration::from_secs(10), &mut remove_states);
    }
}
