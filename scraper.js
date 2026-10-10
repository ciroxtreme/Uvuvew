const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const path = require('path');
const FormData = require('form-data');
const fetch = require('node-fetch');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

if (!BOT_TOKEN || !CHANNEL_ID || !CF_ACCOUNT_ID || !CF_KV_NAMESPACE_ID || !CF_API_TOKEN) {
  console.error("❌ Variabel lingkungan (environment variables) belum lengkap!");
  process.exit(1);
}

async function scrapeRadar() {
  console.log("🚀 Menjalankan headless browser...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1200,800'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 750, deviceScaleFactor: 2 });

  let screenshotBuffer = null;
  let dataSource = "Radar Cuaca Realtime";

  // Coba rendisi peta radar lokal (CartoDB Basemap + Radar Overlay)
  // Menghasilkan peta cuaca beresolusi tinggi, bebas captcha Cloudflare
  try {
    const localHtmlPath = `file://${path.resolve(__dirname, 'radar-map.html')}`;
    console.log("🗺️ Merender peta radar cuaca resolusi tinggi dari", localHtmlPath);
    await page.goto(localHtmlPath, { waitUntil: 'networkidle2', timeout: 30000 });

    // Tunggu data radar selesai dimuat oleh Leaflet
    await page.waitForFunction('window.__RADAR_DONE__ === true', { timeout: 20000 });
    console.log("⏳ Menunggu semua tile peta & radar selesai di-render...");
    await new Promise(r => setTimeout(r, 4000));

    const mapEl = await page.$('#map');
    screenshotBuffer = await mapEl.screenshot({ type: 'jpeg', quality: 92 });
    dataSource = "Observasi Radar Cuaca Indonesia";
    console.log("✅ Peta radar komposit berhasil dirender dengan mulus!");
  } catch (err) {
    console.warn("⚠️ Gagal render peta lokal, mencoba tangkap langsung dari BMKG:", err.message);
    try {
      await page.goto('https://www.bmkg.go.id/cuaca/radar', { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 5000));
      const mapEl = await page.$('.leaflet-container, #map');
      if (mapEl) {
        screenshotBuffer = await mapEl.screenshot({ type: 'jpeg', quality: 90 });
        dataSource = "BMKG";
      }
    } catch (e2) {
      console.error("❌ Gagal keduanya:", e2.message);
    }
  } finally {
    await browser.close();
  }

  if (!screenshotBuffer) {
    throw new Error("Gagal mengambil screenshot radar.");
  }

  console.log("📸 Screenshot berhasil diambil! Ukuran:", screenshotBuffer.length, "bytes");

  // Kirim ke Channel Telegram
  console.log("📤 Mengirim gambar ke Channel Telegram:", CHANNEL_ID);
  const form = new FormData();
  form.append('chat_id', CHANNEL_ID);
  form.append('photo', screenshotBuffer, { filename: 'radar_cuaca.jpg' });
  const wibTime = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  form.append('caption', `📡 *Peta Radar Cuaca Terkini*\n🕒 Waktu: ${wibTime} WIB\nSumber: ${dataSource} 🇮🇩`);
  form.append('parse_mode', 'Markdown');

  const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    body: form
  });

  const tgData = await tgRes.json();
  if (!tgData.ok) {
    throw new Error("Gagal upload ke Telegram: " + JSON.stringify(tgData));
  }

  const photos = tgData.result.photo;
  const latestFileId = photos[photos.length - 1].file_id;
  console.log("✅ Berhasil dikirim ke channel! file_id:", latestFileId);

  // Simpan file_id ke Cloudflare KV
  console.log("💾 Menyimpan file_id ke Cloudflare KV...");
  const kvBase = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values`;

  // 1. Simpan LATEST_RADAR_FILE_ID
  const kvRes = await fetch(`${kvBase}/LATEST_RADAR_FILE_ID`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'text/plain'
    },
    body: latestFileId
  });
  const kvData = await kvRes.json();

  // 2. Simpan LATEST_RADAR_TIME
  await fetch(`${kvBase}/LATEST_RADAR_TIME`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'text/plain'
    },
    body: wibTime
  });

  if (!kvData.success) {
    throw new Error("Gagal update Cloudflare KV: " + JSON.stringify(kvData));
  }

  console.log("🎉 SUKSES! Cloudflare KV berhasil di-update dengan file_id radar terbaru.");
}

scrapeRadar().catch(err => {
  console.error("💥 Error Scraper:", err);
  process.exit(1);
});
