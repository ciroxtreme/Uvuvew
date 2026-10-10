const { connect } = require('puppeteer-real-browser');
const path = require('path');
const FormData = require('form-data');
const fetch = require('node-fetch');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

if (!BOT_TOKEN || !CHANNEL_ID || !CF_ACCOUNT_ID || !CF_KV_NAMESPACE_ID || !CF_API_TOKEN) {
  console.error("❌ Variabel lingkungan belum lengkap!");
  process.exit(1);
}

async function uploadToTelegramAndKV(buffer, caption, kvKey) {
  const form = new FormData();
  form.append('chat_id', CHANNEL_ID);
  form.append('photo', buffer, { filename: 'radar.jpg' });
  form.append('caption', caption);
  form.append('parse_mode', 'Markdown');

  const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    body: form
  });
  const tgData = await tgRes.json();
  if (!tgData.ok) {
    throw new Error('Gagal upload ke Telegram: ' + JSON.stringify(tgData));
  }

  const photos = tgData.result.photo;
  const fileId = photos[photos.length - 1].file_id;

  // Simpan ke Cloudflare KV
  const kvUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${kvKey}`;
  await fetch(kvUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'text/plain'
    },
    body: fileId
  });

  return fileId;
}

// OPSI 1: Buka langsung situs radar BMKG asli dengan Cloudflare Turnstile Solver
async function scrapeBMKGDirect(wibTime) {
  console.log("🚀 [Opsi 1] Menjalankan Real-Browser untuk membuka bmkg.go.id/cuaca/radar...");
  let response;
  try {
    response = await connect({
      headless: false,
      turnstile: true, // Otomatis solve Cloudflare Turnstile!
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800'],
      connectOption: {
        defaultViewport: { width: 1280, height: 800 }
      }
    });
  } catch (launchErr) {
    console.warn("⚠️ Gagal launch real-browser:", launchErr.message);
    return false;
  }

  const { browser, page } = response;

  try {
    console.log("🌐 Membuka https://www.bmkg.go.id/cuaca/radar ...");
    await page.goto('https://www.bmkg.go.id/cuaca/radar', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    console.log("⏳ Menunggu verifikasi Cloudflare dan container peta BMKG...");
    await page.waitForSelector('.leaflet-container, #map', { timeout: 40000 });
    console.log("🎉 Peta Leaflet BMKG asli berhasil terbuka!");

    // Tunggu tile radar BMKG (termasuk radar Padang / BIM, Jawa, dll.) selesai dirender
    await new Promise(r => setTimeout(r, 8000));

    const mapEl = await page.$('.leaflet-container') || await page.$('#map');
    const screenshot = await mapEl.screenshot({ type: 'jpeg', quality: 92 });
    const buffer = Buffer.from(screenshot);

    await uploadToTelegramAndKV(
      buffer,
      `📡 *Peta Radar Cuaca BMKG Resmi (Asli)*\n🕒 Waktu: ${wibTime} WIB\nSumber: BMKG (SIDARMA) 🇮🇩`,
      'LATEST_RADAR_FILE_ID'
    );

    console.log("✅ Radar BMKG asli berhasil di-capture dan di-upload ke KV!");
    return true;
  } catch (err) {
    console.warn("⚠️ Gagal menembus radar BMKG asli:", err.message);
    return false;
  } finally {
    try { await browser.close(); } catch (e) {}
  }
}

// Cadangan / Multi-Region Renderer
async function scrapeRegionalMaps(wibTime, skipNasional = false) {
  console.log("🗺️ Merender peta wilayah...");
  const { browser, page } = await connect({
    headless: false,
    turnstile: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1200,800'],
    connectOption: {
      defaultViewport: { width: 1200, height: 750 }
    }
  });

  const regions = [
    ...(skipNasional ? [] : [{ key: 'nasional', kvKey: 'LATEST_RADAR_FILE_ID', name: 'Nasional' }]),
    { key: 'jawa', kvKey: 'LATEST_RADAR_JAWA_FILE_ID', name: 'Jawa & Bali' },
    { key: 'sumatera', kvKey: 'LATEST_RADAR_SUMATERA_FILE_ID', name: 'Sumatera' }
  ];

  try {
    for (const reg of regions) {
      const localHtmlPath = `file://${path.resolve(__dirname, 'radar-map.html')}?region=${reg.key}`;
      console.log(`🗺️ Merender [${reg.name}]...`);
      await page.goto(localHtmlPath, { waitUntil: 'networkidle2', timeout: 30000 });
      await page.waitForFunction('window.__RADAR_DONE__ === true', { timeout: 20000 });
      await new Promise(r => setTimeout(r, 3000));

      const mapEl = await page.$('#map');
      const screenshot = await mapEl.screenshot({ type: 'jpeg', quality: 92 });
      const buffer = Buffer.from(screenshot);

      await uploadToTelegramAndKV(
        buffer,
        `📡 *Peta Radar Cuaca: ${reg.name}*\n🕒 Waktu: ${wibTime} WIB\nSumber: Observasi Radar Realtime 🇮🇩`,
        reg.kvKey
      );
      console.log(`✅ [${reg.name}] tersimpan ke KV!`);
    }
  } finally {
    try { await browser.close(); } catch (e) {}
  }
}

async function run() {
  const wibTime = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  
  // 1. Coba ambil radar BMKG asli
  const bmkgSuccess = await scrapeBMKGDirect(wibTime);

  // 2. Render peta regional (Jawa & Sumatera)
  // Jika radar BMKG asli gagal, render juga peta nasional sebagai cadangan
  await scrapeRegionalMaps(wibTime, bmkgSuccess);

  // 3. Simpan update timestamp
  const kvTimeUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/LATEST_RADAR_TIME`;
  await fetch(kvTimeUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'text/plain'
    },
    body: wibTime
  });

  console.log("🎉 PROSES SCRAPER SELESAI SEMPURNA!");
}

run().catch(err => {
  console.error("💥 Fatal Error:", err);
  process.exit(1);
});
