pub mod queue;

use log::{error, info};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
struct NfcPunchRequest {
    #[serde(rename = "nfcCardId")]
    nfc_card_id: String,
    #[serde(rename = "terminalSecret", skip_serializing_if = "Option::is_none")]
    terminal_secret: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct NfcPunchResponse {
    pub action: String,
    pub employee: Option<EmployeeInfo>,
    pub time: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct EmployeeInfo {
    #[serde(rename = "firstName")]
    pub first_name: String,
    #[serde(rename = "lastName")]
    pub last_name: String,
    #[serde(rename = "employeeNumber")]
    pub employee_number: String,
}

pub async fn nfc_punch(
    client: &reqwest::Client,
    api_url: &str,
    nfc_card_id: &str,
    terminal_secret: Option<&str>,
) -> Result<NfcPunchResponse, PunchError> {
    let url = format!("{api_url}/api/v1/time-entries/nfc-punch");
    let body = NfcPunchRequest {
        nfc_card_id: nfc_card_id.to_string(),
        terminal_secret: terminal_secret.map(|s| s.to_string()),
    };

    let resp = client
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| {
            error!("Network error: {e}");
            PunchError::Network(e.to_string())
        })?;

    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();

    match status {
        200 => {
            let data: NfcPunchResponse = serde_json::from_str(&text).map_err(|e| {
                error!("Parse error: {e}");
                PunchError::Parse(e.to_string())
            })?;
            info!(
                "Punch: {} - {} {}",
                data.action,
                data.employee
                    .as_ref()
                    .map(|e| format!("{} {}", e.first_name, e.last_name))
                    .unwrap_or_default(),
                data.time.as_deref().unwrap_or("")
            );
            Ok(data)
        }
        404 => Ok(NfcPunchResponse {
            action: "UNKNOWN".to_string(),
            employee: None,
            time: None,
            error: Some("Unbekannte Karte".to_string()),
        }),
        403 => Ok(NfcPunchResponse {
            action: "FORBIDDEN".to_string(),
            employee: None,
            time: None,
            error: Some("Zugriff verweigert".to_string()),
        }),
        409 => {
            let data: NfcPunchResponse =
                serde_json::from_str(&text).unwrap_or(NfcPunchResponse {
                    action: "BLOCKED".to_string(),
                    employee: None,
                    time: None,
                    error: Some("Gesperrt".to_string()),
                });
            Ok(data)
        }
        _ => Err(PunchError::Api(format!("HTTP {status}: {text}"))),
    }
}

#[derive(Debug)]
pub enum PunchError {
    Network(String),
    Parse(String),
    Api(String),
}
