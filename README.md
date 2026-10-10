# Uvuvew - BMKG Radar Cuaca Scraper

Sistem otomatisasi penangkapan citra radar cuaca BMKG dan integrasi ke Bot Telegram via Cloudflare KV.

## Cara Kerja
1. **GitHub Actions** berjalan otomatis setiap 15 menit menggunakan browser headless (Puppeteer Stealth).
2. Membuka peta radar interaktif BMKG (`https://www.bmkg.go.id/cuaca/radar`).
3. Mengambil screenshot elemen peta radar.
4. Mengunggah gambar ke Channel Telegram Storage sebagai CDN penyimpanan gambar permanen (gratis).
5. Mengambil `file_id` dari Telegram dan menyimpannya ke **Cloudflare KV**.
6. Cloudflare Worker Bot Telegram (`Tele-Cuaca`) membaca `file_id` dari KV dan mengirimkan foto ke user secara instan.

## Secrets yang Digunakan
- `BOT_TOKEN`: Token Bot Telegram
- `CHANNEL_ID`: ID Channel Telegram Storage
- `CF_ACCOUNT_ID`: Cloudflare Account ID
- `CF_KV_NAMESPACE_ID`: Cloudflare KV Namespace ID
- `CF_API_TOKEN`: Cloudflare API Token (Workers KV Storage:Edit)
