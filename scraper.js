const { connect } = require('puppeteer-real-browser');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
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

// Upload foto statis ke Telegram & simpan file_id ke Cloudflare KV
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

// Upload animasi video MP4 loop ke Telegram (sendAnimation) & simpan file_id ke Cloudflare KV
async function uploadAnimationToTelegramAndKV(videoPath, caption, kvKey) {
  const form = new FormData();
  form.append('chat_id', CHANNEL_ID);
  form.append('animation', fs.createReadStream(videoPath), { filename: 'radar_anim.mp4' });
  form.append('caption', caption);
  form.append('parse_mode', 'Markdown');

  const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAnimation`, {
    method: 'POST',
    body: form
  });
  const tgData = await tgRes.json();
  if (!tgData.ok) {
    throw new Error('Gagal upload animasi ke Telegram: ' + JSON.stringify(tgData));
  }

  const anim = tgData.result.animation || tgData.result.document || tgData.result.video;
  const fileId = anim ? anim.file_id : null;
  if (!fileId) {
    throw new Error('Tidak ada file_id animasi dari Telegram: ' + JSON.stringify(tgData));
  }

  // Simpan ke Cloudflare KV spesifik wilayah
  const kvUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${kvKey}`;
  await fetch(kvUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'text/plain'
    },
    body: fileId
  });

  // Simpan juga sebagai default animasi jika wilayah rumah
  if (kvKey === 'LATEST_RADAR_RUMAH_ANIM_FILE_ID') {
    const defaultKvUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/LATEST_RADAR_ANIM_FILE_ID`;
    await fetch(defaultKvUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'text/plain'
      },
      body: fileId
    });
  }

  return fileId;
}

// Render Peta Radar BMKG Asli per Wilayah
async function scrapeBMKGMaps(wibTime) {
  // Ambil file radar Doppler terbaru & simpan daftar frame
  let latestRadarSumsel = null;
  let obsTimeSumsel = null;
  try {
    const res = await fetch('https://radar.cuacasumsel.com/');
    const text = await res.text();
    const match = text.match(/var MyDateString00=\s*['"]([^'"]+)['"]/);
    if (match && match[1]) {
      latestRadarSumsel = 'https://radar.cuacasumsel.com/' + match[1];
      console.log('📡 Radar Doppler BMKG Sumsel live:', latestRadarSumsel);
    }

    const matches = [...text.matchAll(/var MyDateString([0-9]{2})\s*=\s*['"]([^'"]+)['"]/g)];
    if (matches.length > 0) {
      const frames = matches.map(m => {
        const path = m[2];
        const matchTime = path.match(/([0-9]{4})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})/);
        let timeLabel = "";
        if (matchTime) {
          const d = new Date(Date.UTC(parseInt(matchTime[1]), parseInt(matchTime[2]) - 1, parseInt(matchTime[3]), parseInt(matchTime[4]), parseInt(matchTime[5])));
          timeLabel = d.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }) + ' WIB';
        }
        return {
          id: m[1],
          url: 'https://radar.cuacasumsel.com/' + path,
          path: path,
          timeLabel: timeLabel
        };
      }).reverse();

      if (frames.length > 0) {
        obsTimeSumsel = frames[frames.length - 1].timeLabel;
      }

      const framesData = {
        updatedAt: new Date().toISOString(),
        wibTime: wibTime,
        obsTime: obsTimeSumsel,
        frames: frames
      };

      // Tulis file radar-frames.json untuk static hosting di GitHub Pages
      fs.writeFileSync(path.resolve(__dirname, 'radar-frames.json'), JSON.stringify(framesData, null, 2));

      // Simpan ke Cloudflare KV
      const kvFramesUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/LATEST_RADAR_FRAMES`;
      await fetch(kvFramesUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${CF_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(framesData)
      });
      console.log('✅ Daftar frame radar tersimpan ke radar-frames.json & Cloudflare KV (LATEST_RADAR_FRAMES)!');
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
    { key: 'rumah', kvKey: 'LATEST_RADAR_RUMAH_FILE_ID', animKvKey: 'LATEST_RADAR_RUMAH_ANIM_FILE_ID', name: 'Sekitar Rumah (Sungai Lilin)' },
    { key: 'palembang', kvKey: 'LATEST_RADAR_PALEMBANG_FILE_ID', animKvKey: 'LATEST_RADAR_PALEMBANG_ANIM_FILE_ID', name: 'Palembang & Sumsel' },
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
      
      // 1. Ambil screenshot statis frame terbaru
      const screenshot = await mapEl.screenshot({ type: 'jpeg', quality: 92 });
      const buffer = Buffer.from(screenshot);

      await uploadToTelegramAndKV(
        buffer,
        `📡 *Radar Cuaca Terkini: ${reg.name}*\n🕒 Waktu: ${wibTime} WIB\nSumber: Radar Cuaca Realtime 🇮🇩`,
        reg.kvKey
      );
      console.log(`✅ Foto statis [${reg.name}] tersimpan ke KV (${reg.kvKey})!`);

      // 2. Render animasi pergerakan awan/radar jika tersedia multi-frame
      if (reg.animKvKey) {
        try {
          const frameCount = await page.evaluate(() => window.radarOverlays?.length || 0);
          console.log(`🎬 Menyiapkan animasi [${reg.name}] (${frameCount} frame)...`);
          if (frameCount > 1) {
            const frameDir = path.join(os.tmpdir(), `frames_${reg.key}_${Date.now()}`);
            fs.mkdirSync(frameDir, { recursive: true });

            let frameNum = 0;
            for (let f = 0; f < frameCount; f++) {
              await page.evaluate((idx) => window.setRadarFrame(idx), f);
              await new Promise(r => setTimeout(r, 200));
              const frameShot = await mapEl.screenshot({ type: 'jpeg', quality: 85 });
              fs.writeFileSync(path.join(frameDir, `frame_${String(frameNum).padStart(3, '0')}.jpg`), frameShot);
              frameNum++;
            }

            // Duplikat frame terakhir 2x agar ada jeda ~1 detik pada observasi paling baru sebelum loop ulang
            const lastShot = fs.readFileSync(path.join(frameDir, `frame_${String(frameNum - 1).padStart(3, '0')}.jpg`));
            fs.writeFileSync(path.join(frameDir, `frame_${String(frameNum).padStart(3, '0')}.jpg`), lastShot);
            frameNum++;
            fs.writeFileSync(path.join(frameDir, `frame_${String(frameNum).padStart(3, '0')}.jpg`), lastShot);
            frameNum++;

            // Kembalikan Leaflet ke frame terbaru
            await page.evaluate((idx) => window.setRadarFrame(idx), frameCount - 1);

            const videoPath = path.join(os.tmpdir(), `radar_anim_${reg.key}_${Date.now()}.mp4`);
            // Encode ke MP4 (H.264, 2 fps, lanczos 800px width)
            execSync(`ffmpeg -y -framerate 2 -i "${frameDir}/frame_%03d.jpg" -vf "scale=800:-2:flags=lanczos,format=yuv420p" -c:v libx264 -preset fast -crf 23 "${videoPath}"`, { stdio: 'pipe' });

            await uploadAnimationToTelegramAndKV(
              videoPath,
              `🎬 *Animasi Pergerakan Radar BMKG: ${reg.name}*\n🕒 Update: ${wibTime} WIB\nPergerakan Hujan & Awan Doppler Terkini 🇮🇩`,
              reg.animKvKey
            );
            console.log(`✅ Animasi [${reg.name}] tersimpan ke KV (${reg.animKvKey})!`);

            // Bersihkan file sementara
            try {
              fs.rmSync(frameDir, { recursive: true, force: true });
              fs.unlinkSync(videoPath);
            } catch (e) {}
          }
        } catch (animErr) {
          console.error(`⚠️ Gagal generate animasi [${reg.name}]:`, animErr.message);
        }
      }
    }
  } finally {
    try { await browser.close(); } catch (e) {}
  }
}

async function run() {
  const wibTime = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  console.log("🚀 Memulai proses update radar BMKG:", wibTime);

  // Render semua wilayah (Palembang, Rumah, Sumatera, Jawa, Nasional)
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

  // Simpan timestamp epoch ms untuk deteksi stale data di Worker
  const kvMsUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/LATEST_RADAR_TIMESTAMP_MS`;
  await fetch(kvMsUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'text/plain'
    },
    body: String(Date.now())
  });

  console.log("🎉 PROSES UPDATE RADAR BMKG SELESAI SEMPURNA!");
}

run().catch(err => {
  console.error("💥 Fatal Error:", err);
  process.exit(1);
});
