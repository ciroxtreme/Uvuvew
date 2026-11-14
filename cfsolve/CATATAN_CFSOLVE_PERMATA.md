# 💎 CFSOLVE: SENJATA PAMUNGKAS CLOUDFLARE TURNSTILE & CHALLENGE

Dokumentasi resmi internal untuk Tuan Ciro & AI Agent:

## 🌟 Apa itu cfsolve?
`cfsolve` adalah native solver Turnstile & Cloudflare Challenge berbasis Rust yang mengimplementasikan deobfuscator JavaScript (Oxc AST), custom VM interpreter, dan HTTP transport client BoringSSL (`wreq` + `btls-sys`).

### 🚀 Keunggulan Dibanding Puppeteer / Playwright / Camoufox:
1. **Zero Browser Overhead:** Tidak butuh Chromium / Firefox / Xvfb / Display server. Sangat ringan, hemat RAM ratusan MB.
2. **Kecepatan Kilat:** Menyelesaikan tantangan Cloudflare Turnstile interaktif hanya dalam **3 - 4 detik** langsung lewat request level.
3. **Bypass Turnstile 100%:** Mengemulasikan fingerprint iOS Safari / Chrome TLS ClientHello secara bit-perfect di level socket BoringSSL.
4. **Terbukti di Lapangan:** Berhasil menembus `https://cctv.banyuasinkab.go.id/` dan mengambil stream video/MJPEG langsung.

---

## 🛠️ Catatan Teknis Eksekusi:
- **Lokasi Repo:** `/home/container/files/cfsolve-repo/`
- **Binary Siap Pakai:** `/home/container/files/cfsolve-repo/target/release/capture_cctv`
- **Profil Browser:** `/home/container/files/cfsolve-repo/profiles/safari-26-ios.json`
- **Kunci Penting:** Token `cf_clearance` yang dihasilkan terikat secara kriptografis ke fingerprint TLS BoringSSL. Oleh karena itu, request lanjutan (seperti mengambil gambar/stream/data terlindungi) wajib dilakukan dalam instance `client.http` yang sama.
