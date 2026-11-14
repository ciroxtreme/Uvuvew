use anyhow::Result;
use cfsolve::{Browser, Options, Outcome};
use url::Url;
use tokio::runtime::Builder;
use std::fs;

fn main() -> Result<()> {
    let browser = Browser::read("profiles/safari-26-ios.json")?;
    let options = Options {
        proxy: None,
        trusted_root: None,
        sink: None,
    };
    let runtime = Builder::new_multi_thread().enable_all().build()?;
    runtime.block_on(async {
        let base_url = Url::parse("https://cctv.banyuasinkab.go.id/")?;
        println!("1. Solving challenge for base page...");
        let cleared = match browser.solve(&base_url, &options).await? {
            Outcome::Cleared(c) => c,
            _ => anyhow::bail!("Expected cleared challenge"),
        };
        println!("Cleared! Clearance cookie: {:?}", cleared.clearance);
        
        // Use the browser's internal client to fetch /stream/1
        let client = browser.client(&options)?;
        // Set cookies on client
        for cookie in cleared.cookies {
            println!("Cookie: {} = {}", cookie.name(), cookie.value());
        }
        
        let stream_url = Url::parse("https://cctv.banyuasinkab.go.id/stream/1")?;
        println!("Fetching stream: {} ...", stream_url);
        
        // Request with range or read stream
        let res = client.get(stream_url.as_str()).header("Referer", "https://cctv.banyuasinkab.go.id/").send().await?;
        println!("Stream HTTP Status: {}", res.status());
        println!("Headers: {:?}", res.headers());
        
        let body_bytes = res.bytes().await?;
        println!("Received {} bytes", body_bytes.len());
        fs::write("/home/container/files/raw_stream1.bin", &body_bytes)?;
        println!("Saved /home/container/files/raw_stream1.bin");
        Ok(())
    })
}
