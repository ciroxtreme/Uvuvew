use std::path::PathBuf;
use url::Url;
use cfsolve::browser::Browser;
use cfsolve::solver::Options;
use wreq::header::HeaderValue;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let profile_path = PathBuf::from("profiles/safari-26-ios.json");
    eprintln!("[*] Loading browser profile...");
    let browser = Browser::load(&profile_path).await?;
    let options = Options::default();

    let page_url = Url::parse("https://www.bmkg.go.id/cuaca/radar")?;
    eprintln!("[*] Clearing Cloudflare challenge for BMKG...");
    let clearance = browser.clear(&page_url, &options).await?;
    eprintln!("[+] Challenge cleared successfully!");

    // Extract auth token from cleared HTML
    let html = &clearance.html;
    let token_pattern = "$sauth-token\":147";
    // Find auth token string
    let mut auth_token = String::new();
    if let Some(idx) = html.find("$sauth-token") {
        let snippet = &html[idx..std::cmp::min(idx + 300, html.len())];
        for part in snippet.split('"') {
            if part.starts_with("Ec8") || part.contains(".eyJ") {
                auth_token = part.to_string();
                break;
            }
        }
    }

    if auth_token.is_empty() {
        eprintln!("[!] Warning: Could not find auth-token in HTML, falling back to regex search");
    } else {
        eprintln!("[+] Found X-API-KEY: {}", auth_token);
    }

    // Now request /api/cuaca/radar/layers using the SAME BrowserClient session
    let layers_url = Url::parse("https://www.bmkg.go.id/api/cuaca/radar/layers")?;
    let mut req = wreq::Request::builder()
        .method(wreq::Method::GET)
        .uri(layers_url.as_str());

    if !auth_token.is_empty() {
        req = req.header("x-api-key", HeaderValue::from_str(&auth_token)?);
    }
    req = req.header("referer", HeaderValue::from_static("https://www.bmkg.go.id/cuaca/radar"));
    req = req.header("accept", HeaderValue::from_static("application/json"));

    let client = &clearance.client;
    let res = client.execute(req.body(Default::default())?).await?;
    eprintln!("[*] Layers API status: {}", res.status());
    let body_bytes = res.into_body().collect().await?.to_bytes();
    let body_str = String::from_utf8_lossy(&body_bytes);
    println!("LAYERS_JSON: {}", body_str);

    // Parse layers and download sample WMS tile
    let json_val: serde_json::Value = serde_json::from_str(&body_str)?;
    if let Some(first_layer) = json_val["layers"].as_array().and_then(|a| a.first()) {
        let layer_name = first_layer["name"].as_str().unwrap_or("");
        eprintln!("[*] Downloading latest radar tile for layer: {}", layer_name);

        let wms_url = format!(
            "https://www.bmkg.go.id/cuaca/radar/wms?service=WMS&request=GetMap&layers={}&styles=CMAX_dBZ&format=image%2Fpng&transparent=true&version=1.1.1&width=512&height=512&srs=EPSG%3A3857&bbox=11577201,-390197,11799834,-222684",
            urlencoding::encode(layer_name)
        );

        let mut tile_req = wreq::Request::builder()
            .method(wreq::Method::GET)
            .uri(&wms_url)
            .header("referer", HeaderValue::from_static("https://www.bmkg.go.id/cuaca/radar"))
            .header("accept", HeaderValue::from_static("image/png,*/*"));

        if !auth_token.is_empty() {
            tile_req = tile_req.header("x-api-key", HeaderValue::from_str(&auth_token)?);
        }

        let tile_res = client.execute(tile_req.body(Default::default())?).await?;
        eprintln!("[*] Tile response status: {}", tile_res.status());
        let tile_bytes = tile_res.into_body().collect().await?.to_bytes();
        std::fs::write("/home/container/files/radar_bmkg_latest.png", &tile_bytes)?;
        eprintln!("[+] Saved radar tile image ({} bytes) to /home/container/files/radar_bmkg_latest.png", tile_bytes.len());
    }

    Ok(())
}
