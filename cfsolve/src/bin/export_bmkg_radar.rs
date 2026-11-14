use std::env;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use cfsolve::{Browser, Options};
use http_body_util::BodyExt;
use tokio::runtime::Builder;
use url::Url;

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    let out_dir = if args.len() > 1 {
        &args[1]
    } else {
        "."
    };

    let fingerprint_candidates = [
        "cfsolve/profiles/safari-26-ios.json",
        "profiles/safari-26-ios.json",
        "/home/container/files/cfsolve-repo/profiles/safari-26-ios.json"
    ];

    let mut profile_path = PathBuf::from("cfsolve/profiles/safari-26-ios.json");
    for cand in &fingerprint_candidates {
        if Path::new(cand).exists() {
            profile_path = PathBuf::from(cand);
            break;
        }
    }

    eprintln!("[*] Memuat fingerprint browser: {:?}", profile_path);
    let browser = Browser::read(&profile_path)?;
    let options = Options::default();

    let runtime = Builder::new_multi_thread().enable_all().build()?;
    runtime.block_on(async {
        eprintln!("[1] Memulai bypass Cloudflare Turnstile di bmkg.go.id/cuaca/radar...");
        let base_url = Url::parse("https://www.bmkg.go.id/cuaca/radar")?;
        let client = browser.client(&options)?;
        
        let clearance = browser.solve_with_client(&client, &base_url, &options).await?;
        eprintln!("[+] Cloudflare Berhasil Ditembus!");

        let html = &clearance.page.html;
        let mut auth_token = String::new();
        if let Some(idx) = html.find("$sauth-token") {
            let snippet = &html[idx..std::cmp::min(idx + 350, html.len())];
            for part in snippet.split('"') {
                if part.starts_with("ED") || part.starts_with("Ec") || part.starts_with("xp") || part.starts_with("Pp") || (part.len() > 40 && part.contains(".eyJ")) {
                    auth_token = part.to_string();
                    break;
                }
            }
        }
        eprintln!("[+] Auth Token BMKG: {}", auth_token);

        eprintln!("[2] Mengambil metadata daftar frame radar...");
        let mut layers_req = client.http
            .get("https://www.bmkg.go.id/api/cuaca/radar/layers")
            .header("Referer", "https://www.bmkg.go.id/cuaca/radar")
            .header("Accept", "application/json, text/plain, */*");

        if !auth_token.is_empty() {
            layers_req = layers_req.header("X-API-KEY", &auth_token);
        }

        let layers_resp = layers_req.send().await?;
        let layers_bytes = layers_resp.collect().await?.to_bytes();
        let layers_str = String::from_utf8_lossy(&layers_bytes);

        let json_val: serde_json::Value = serde_json::from_str(&layers_str)?;
        let raw_layers = json_val["layers"].as_array().context("No layers in response")?;
        
        // Ambil 8 frame terakhir untuk animasi radar
        let frame_count = std::cmp::min(8, raw_layers.len());
        let mut frames_meta = Vec::new();

        eprintln!("[3] Mengunduh {} citra radar (All Sumatera)...", frame_count);

        let bbox = "10519692,-691532,11911186,691532";

        for (i, layer) in raw_layers[..frame_count].iter().enumerate() {
            let layer_name = layer["name"].as_str().unwrap_or("");
            let timestamp = layer["timestamp"].as_str().unwrap_or("");
            let label = layer["label"].as_str().unwrap_or("");

            let mut wms_url = Url::parse("https://www.bmkg.go.id/cuaca/radar/wms")?;
            wms_url.query_pairs_mut()
                .append_pair("service", "WMS")
                .append_pair("request", "GetMap")
                .append_pair("layers", layer_name)
                .append_pair("styles", "CMAX_dBZ")
                .append_pair("format", "image/png")
                .append_pair("transparent", "true")
                .append_pair("version", "1.1.1")
                .append_pair("width", "1024")
                .append_pair("height", "1018")
                .append_pair("srs", "EPSG:3857")
                .append_pair("bbox", bbox);

            let mut tile_req = client.http
                .get(wms_url.as_str())
                .header("Referer", "https://www.bmkg.go.id/cuaca/radar")
                .header("Accept", "image/png,*/*");

            if !auth_token.is_empty() {
                tile_req = tile_req.header("X-API-KEY", &auth_token);
            }

            let tile_resp = tile_req.send().await?;
            let status = tile_resp.status();
            if status.is_success() {
                let img_bytes = tile_resp.collect().await?.to_bytes();
                let file_name = format!("radar_sumsel_{}.png", timestamp);
                let file_path = format!("{}/{}", out_dir, file_name);
                let mut f = File::create(&file_path)?;
                f.write_all(&img_bytes)?;

                eprintln!("  [+] Frame {}: {} ({} bytes)", i + 1, timestamp, img_bytes.len());
                frames_meta.push(serde_json::json!({
                    "id": format!("{:02}", i * 10),
                    "filename": file_name,
                    "timestamp": timestamp,
                    "timeLabel": label,
                    "url": format!("https://raw.githubusercontent.com/ciroxtreme/Uvuvew/main/{}", file_name),
                    "path": file_name
                }));
            } else {
                eprintln!("  [-] Frame {} failed: status {}", i + 1, status);
            }
        }

        frames_meta.reverse();

        let latest_label = frames_meta.last()
            .and_then(|f| f["timeLabel"].as_str())
            .unwrap_or("Live WIB")
            .to_string();

        let now_wib = chrono::Utc::now() + chrono::Duration::hours(7);

        let output_json = serde_json::json!({
            "updatedAt": chrono::Utc::now().to_rfc3339(),
            "wibTime": now_wib.format("%d/%m/%Y, %H.%M WIB").to_string(),
            "obsTime": latest_label,
            "region": "All Sumatera",
            "bbox": [[-6.2, 94.5], [6.2, 107.0]],
            "frames": frames_meta
        });

        let json_path = format!("{}/radar-frames.json", out_dir);
        let mut jf = File::create(&json_path)?;
        jf.write_all(serde_json::to_string_pretty(&output_json)?.as_bytes())?;
        eprintln!("[+] Selesai! Metadata & citra tersimpan di {}", out_dir);

        println!("{}", serde_json::to_string(&output_json)?);
        Ok(())
    })
}
