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

// Render Peta Radar BMKG Asli per Wilayah
async function scrapeBMKGMaps(wibTime) {
  // Ambil file radar Doppler terbaru dari radar.cuacasumsel.com
  let latestRadarSumsel = null;
  try {
    const res = await fetch('https://radar.cuacasumsel.com/');
    const text = await res.text();
    const match = text.match(/var MyDateString00=\s*['"]([^'"]+)['"]/);
    if (match && match[1]) {
      latestRadarSumsel = 'https://radar.cuacasumsel.com/' + match[1];
      console.log('📡 Radar Doppler BMKG Sumsel live:', latestRadarSumsel);
    }
  } catch (e) {
    console.warn('Gagal ambil data cuacasumsel:', e.message);
  }

  console.log("🗺️ Menjalankan browser untuk render peta radar BMKG...");
  const { browser, page } = await connect({
    headless: false,
    turnstile: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--window-size=1200,800'],
    connectOption: {
      defaultViewport: { width: 1200, height: 750 }
    }
  });

  const regions = [
    { key: 'rumah', kvKey: 'LATEST_RADAR_RUMAH_FILE_ID', name: 'Sekitar Rumah (Sungai Lilin)' },
    { key: 'palembang', kvKey: 'LATEST_RADAR_PALEMBANG_FILE_ID', name: 'Palembang & Sumsel' },
    { key: 'sumatera', kvKey: 'LATEST_RADAR_SUMATERA_FILE_ID', name: 'Sumatera' },
    { key: 'jawa', kvKey: 'LATEST_RADAR_JAWA_FILE_ID', name: 'Jawa & Bali' },
    { key: 'nasional', kvKey: 'LATEST_RADAR_FILE_ID', name: 'Nasional' }
  ];

  try {
    for (const reg of regions) {
      let localHtmlPath = `file://${path.resolve(__dirname, 'radar-map.html')}?region=${reg.key}`;
      if (latestRadarSumsel && (reg.key === 'rumah' || reg.key === 'palembang')) {
        localHtmlPath += `&radarImg=${encodeURIComponent(latestRadarSumsel)}`;
      }
      console.log(`🗺️ Merender radar BMKG [${reg.name}]...`);
      await page.goto(localHtmlPath, { waitUntil: 'networkidle2', timeout: 35000 });
      await page.waitForFunction('window.__RADAR_DONE__ === true', { timeout: 25000 });
      await new Promise(r => setTimeout(r, 1500));

      const mapEl = await page.$('#map');
      const screenshot = await mapEl.screenshot({ type: 'jpeg', quality: 92 });
      const buffer = Buffer.from(screenshot);

      await uploadToTelegramAndKV(
        buffer,
        `📡 *Radar Cuaca Terkini: ${reg.name}*\n🕒 Waktu: ${wibTime} WIB\nSumber: Radar Cuaca Realtime 🇮🇩`,
        reg.kvKey
      );
      console.log(`✅ [${reg.name}] tersimpan ke KV (${reg.kvKey})!`);
    }
  } finally {
    try { await browser.close(); } catch (e) {}
  }
}

async function run() {
  const wibTime = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  console.log("🚀 Memulai proses update radar BMKG:", wibTime);

  // Render semua wilayah (Palembang, Sumatera, Jawa, Nasional)
  await scrapeBMKGMaps(wibTime);

  // Simpan timestamp update terakhir
  const kvTimeUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/LATEST_RADAR_TIME`;
  await fetch(kvTimeUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'text/plain'
    },
    body: wibTime
  });

  console.log("🎉 PROSES UPDATE RADAR BMKG SELESAI SEMPURNA!");
}

run().catch(err => {
  console.error("💥 Fatal Error:", err);
  process.exit(1);
});
