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
        let base_url = Url::parse("https://tv12.lk21official.cc/")?;
        println!("1. Solving challenge for https://tv12.lk21official.cc/ ...");
        let cleared = match browser.solve(&base_url, &options).await? {
            Outcome::Cleared(c) => c,
            Outcome::Token(t) => {
                println!("Got Token: {}", t);
                return Ok(());
            }
        };
        println!("Cleared! Clearance cookie: {:?}", cleared.clearance);
        
        let client = browser.client(&options)?;
        let mut cookie_header = format!("cf_clearance={}", cleared.clearance);
        for cookie in &cleared.cookies {
            cookie_header.push_str(&format!("; {}={}", cookie.name(), cookie.value()));
        }
        
        println!("Fetching page using client...");
        let res = client.get("https://tv12.lk21official.cc/")
            .header("Referer", "https://tv12.lk21official.cc/")
            .header("Cookie", cookie_header)
            .send().await?;
            
        println!("Response Status: {}", res.status());
        let body = res.text().await?;
        println!("Received {} bytes", body.len());
        println!("Preview:");
        println!("{}", &body[..body.len().min(1200)]);
        fs::write("/home/container/files/lk21_page.html", &body)?;
        println!("Saved to /home/container/files/lk21_page.html");
        Ok(())
    })
}
