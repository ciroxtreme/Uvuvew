import os
import sys
import re
import json
import time
import socket
import base64
import zlib
import struct
import urllib.parse
from camoufox.sync_api import Camoufox

def get_blank_transparent_png(width=256, height=256):
    def png_chunk(chunk_type, data):
        length = struct.pack('>I', len(data))
        crc = struct.pack('>I', zlib.crc32(chunk_type + data) & 0xffffffff)
        return length + chunk_type + data + crc

    header = b'\x89PNG\r\n\x1a\n'
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    ihdr = png_chunk(b'IHDR', ihdr_data)
    raw_scanlines = b''.join(b'\x00' + b'\x00' * (width * 4) for _ in range(height))
    idat = png_chunk(b'IDAT', zlib.compress(raw_scanlines))
    iend = png_chunk(b'IEND', b'')
    return header + ihdr + idat + iend

def get_warp_or_proxy():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1)
    try:
        s.connect(("127.0.0.1", 40000))
        s.close()
        print("✅ [WARP] Terdeteksi Cloudflare WARP SOCKS5 Tunnel aktif di 127.0.0.1:40000!")
        return {"server": "socks5://127.0.0.1:40000"}
    except Exception:
        pass

    env_proxy = os.environ.get("PROXY_URL", "").strip()
    if env_proxy:
        try:
            p = urllib.parse.urlparse(env_proxy)
            if p.hostname and p.port:
                cfg = {"server": f"{p.scheme or 'http'}://{p.hostname}:{p.port}"}
                if p.username:
                    cfg["username"] = urllib.parse.unquote(p.username)
                if p.password:
                    cfg["password"] = urllib.parse.unquote(p.password)
                return cfg
        except Exception as e:
            print(f"⚠️ Gagal parse env proxy: {e}")
    return None

