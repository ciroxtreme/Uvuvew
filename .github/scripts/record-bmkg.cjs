// Rekam jawaban challenge BMKG lewat capture-proxy di GitHub Actions.
// Dijalankan dengan Chrome beneran (headed, Xvfb), BUKAN headless,
// supaya tidak gampang kedeteksi antibot Cloudflare.
// Prasyarat: capture-proxy jalan di 127.0.0.1:8888, env CHROME_PATH
// menunjuk ke binary Chrome, NODE_PATH mengarah ke playwright-core.
// File ini .cjs supaya require() bisa pakai NODE_PATH.
const { chromium } = require('playwright-core');

(async () => {
  const CHROME = process.env.CHROME_PATH;
  if (!CHROME) { console.error('CHROME_PATH kosong'); process.exit(1); }

  const browser = await chromium.launch({
    headless: false,
    executablePath: CHROME,
    proxy: { server: 'http://127.0.0.1:8888' },
    args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, // iPhone-ish, cocok dgn profil safari-26-ios
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.3 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const url = 'https://www.bmkg.go.id/cuaca/radar';
  console.log('membuka', url, 'lewat capture-proxy 127.0.0.1:8888');
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.log('GOTO ERROR:', String(e).slice(0, 200));
  }

  // Coba klik checkbox Turnstile kalau muncul (maks 3x percobaan).
  for (let attempt = 1; attempt <= 3; attempt++) {
    const html = await page.content().catch(() => '');
    if (html.includes('__NUXT_DATA__')) { console.log('SUDAH LOLOS: __NUXT_DATA__ ketemu'); break; }
    console.log(`percobaan klik checkbox #${attempt}...`);
    let clicked = false;
    try {
      const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]').first();
      const box = frame.locator('input[type="checkbox"]').first();
      await box.click({ timeout: 10000 });
      clicked = true;
      console.log('checkbox diklik');
    } catch (e) {
      console.log('klik via input gagal:', String(e).slice(0, 120));
      try {
        const frame = page.frameLocator('iframe[title*="Cloudflare"]').first();
        await frame.locator('body').click({ timeout: 10000, position: { x: 30, y: 30 } });
        clicked = true;
        console.log('klik via body iframe');
      } catch (e2) {
        console.log('klik via body gagal:', String(e2).slice(0, 120));
      }
    }
    await page.waitForTimeout(15000);
    const html2 = await page.content().catch(() => '');
    console.log(`setelah klik: nuxt=${html2.includes('__NUXT_DATA__')} title=${JSON.stringify(await page.title().catch(() => ''))}`);
    if (html2.includes('__NUXT_DATA__')) break;
    if (!clicked) break;
  }

  // Tunggu final max 60 detik lagi
  for (let i = 0; i < 12; i++) {
    const html = await page.content().catch(() => '');
    if (html.includes('__NUXT_DATA__')) { console.log('HASIL AKHIR: LOLOS, __NUXT_DATA__ ada'); break; }
    await page.waitForTimeout(5000);
    if (i === 11) console.log('HASIL AKHIR: TIDAK LOLOS setelah semua percobaan');
  }
  const cookies = await ctx.cookies('https://www.bmkg.go.id').catch(() => []);
  console.log('cookies:', cookies.map(c => c.name).join(',') || '(none)');
  await page.screenshot({ path: 'record-screenshot.png' }).catch(() => {});
  await browser.close();
  console.log('SELESAI');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
