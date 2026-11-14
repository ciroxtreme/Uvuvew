use std::path::PathBuf;
use std::sync::Arc;
use url::Url;
use cfsolve::browser::Browser;
use cfsolve::solver::{Options, Turnstile, PageSource};
use cfsolve::embedding_page::page::Widget;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("Usage: solve_widget <profile.json> <page_url> <sitekey>");
        std::process::exit(1);
    }

    let profile_path = PathBuf::from(&args[1]);
    let page_url = Url::parse(&args[2])?;
    let sitekey = args[3].clone();

    eprintln!("[*] Loading browser profile from {:?}", profile_path);
    let browser = Browser::load(&profile_path).await?;

    let turnstile = Turnstile {
        url: page_url,
        page: PageSource::Blank,
        widget: Some(Widget { sitekey, action: None, c_data: None }),
    };

    let options = Options::default();

    eprintln!("[*] Solving Turnstile widget...");
    match browser.solve_turnstile(turnstile, &options).await {
        Ok(token) => {
            println!("{}", token);
            Ok(())
        }
        Err(e) => {
            eprintln!("[!] Failed to solve turnstile: {:?}", e);
            std::process::exit(2);
        }
    }
}