def main():
    print("🚀 [CAMOUFOX ENGINE] Meluncurkan Stealth Browser untuk menembus Cloudflare BMKG...")

    proxy_cfg = get_warp_or_proxy()
    if proxy_cfg:
        print(f"🌐 [EGRESS] Menggunakan proxy: {proxy_cfg['server']}")
    else:
        print("🌐 [EGRESS] Menggunakan Direct IP...")

    camoufox_kwargs = {
        "headless": True,
        "humanize": True,
        "i_know_what_im_doing": True,
        "window": (1280, 800)
    }

    if proxy_cfg:
        camoufox_kwargs["proxy"] = proxy_cfg
        camoufox_kwargs["geoip"] = True

    with Camoufox(**camoufox_kwargs) as browser:
        page = browser.new_page()

        # Intercept network responses untuk mendeteksi tile URL format asli yang diminta Leaflet map
        real_tile_urls = []

        def handle_request(req):
            if "tiles" in req.url or "sidarma" in req.url:
                real_tile_urls.append(req.url)

        page.on("request", handle_request)

        target_url = "https://www.bmkg.go.id/cuaca/radar"
        print(f"📡 [NAVIGASI] Mengakses {target_url} ...")
        page.goto(target_url, timeout=60000)

        # Pantau Turnstile dan resolusi SPA dengan mekanisme reload / auto-retry
        solved = False
        html_content = ""
        max_attempts = 3

        for attempt in range(1, max_attempts + 1):
            if attempt > 1:
                print(f"🔄 [RETRY] Percobaan ke-{attempt}/{max_attempts} menembus Turnstile (Reload halaman)...")
                try:
                    page.reload(timeout=45000)
                except Exception as e:
                    print(f"⚠️ Error saat reload: {e}")
                    page.goto(target_url, timeout=60000)

            # Polling selama 45 detik per attempt
            for i in range(23):
                time.sleep(2)
                try:
                    title = page.title()
                    html_content = page.content()
                except Exception:
                    continue

                has_nuxt = "__NUXT_DATA__" in html_content or "Radar Cuaca" in title
                print(f"⏳ [TUNGGU VERIFIKASI (Try {attempt})] Detik ke-{(i+1)*2}: Title='{title}', Has NUXT={has_nuxt}")

                if "Radar Cuaca" in title or (has_nuxt and "just a moment" not in title.lower()):
                    time.sleep(5)
                    html_content = page.content()
                    solved = True
                    break

                # Coba bantu klik checkbox turnstile jika muncul iframe tantangan
                try:
                    for frame in page.frames:
                        if "challenges.cloudflare.com" in frame.url:
                            cb = frame.query_selector("input[type='checkbox'], #challenge-stage, .ctp-checkbox-label, label, div.cb-lb")
                            if cb:
                                print(f"👆 [CLICK (Try {attempt})] Mengklik elemen Turnstile di dalam iframe...")
                                cb.click()
                except Exception:
                    pass

            if solved:
                break

        if not solved:
            print("❌ Gagal melewati Cloudflare Turnstile setelah 3 percobaan reload")
            sys.exit(1)

        print("✅ [CF CLEARANCE] Berhasil menembus Cloudflare Turnstile BMKG!")
        if real_tile_urls:
            print("🔍 [TILE SAMPLE DARI LEAFLET]:", real_tile_urls[:3])

        # Cari daftar nama layer sidarma_mosaic_cmax
        layer_names = []
        dom_matches = page.evaluate("""() => {
            const matches = [];
            const text = document.documentElement.innerHTML;
            const re = /sidarma_mosaic_cmax:Indonesia_[0-9]{12}/g;
            let m;
            while ((m = re.exec(text)) !== null) {
                matches.push(m[0]);
            }
            return matches;
        }""")
        if dom_matches:
            layer_names.extend(dom_matches)

        regex_matches = re.findall(r'sidarma_mosaic_cmax:Indonesia_[0-9]{12}', html_content)
        if regex_matches:
            layer_names.extend(regex_matches)

        unique_layers = sorted(list(set(layer_names)), reverse=True)
        print(f"🎯 [LAYERS] Ditemukan {len(unique_layers)} layer radar sidarma BMKG: {unique_layers[:5]}")

        if not unique_layers:
            print("❌ Tidak ada layer radar sidarma_mosaic_cmax yang ditemukan!")
            sys.exit(1)

        # Ambil 8 layer terakhir
        selected_layers = unique_layers[:8]
        z = 6
        x_range = [48, 49, 50, 51]
        y_range = [30, 31, 32, 33]

        frames_meta = []
        for idx, layer in enumerate(selected_layers):
            match_ts = re.search(r'Indonesia_([0-9]{12})', layer)
            ts = match_ts.group(1) if match_ts else str(int(time.time()))
            id_str = f"{idx * 10:02d}"
            filename = f"radar_sumsel_{ts}.png"
            tile_prefix = f"tile_{ts}_6"

            time_label = ts
            if match_ts:
                y, m, d, h, mn = ts[0:4], ts[4:6], ts[6:8], ts[8:10], ts[10:12]
                time_label = f"{d}/{m}/{y} • {h}.{mn} WIB"

            frames_meta.append({
                "id": id_str,
                "filename": filename,
                "timestamp": ts,
                "timeLabel": time_label,
                "layerName": layer,
                "tilePrefix": tile_prefix
            })

            print(f"⬇️ [UNDUH TILE] Mengunduh 16 tile via Native Browser Fetch untuk frame {idx + 1}/{len(selected_layers)} ({ts})...")
            
            # Download langsung via native page fetch di dalam browser Camoufox
            tiles_to_fetch = []
            for x in x_range:
                for y in y_range:
                    tiles_to_fetch.append({"x": x, "y": y, "z": z, "layer": layer})

            results = page.evaluate("""async (tiles) => {
                const fetched = [];
                for (const t of tiles) {
                    const encodedLayer = encodeURIComponent(t.layer);
                    // Coba endpoint 1: /api/cuaca/radar/tiles
                    const url1 = `/api/cuaca/radar/tiles/${t.z}/${t.x}/${t.y}?layer=${encodedLayer}`;
                    try {
                        let res = await fetch(url1);
                        if (!res.ok) {
                            // Coba fallback endpoint 2: WMS GetMap
                            const c = 20037508.342789244;
                            const n = Math.pow(2, t.z);
                            const resDist = (2.0 * c) / n;
                            const minx = (-c + t.x * resDist).toFixed(4);
                            const maxx = (-c + (t.x + 1) * resDist).toFixed(4);
                            const maxy = (c - t.y * resDist).toFixed(4);
                            const miny = (c - (t.y + 1) * resDist).toFixed(4);
                            const bbox = `${minx},${miny},${maxx},${maxy}`;
                            const wmsUrl = `/cuaca/radar/wms?service=WMS&request=GetMap&layers=${encodedLayer}&styles=CMAX_dBZ&format=image/png&transparent=true&version=1.1.1&width=256&height=256&srs=EPSG:3857&bbox=${bbox}`;
                            res = await fetch(wmsUrl);
                        }

                        if (res.ok) {
                            const blob = await res.blob();
                            const reader = new FileReader();
                            const base64 = await new Promise((resolve) => {
                                reader.onloadend = () => resolve(reader.result.split(',')[1]);
                                reader.readAsDataURL(blob);
                            });
                            fetched.push({ x: t.x, y: t.y, z: t.z, ok: true, data: base64, status: res.status });
                        } else {
                            fetched.push({ x: t.x, y: t.y, z: t.z, ok: false, status: res.status });
                        }
                    } catch (e) {
                        fetched.push({ x: t.x, y: t.y, z: t.z, ok: false, error: e.message });
                    }
                }
                return fetched;
            }""", tiles_to_fetch)

            succ_count = 0
            for r in results:
                tile_file = f"tile_{ts}_{r['z']}_{r['x']}_{r['y']}.png"
                if r.get("ok") and r.get("data"):
                    with open(tile_file, "wb") as f_out:
                        f_out.write(base64.b64decode(r["data"]))
                    succ_count += 1
                else:
                    # Sparse tile: simpan tile transparan kosong agar frame tetap utuh
                    with open(tile_file, "wb") as f_out:
                        f_out.write(get_blank_transparent_png())
                    succ_count += 1

            print(f"  -> Berhasil menyimpan {succ_count}/16 tile untuk timestamp {ts}")

        # Buat radar-frames.json
        from datetime import datetime, timezone, timedelta
        wib_time = datetime.now(timezone(timedelta(hours=7))).strftime("%H:%M:%S WIB")

        output_data = {
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "wibTime": wib_time,
            "obsTime": frames_meta[0]["timeLabel"] if frames_meta else "Terkini",
            "region": "All Sumatera (WMS Nasional BMKG)",
            "bounds": [[-11.1784, 90.0], [11.1784, 112.5]],
            "frames": list(reversed(frames_meta))
        }

        with open("radar-frames.json", "w") as f_out:
            json.dump(output_data, f_out, indent=2)

        print("🎉 [SUKSES BESAR] Semua tile radar & radar-frames.json berhasil diunduh via Native Camoufox Fetch!")

if __name__ == "__main__":
    main()
