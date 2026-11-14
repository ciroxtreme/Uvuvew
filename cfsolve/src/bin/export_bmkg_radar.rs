use std::env;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use cfsolve::{Browser, Options, Outcome};
use http_body_util::BodyExt;
use tokio::runtime::Builder;
use url::Url;

fn tile_bounds_3857(x: i32, y: i32, z: i32) -> String {
    let c = 20037508.342789244;
    let n = 2.0_f64.powi(z);
    let res = (2.0 * c) / n;
    let minx = -c + (x as f64) * res;
    let maxx = -c + ((x + 1) as f64) * res;
    let maxy = c - (y as f64) * res;
    let miny = c - ((y + 1) as f64) * res;
    format!("{:.4},{:.4},{:.4},{:.4}", minx, miny, maxx, maxy)
}

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

    let mut profile_path = PathBuf::from("profiles/safari-26-ios.json");
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
        
        let outcome = browser.solve(&base_url, &options).await?;
        let (html, clearance_cookie) = match outcome {
            Outcome::Cleared(cleared) => {
                eprintln!("[+] Cloudflare Berhasil Ditembus! clearance length: {}", cleared.clearance.len());
                (cleared.page.html, format!("cf_clearance={}", cleared.clearance))
            }
            Outcome::Token(token) => {
                eprintln!("[+] Cloudflare Berhasil Ditembus dengan token: {}", token);
                ("".to_string(), "".to_string())
            }
        };

        if html.is_empty() {
            anyhow::bail!("Halaman HTML BMKG kosong setelah bypass challenge!");
        }

        eprintln!("[2] Mengekstrak daftar layer radar dari __NUXT_DATA__...");
        let nuxt_idx = html.find("id=\"__NUXT_DATA__\"")
            .context("Tidak menemukan __NUXT_DATA__ di HTML BMKG!")?;
        let script_start = html[nuxt_idx..].find('>').context("Tag __NUXT_DATA__ tidak valid")? + nuxt_idx + 1;
        let script_end = html[script_start..].find("</script>").context("Penutup script __NUXT_DATA__ tidak valid")? + script_start;
        let nuxt_json_str = &html[script_start..script_end];

        let nuxt_arr: Vec<serde_json::Value> = serde_json::from_str(nuxt_json_str)
            .context("Gagal parse array JSON __NUXT_DATA__")?;

        let resolve = |val: &serde_json::Value| -> serde_json::Value {
            if let Some(idx) = val.as_u64() {
                if (idx as usize) < nuxt_arr.len() {
                    return nuxt_arr[idx as usize].clone();
                }
            }
            val.clone()
        };

        let mut raw_layers: Vec<serde_json::Value> = Vec::new();
        for item in &nuxt_arr {
            if let Some(obj) = item.as_object() {
                if let Some(layers_val) = obj.get("layers") {
                    let resolved_layers = resolve(layers_val);
                    if let Some(arr) = resolved_layers.as_array() {
                        for l_idx in arr {
                            let l_obj = resolve(l_idx);
                            if let Some(o) = l_obj.as_object() {
                                let label = resolve(o.get("label").unwrap_or(&serde_json::Value::Null));
                                let name = resolve(o.get("name").unwrap_or(&serde_json::Value::Null));
                                let timestamp = resolve(o.get("timestamp").unwrap_or(&serde_json::Value::Null));
                                raw_layers.push(serde_json::json!({
                                    "label": label.as_str().unwrap_or(""),
                                    "name": name.as_str().unwrap_or(""),
                                    "timestamp": timestamp.as_str().unwrap_or("")
                                }));
                            }
                        }
                        if !raw_layers.is_empty() {
                            break;
                        }
                    }
                }
            }
        }

        if raw_layers.is_empty() {
            anyhow::bail!("Tidak berhasil mengekstrak layer radar dari data Nuxt BMKG!");
        }

        eprintln!("[+] Berhasil menemukan {} layer radar sidarma BMKG!", raw_layers.len());

        let client = browser.client(&options)?;
        let frame_count = std::cmp::min(8, raw_layers.len());
        let mut frames_meta = Vec::new();

        let z = 6;
        let x_start = 48;
        let x_end = 52; // 4 kolom
        let y_start = 30;
        let y_end = 34; // 4 baris

        eprintln!("[3] Mengunduh 16 tile radar per frame & simpan PNG tile...");

        for (i, layer) in raw_layers[..frame_count].iter().enumerate() {
            let layer_name = layer["name"].as_str().unwrap_or("");
            let timestamp = layer["timestamp"].as_str().unwrap_or("");
            let label = layer["label"].as_str().unwrap_or("");

            eprintln!("  [*] Mengambil frame {}/{} ({}, layer: {})...", i + 1, frame_count, timestamp, layer_name);

            let mut tile_success = 0;
            for x in x_start..x_end {
                for y in y_start..y_end {
                    let bbox = tile_bounds_3857(x, y, z);
                    let mut wms_url = Url::parse("https://www.bmkg.go.id/cuaca/radar/wms")?;
                    wms_url.query_pairs_mut()
                        .append_pair("service", "WMS")
                        .append_pair("request", "GetMap")
                        .append_pair("layers", layer_name)
                        .append_pair("styles", "CMAX_dBZ")
                        .append_pair("format", "image/png")
                        .append_pair("transparent", "true")
                        .append_pair("version", "1.1.1")
                        .append_pair("width", "256")
                        .append_pair("height", "256")
                        .append_pair("srs", "EPSG:3857")
                        .append_pair("bbox", &bbox);

                    let mut req = client.http
                        .get(wms_url.as_str())
                        .header("Referer", "https://www.bmkg.go.id/cuaca/radar")
                        .header("Accept", "image/png,*/*");

                    if !clearance_cookie.is_empty() {
                        req = req.header("Cookie", &clearance_cookie);
                    }

                    let resp = req.send().await?;
                    if resp.status().is_success() {
                        let bytes = resp.collect().await?.to_bytes();
                        let tile_name = format!("tile_{}_{}_{}_{}.png", timestamp, z, x, y);
                        let tile_path = format!("{}/{}", out_dir, tile_name);
                        let mut f = File::create(&tile_path)?;
                        f.write_all(&bytes)?;
                        tile_success += 1;
                    }
                }
            }

            if tile_success == 16 {
                frames_meta.push(serde_json::json!({
                    "id": format!("{:02}", i * 10),
                    "filename": format!("radar_sumsel_{}.png", timestamp),
                    "timestamp": timestamp,
                    "timeLabel": label,
                    "layerName": layer_name,
                    "tilePrefix": format!("tile_{}_{}", timestamp, z)
                }));
                eprintln!("  [+] Frame {} berhasil mengunduh 16 tile!", i + 1);
            } else {
                eprintln!("  [-] Frame {} hanya dapat {}/16 tile", i + 1, tile_success);
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
            "region": "All Sumatera (WMS Nasional BMKG)",
            "bounds": [[-11.1784, 90.0], [11.1784, 112.5]],
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
