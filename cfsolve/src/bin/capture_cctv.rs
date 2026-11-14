use std::env;
use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use cfsolve::{Browser, Options};
use http_body_util::BodyExt;
use tokio::runtime::Builder;
use tokio::time::timeout;
use url::Url;

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage: capture_cctv <fingerprint.json> <output_dir> [cam_id1 cam_id2 ...]");
        std::process::exit(1);
    }

    let fingerprint_path = &args[1];
    let output_dir = &args[2];
    
    let cam_ids: Vec<String> = if args.len() > 3 {
        args[3..].to_vec()
    } else {
        // Default target Banyuasin corridor IDs
        vec!["1".into(), "6".into(), "3".into(), "9".into(), "5".into(), "4".into()]
    };

    let browser = Browser::read(Path::new(fingerprint_path))?;
    let proxy_env = env::var("CF_PROXY").ok().filter(|s| !s.trim().is_empty());
    if let Some(ref p) = proxy_env {
        println!("[*] Menggunakan Proxy: {}", p);
    }
    let options = Options {
        proxy: proxy_env,
        trusted_root: None,
        sink: None,
    };

    let runtime = Builder::new_multi_thread().enable_all().build()?;
    runtime.block_on(async {
        println!("[1] Memulai bypass Cloudflare Turnstile di cctv.banyuasinkab.go.id...");
        let base_url = Url::parse("https://cctv.banyuasinkab.go.id/")?;
        
        let client = browser.client(&options)?;
        
        let clearance = browser.solve_with_client(&client, &base_url, &options).await?;
        println!("Challenge Berhasil Ditembus! cf_clearance: {}", clearance.clearance);

        for cam_id in &cam_ids {
            let stream_url = format!("https://cctv.banyuasinkab.go.id/stream/{}", cam_id);
            let out_file = format!("{}/banyuasin_{}.jpg", output_dir, cam_id);
            println!("\n[+] Mengakses stream ID {}: {}...", cam_id, stream_url);

            let resp_res = client.http
                .get(&stream_url)
                .header("Referer", "https://cctv.banyuasinkab.go.id/")
                .header("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
                .send()
                .await;

            let resp = match resp_res {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("[-] Gagal connect ke cam {}: {}", cam_id, e);
                    continue;
                }
            };

            let status = resp.status();
            if !status.is_success() {
                eprintln!("[-] Cam {} returned HTTP status {}", cam_id, status);
                continue;
            }

            let mut body = resp;
            let mut buffer: Vec<u8> = Vec::new();

            let parse_res = timeout(Duration::from_secs(12), async {
                while let Some(frame_res) = body.frame().await {
                    let frame = frame_res.context("Error reading frame")?;
                    if let Ok(data) = frame.into_data() {
                        buffer.extend_from_slice(&data);

                        if let Some(soi_pos) = find_subsequence(&buffer, &[0xFF, 0xD8]) {
                            if let Some(eoi_pos) = find_subsequence(&buffer[soi_pos + 2..], &[0xFF, 0xD9]) {
                                let full_eoi = soi_pos + 2 + eoi_pos + 2;
                                let jpeg_bytes = &buffer[soi_pos..full_eoi];
                                let mut file = File::create(&out_file)?;
                                file.write_all(jpeg_bytes)?;
                                println!("[✓] Cam {} berhasil disimpan ke {} ({} bytes)", cam_id, out_file, jpeg_bytes.len());
                                return Ok::<(), anyhow::Error>(());
                            }
                        }
                    }
                }
                anyhow::bail!("Stream ended before frame completion");
            }).await;

            if let Err(e) = parse_res {
                eprintln!("[-] Cam {} timeout atau error: {}", cam_id, e);
            }
        }

        Ok::<(), anyhow::Error>(())
    })?;

    Ok(())
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}
