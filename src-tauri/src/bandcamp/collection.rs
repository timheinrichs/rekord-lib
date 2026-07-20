use serde_json::Value;

use crate::bandcamp::session::Session;
use crate::error::{AppError, AppResult};
use crate::metadata::net;
use crate::models::BandcampItem;

/// Fetches the (purchased) collection of the connected account.
pub async fn list(session: &Session) -> AppResult<Vec<BandcampItem>> {
    let client = net::client()?;

    let body = serde_json::json!({
        "fan_id": session.fan_id,
        // Very large token => newest entries first.
        "older_than_token": "9999999999::a::",
        "count": 200
    });

    let resp = client
        .post("https://bandcamp.com/api/fancollection/1/collection_items")
        .header("Cookie", &session.cookie_header)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Bandcamp(format!("collection_items: {e}")))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| AppError::Bandcamp(e.to_string()))?;

    if !status.is_success() {
        return Err(AppError::Bandcamp(format!(
            "collection_items HTTP {status}: {}",
            text.chars().take(200).collect::<String>()
        )));
    }

    let json: Value = serde_json::from_str(&text)
        .map_err(|e| AppError::Bandcamp(format!("collection_items JSON: {e}")))?;

    // Bandcamp reports errors as 200 with {"error":true,...}.
    if json.get("error").and_then(Value::as_bool) == Some(true) {
        return Err(AppError::Bandcamp(format!(
            "collection_items: {}",
            json.get("error_message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
        )));
    }

    let redownload = json.get("redownload_urls").cloned().unwrap_or(Value::Null);
    let items = json
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    Ok(items
        .iter()
        .filter_map(|it| parse_item(it, &redownload))
        .collect())
}

/// Converts a collection_items entry into a [`BandcampItem`].
fn parse_item(it: &Value, redownload: &Value) -> Option<BandcampItem> {
    let sale_item_id = it.get("sale_item_id").and_then(Value::as_i64)?;
    let sale_item_type = it
        .get("sale_item_type")
        .and_then(Value::as_str)
        .unwrap_or("p");
    let key = format!("{sale_item_type}{sale_item_id}");

    let title = it
        .get("item_title")
        .and_then(Value::as_str)
        .or_else(|| it.get("album_title").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();

    let band_name = it
        .get("band_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let item_type = it
        .get("item_type")
        .and_then(Value::as_str)
        .unwrap_or("album")
        .to_string();

    let art_url = it
        .get("item_art_id")
        .and_then(Value::as_i64)
        .map(|id| format!("https://f4.bcbits.com/img/a{id:010}_9.jpg"));

    let download_page_url = redownload
        .get(&key)
        .and_then(Value::as_str)
        .map(String::from);

    Some(BandcampItem {
        key,
        title,
        band_name,
        item_type,
        art_url,
        download_page_url,
    })
}
