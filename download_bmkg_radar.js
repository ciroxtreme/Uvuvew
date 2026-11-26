const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

(async () => {
  console.log("🚀 [STEALTH BROWSER] Meluncurkan browser anti-detect untuk menembus Cloudflare BMKG...");
  
  let browser, page;
  try {
    const result = await connect({
      headless: 'auto',
      turnstile: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ],
      connectOption: {
        defaultViewport: { width: 1280, height: 800 }
      }
    });
    browser = result.browser;
    page = result.page;

    console.log("📡 [STEALTH BROWSER] Mengakses https://www.bmkg.go.id/cuaca/radar ...");
    await page.goto("https://www.bmkg.go.id/cuaca/radar", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // Tunggu sampai Turnstile terpecahkan otomatis oleh puppeteer-real-browser
    let solved = false;
    for (let i = 0; i < 20; i++) {
      const html = await page.content().catch(() => "");
      const title = await page.title().catch(() => "");
      console.log(`⏳ [TUNGGU VERIFIKASI] Detik ke-${(i+1)*3}: Title="${title}", Has NUXT=${html.includes("__NUXT_DATA__")}`);
      
      if (html.includes("__NUXT_DATA__")) {
        solved = true;
        break;
      }
      await new Promise(r => setTimeout(r, 3000));
    }

    if (!solved) {
      throw new Error("Gagal melewati Cloudflare Turnstile setelah 60 detik");
    }

    console.log("✅ [CF CLEARANCE] Berhasil menembus Cloudflare Turnstile BMKG!");

    // Ekstrak token / cookies dari context browser
    const cookies = await page.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    console.log(`🍪 [COOKIES] Mendapatkan ${cookies.length} cookies (termasuk cf_clearance).`);

    // Ekstrak __NUXT_DATA__ untuk mendapatkan layer radar
    const html = await page.content();
    const nuxtMatch = html.match(/<script id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!nuxtMatch) {
      throw new Error("Tidak menemukan tag __NUXT_DATA__ di halaman");
    }

    const nuxtData = JSON.parse(nuxtMatch[1]);
    console.log("📦 [NUXT DATA] Berhasil mem-parse data layer internal BMKG!");

    // Cari daftar nama layer sidarma_mosaic_cmax
    const layerNames = [];
    for (const item of nuxtData) {
      if (typeof item === 'string' && item.startsWith('sidarma_mosaic_cmax:Indonesia_')) {
        layerNames.push(item);
      }
    }
    const uniqueLayers = [...new Set(layerNames)].sort().reverse();
    console.log(`🎯 [LAYERS] Ditemukan ${uniqueLayers.length} layer radar sidarma BMKG.`);

    // Ambil 8 layer terakhir
    const selectedLayers = uniqueLayers.slice(0, 8);
    const z = 6;
    const xRange = [48, 49, 50, 51];
    const yRange = [30, 31, 32, 33];

    const framesMeta = [];
    for (let idx = 0; idx < selectedLayers.length; idx++) {
      const layer = selectedLayers[idx];
      const matchTs = layer.match(/Indonesia_([0-9]{12})/);
      const ts = matchTs ? matchTs[1] : Date.now().toString();
      const idStr = String(idx * 10).padStart(2, '0');
      const filename = `radar_sumsel_${ts}.png`;
      const tilePrefix = `tile_${ts}_6`;

      // Format label waktu
      let timeLabel = ts;
      if (matchTs) {
        const y = ts.slice(0, 4), m = ts.slice(4, 6), d = ts.slice(6, 8), h = ts.slice(8, 10), min = ts.slice(10, 12);
        timeLabel = `${d}/${m}/${y} • ${h}.${min} WIB`;
      }

      framesMeta.push({
        id: idStr,
        filename,
        timestamp: ts,
        timeLabel,
        layerName: layer,
        tilePrefix
      });

      console.log(`⬇️ [UNDUH TILE] Mengunduh 16 tile untuk frame ${idx + 1}/${selectedLayers.length} (${ts})...`);
      
      // Unduh 16 tile secara paralel menggunakan session cookies yang valid
      const tilePromises = [];
      for (const x of xRange) {
        for (const y of yRange) {
          const tileUrl = `https://www.bmkg.go.id/api/cuaca/radar/tiles/${z}/${x}/${y}?layer=${encodeURIComponent(layer)}`;
          const tileFile = path.resolve(".", `tile_${ts}_${z}_${x}_${y}.png`);
          
          tilePromises.push(
            fetch(tileUrl, {
              headers: {
                "Cookie": cookieHeader,
                "User-Agent": await page.evaluate(() => navigator.userAgent),
                "Referer": "https://www.bmkg.go.id/cuaca/radar"
              }
            })
            .then(res => res.buffer())
            .then(buf => fs.writeFileSync(tileFile, buf))
            .catch(err => console.warn(`Gagal unduh tile ${tileUrl}:`, err.message))
          );
        }
      }
      await Promise.all(tilePromises);
    }

    // Tulis radar-frames.json
    const outputData = {
      updatedAt: new Date().toISOString(),
      wibTime: new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) + " WIB",
      obsTime: framesMeta[0]?.timeLabel || "Terkini",
      region: "All Sumatera (WMS Nasional BMKG)",
      bounds: [[-11.1784, 90.0], [11.1784, 112.5]],
      frames: framesMeta.reverse()
    };

    fs.writeFileSync(path.resolve(".", "radar-frames.json"), JSON.stringify(outputData, null, 2));
    console.log("🎉 [SUKSES BESAR] Semua tile radar & radar-frames.json berhasil diunduh via Stealth Browser!");

  } catch (err) {
    console.error("❌ [ERROR STEALTH SCRAPER]:", err);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
