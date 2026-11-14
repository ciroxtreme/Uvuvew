import urllib.request
import urllib.parse
import subprocess
import json
import time
import sys
import os

PROXY_SOURCES = [
    # Proxyscrape SOCKS5 / HTTP
    "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=4000&country=all",
    "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=3000&country=all",
    # TheSpeedX list
    "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt",
    "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt"
]

def fetch_free_proxies():
    proxies = []
    opener = urllib.request.build_opener()
    opener.addheaders = [("User-Agent", "Mozilla/5.0")]

    for src in PROXY_SOURCES:
        try:
            with opener.open(src, timeout=8) as res:
                text = res.read().decode('utf-8', errors='ignore')
                for line in text.splitlines():
                    p = line.strip()
                    if p and ":" in p and not p.startswith("#"):
                        # Format socks5:// atau http://
                        proto = "socks5" if "socks5" in src.lower() else "http"
                        proxies.append(f"{proto}://{p}")
            if len(proxies) >= 40:
                break
        except Exception as e:
            continue
    return proxies

def try_solve_with_proxies(binary_path, out_dir):
    print("🌐 Mengambil daftar proxy gratisan untuk bypass IP GitHub Actions...")
    proxy_list = fetch_free_proxies()
    print(f"[*] Berhasil mendapatkan {len(proxy_list)} kandidat proxy!")

    # Coba tanpa proxy terlebih dahulu
    candidates = [None] + proxy_list[:25]

    for idx, proxy in enumerate(candidates):
        proxy_label = proxy if proxy else "Direct (IP Runner)"
        print(f"\n🚀 [{idx+1}/{len(candidates)}] Mencoba Turnstile BMKG via: {proxy_label}")
        
        env = os.environ.copy()
        if proxy:
            env["HTTP_PROXY"] = proxy
            env["HTTPS_PROXY"] = proxy
            env["ALL_PROXY"] = proxy

        cmd = [binary_path, out_dir]
        if proxy:
            cmd.extend(["--proxy", proxy])

        try:
            p = subprocess.run(cmd, env=env, timeout=45, capture_output=True, text=True)
            print("Output:\n", p.stderr[-500:] if len(p.stderr) > 500 else p.stderr)
            if p.returncode == 0:
                print(f"🎉 SUKSES BESAR! Berhasil tembus menggunakan proxy: {proxy_label}")
                return True
        except subprocess.TimeoutExpired:
            print(f"[-] Timeout (45s) pada proxy {proxy_label}, beralih ke proxy berikutnya...")
        except Exception as err:
            print(f"[-] Error: {err}")

    print("⚠️ Seluruh kandidat proxy dicoba. Melanjutkan alur workflow.")
    return False

if __name__ == "__main__":
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    binary_candidates = [
        "./cfsolve/target/release/export_bmkg_radar",
        "./target/release/export_bmkg_radar",
        "/home/container/files/cfsolve-repo/target/release/export_bmkg_radar"
    ]
    target_bin = None
    for b in binary_candidates:
        if os.path.exists(b):
            target_bin = b
            break
    if not target_bin:
        print("Binary export_bmkg_radar belum terkompilasi!")
        sys.exit(0)

    try_solve_with_proxies(target_bin, out_dir)
