import os
import sys
import re
import json
import time
import socket
import urllib.parse
from camoufox.sync_api import Camoufox
import requests

def get_warp_or_proxy():
    # Cek apakah WARP SOCKS5 aktif di localhost:40000
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

        target_url = "https://www.bmkg.go.id/cuaca/radar"
        print(f"📡 [NAVIGASI] Mengakses {target_url} ...")
        page.goto(target_url, timeout=60000)

        # Pantau Turnstile dan resolusi SPA
        solved = False
        html_content = ""
        for i in range(40):
            time.sleep(2)
            title = page.title()
            html_content = page.content()
            has_nuxt = "__NUXT_DATA__" in html_content
            print(f"⏳ [TUNGGU VERIFIKASI] Detik ke-{(i+1)*2}: Title='{title}', Has NUXT={has_nuxt}")

            if has_nuxt:
                # Tunggu 3 detik ekstra agar DOM dan skrip selesai hydration
                time.sleep(3)
                html_content = page.content()
                solved = True
                break

            # Coba trigger / klik elemen Turnstile jika muncul di iframe
            try:
                for frame in page.frames:
                    if "challenges.cloudflare.com" in frame.url:
                        cb = frame.query_selector("input[type='checkbox'], #challenge-stage, .ctp-checkbox-label, label")
                        if cb:
                            print("👆 [CLICK] Mengklik elemen Turnstile di dalam iframe...")
                            cb.click()
            except Exception:
                pass

        if not solved:
            print("❌ Gagal melewati Cloudflare Turnstile setelah batas waktu")
            sys.exit(1)

        print("✅ [CF CLEARANCE] Berhasil menembus Cloudflare Turnstile BMKG!")

        # Ambil cookies dan user agent dari sesi browser Camoufox
        cookies = page.context.cookies()
        cookie_header = "; ".join([f"{c['name']}={c['value']}" for c in cookies])
        user_agent = page.evaluate("() => navigator.userAgent")
        print(f"🍪 [COOKIES] Mendapatkan {len(cookies)} cookies.")

        # Ekstrak data NUXT baik dari tag DOM via page.evaluate maupun dari regex HTML
        raw_nuxt_str = page.evaluate("""() => {
            const el = document.getElementById('__NUXT_DATA__');
            if (el) return el.textContent || el.innerText;
            const scripts = Array.from(document.querySelectorAll('script'));
            const nuxtScript = scripts.find(s => s.id === '__NUXT_DATA__' || (s.textContent && s.textContent.includes('sidarma_mosaic_cmax')));
            return nuxtScript ? (nuxtScript.textContent || nuxtScript.innerText) : null;
        }""")

        if not raw_nuxt_str:
            m = re.search(r'<script id="__NUXT_DATA__"[^>]*>([\s\S]*?)</script>', html_content)
            if m:
                raw_nuxt_str = m.group(1)

        if not raw_nuxt_str:
            print("❌ Tidak menemukan tag __NUXT_DATA__ di DOM maupun regex HTML!")
            print("HTML snippet (awal 1000 char):", html_content[:1000])
            sys.exit(1)

        nuxt_data = json.loads(raw_nuxt_str)
        print("📦 [NUXT DATA] Berhasil mem-parse data layer internal BMKG!")

        # Cari daftar nama layer sidarma_mosaic_cmax
        layer_names = []
        for item in nuxt_data:
            if isinstance(item, str) and item.startswith("sidarma_mosaic_cmax:Indonesia_"):
                layer_names.append(item)

        unique_layers = sorted(list(set(layer_names)), reverse=True)
        print(f"🎯 [LAYERS] Ditemukan {len(unique_layers)} layer radar sidarma BMKG: {unique_layers[:3]}")

        if not unique_layers:
            print("❌ Tidak ada layer radar sidarma_mosaic_cmax yang ditemukan di NUXT data!")
            sys.exit(1)

        # Ambil 8 layer terakhir
        selected_layers = unique_layers[:8]
        z = 6
        x_range = [48, 49, 50, 51]
        y_range = [30, 31, 32, 33]

        frames_meta = []
        req_proxies = None
        if proxy_cfg:
            srv = proxy_cfg["server"]
            req_proxies = {"http": srv, "https": srv}

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

            print(f"⬇️ [UNDUH TILE] Mengunduh 16 tile untuk frame {idx + 1}/{len(selected_layers)} ({ts})...")
            headers = {
                "Cookie": cookie_header,
                "User-Agent": user_agent,
                "Referer": "https://www.bmkg.go.id/cuaca/radar"
            }
            for x in x_range:
                for y in y_range:
                    tile_url = f"https://www.bmkg.go.id/api/cuaca/radar/tiles/{z}/{x}/{y}?layer={layer}"
                    tile_file = f"tile_{ts}_{z}_{x}_{y}.png"
                    try:
                        resp = requests.get(tile_url, headers=headers, proxies=req_proxies, timeout=15)
                        if resp.status_code == 200:
                            with open(tile_file, "wb") as f_out:
                                f_out.write(resp.content)
                        else:
                            print(f"⚠️ Status {resp.status_code} saat unduh {tile_url}")
                    except Exception as err:
                        print(f"⚠️ Gagal unduh {tile_url}: {err}")

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

        print("🎉 [SUKSES BESAR] Semua tile radar & radar-frames.json berhasil diunduh via Camoufox Stealth Browser!")

if __name__ == "__main__":
    main()
