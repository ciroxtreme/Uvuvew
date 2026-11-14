use std::env;
use std::fs::File;
use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result};
use cfsolve::{Browser, Options};
use http_body_util::BodyExt;
use tokio::runtime::Builder;
use url::Url;

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    let fingerprint_path = if args.len() > 1 {
        &args[1]
    } else {
        "profiles/safari-26-ios.json"
    };

    let browser = Browser::read(Path::new(fingerprint_path))?;
    let options = Options::default();

    let runtime = Builder::new_multi_thread().enable_all().build()?;
    runtime.block_on(async {
        println!("[1] Memulai bypass Cloudflare Turnstile di bmkg.go.id/cuaca/radar...");
        let base_url = Url::parse("https://www.bmkg.go.id/cuaca/radar")?;
        
        let client = browser.client(&options)?;
        
        let clearance = browser.solve_with_client(&client, &base_url, &options).await?;
        println!("[+] Challenge Berhasil Ditembus! cf_clearance: {}", clearance.clearance);

        let html = &clearance.page.html;
        println!("[+] Cleared HTML length: {}", html.len());

        // Extract auth token
        let mut auth_token = String::new();
        if let Some(idx) = html.find("$sauth-token") {
            let snippet = &html[idx..std::cmp::min(idx + 350, html.len())];
            for part in snippet.split('"') {
                if part.starts_with("Ec8") || (part.len() > 40 && part.contains(".eyJ")) {
                    auth_token = part.to_string();
                    break;
                }
            }
        }

        println!("[+] Auth token (X-API-KEY): {}", auth_token);

        // Call /api/cuaca/radar/layers
        println!("\n[2] Memanggil endpoint API /api/cuaca/radar/layers...");
        let mut layers_req = client.http
            .get("https://www.bmkg.go.id/api/cuaca/radar/layers")
            .header("Referer", "https://www.bmkg.go.id/cuaca/radar")
            .header("Accept", "application/json, text/plain, */*");

        if !auth_token.is_empty() {
            layers_req = layers_req.header("X-API-KEY", &auth_token);
        }

        let layers_resp = layers_req.send().await?;
        println!("[+] Layers API Status: {}", layers_resp.status());
        let layers_bytes = layers_resp.collect().await?.to_bytes();
        let layers_str = String::from_utf8_lossy(&layers_bytes);

        println!("[+] Preview Layers: {}", &layers_str[..std::cmp::min(300, layers_str.len())]);

        let json_val: serde_json::Value = serde_json::from_str(&layers_str)?;
        let first_layer = json_val["layers"].as_array().and_then(|a| a.first()).context("No layers found")?;
        let layer_name = first_layer["name"].as_str().context("Missing layer name")?;
        let timestamp = first_layer["timestamp"].as_str().unwrap_or("latest");

        println!("\n[3] Mengambil Citra Radar WMS untuk layer {} ({})", layer_name, timestamp);

        // Bbox untuk wilayah Sumatera Bagian Selatan / Palembang (sesuai screenshot Tuan Ciro)
        let bbox = "11577201,-390197,11799834,-222684";
        let mut wms_url = Url::parse("https://www.bmkg.go.id/cuaca/radar/wms")?;
        wms_url.query_pairs_mut()
            .append_pair("service", "WMS")
            .append_pair("request", "GetMap")
            .append_pair("layers", layer_name)
            .append_pair("styles", "CMAX_dBZ")
            .append_pair("format", "image/png")
            .append_pair("transparent", "true")
            .append_pair("version", "1.1.1")
            .append_pair("width", "512")
            .append_pair("height", "512")
            .append_pair("srs", "EPSG:3857")
            .append_pair("bbox", bbox);

        println!("[+] Mengunduh WMS tile: {}", wms_url);
        let mut tile_req = client.http
            .get(wms_url.as_str())
            .header("Referer", "https://www.bmkg.go.id/cuaca/radar")
            .header("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8");

        if !auth_token.is_empty() {
            tile_req = tile_req.header("X-API-KEY", &auth_token);
        }

        let tile_resp = tile_req.send().await?;
        let tile_status = tile_resp.status();
        println!("[+] Status Response Citra WMS: {}", tile_status);

        let img_bytes = tile_resp.collect().await?.to_bytes();
        let out_file = "/home/container/files/radar_bmkg_palembang.png";
        let mut file = File::create(out_file)?;
        file.write_all(&img_bytes)?;
        println!("[+] BERHASIL! Citra radar hujan tersimpan di {} ({} bytes)", out_file, img_bytes.len());

        Ok(())
    })
}
