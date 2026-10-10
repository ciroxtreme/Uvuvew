const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

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
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--window-size=1280,800'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
  );

  let screenshotBuffer = null;

  try {
    console.log("🌐 Membuka laman radar BMKG (https://www.bmkg.go.id/cuaca/radar)...");
    await page.goto('https://www.bmkg.go.id/cuaca/radar', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Cari container peta
    try {
      await page.waitForSelector('.leaflet-container, #map', { timeout: 15000 });
      console.log("📍 Elemen peta ditemukan. Menunggu tile radar ter-render...");
      await new Promise(r => setTimeout(r, 6000));

      const mapEl = await page.$('.leaflet-container') || await page.$('#map');
      if (mapEl) {
        screenshotBuffer = await mapEl.screenshot({ type: 'jpeg', quality: 90 });
      }
    } catch (e) {
      console.warn("⚠️ Gagal menemukan container spesifik, mengambil screenshot layar penuh...");
      screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 90 });
    }
  } catch (err) {
    console.warn("⚠️ Gagal membuka bmkg.go.id, mencoba alternatif cuaca.bmkg.go.id/map...", err.message);
    try {
      await page.goto('https://cuaca.bmkg.go.id/map', { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise(r => setTimeout(r, 6000));
      const mapEl = await page.$('#hujanpetir') || await page.$('.map-height') || await page.$('canvas');
      if (mapEl) {
        screenshotBuffer = await mapEl.screenshot({ type: 'jpeg', quality: 90 });
      } else {
        screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 90 });
      }
    } catch (e2) {
      console.error("❌ Gagal membuka kedua laman BMKG:", e2.message);
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
  form.append('photo', screenshotBuffer, { filename: 'radar_bmkg.jpg' });
  const wibTime = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  form.append('caption', `📡 *Radar Cuaca BMKG Terkini*\n🕒 Waktu: ${wibTime} WIB\nSumber: BMKG 🇮🇩`);
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
