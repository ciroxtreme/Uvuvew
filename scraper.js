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
  console.error("❌ Variabel lingkungan belum lengkap!");
  process.exit(1);
}

const REGIONS = [
  { key: 'nasional', kvKey: 'LATEST_RADAR_FILE_ID', name: 'Nasional (Seluruh Indonesia)' },
  { key: 'jawa', kvKey: 'LATEST_RADAR_JAWA_FILE_ID', name: 'Jawa & Bali' },
  { key: 'sumatera', kvKey: 'LATEST_RADAR_SUMATERA_FILE_ID', name: 'Sumatera' }
];

async function renderAndUpload(page, regionInfo, wibTime) {
  const localHtmlPath = `file://${path.resolve(__dirname, 'radar-map.html')}?region=${regionInfo.key}`;
  console.log(`🗺️ Merender [${regionInfo.name}]...`);
  
  await page.goto(localHtmlPath, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction('window.__RADAR_DONE__ === true', { timeout: 20000 });
  await new Promise(r => setTimeout(r, 3000));

  const mapEl = await page.$('#map');
  const buffer = await mapEl.screenshot({ type: 'jpeg', quality: 92 });

  // Upload ke Telegram Channel
  const form = new FormData();
  form.append('chat_id', CHANNEL_ID);
  form.append('photo', buffer, { filename: `radar_${regionInfo.key}.jpg` });
  form.append('caption', `📡 *Peta Radar Cuaca: ${regionInfo.name}*\n🕒 Waktu: ${wibTime} WIB\nSumber: Observasi Radar Realtime 🇮🇩`);
  form.append('parse_mode', 'Markdown');

  const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    body: form
  });
  const tgData = await tgRes.json();
  if (!tgData.ok) {
    throw new Error(`Gagal upload [${regionInfo.key}]: ` + JSON.stringify(tgData));
  }

  const photos = tgData.result.photo;
  const fileId = photos[photos.length - 1].file_id;
  console.log(`✅ [${regionInfo.name}] terkirim! file_id:`, fileId);

  // Simpan ke KV
  const kvUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${regionInfo.kvKey}`;
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
  const wibTime = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  try {
    for (const reg of REGIONS) {
      await renderAndUpload(page, reg, wibTime);
    }

    // Simpan timestamp update
    const kvTimeUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/LATEST_RADAR_TIME`;
    await fetch(kvTimeUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'text/plain'
      },
      body: wibTime
    });

    console.log("🎉 SEMUA WILAYAH BERHASIL DI-RENDER & DI-UPDATE KE KV!");
  } finally {
    await browser.close();
  }
}

scrapeRadar().catch(err => {
  console.error("💥 Error Scraper:", err);
  process.exit(1);
});
