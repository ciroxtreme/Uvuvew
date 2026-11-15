import json, os, sys
from PIL import Image
from datetime import datetime, timezone, timedelta

def format_wib(label, ts):
    if ts and len(str(ts)) == 12:
        try:
            ts_str = str(ts)
            y = int(ts_str[:4])
            m = int(ts_str[4:6])
            d = int(ts_str[6:8])
            H = int(ts_str[8:10])
            M = int(ts_str[10:12])
            dt_utc = datetime(y, m, d, H, M, tzinfo=timezone.utc)
            dt_wib = dt_utc + timedelta(hours=7)
            months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']
            return f"{dt_wib.day:02d} {months[dt_wib.month - 1]} {dt_wib.year} • {dt_wib.hour:02d}.{dt_wib.minute:02d} WIB"
        except Exception:
            pass
    return label

def detect_rain_mosaic(frames_json_path, work_dir="."):
    if not os.path.exists(frames_json_path):
        return None
    with open(frames_json_path) as f:
        data = json.load(f)
    frames = data.get("frames", [])
    if not frames:
        return None
    
    latest_frame = frames[-1]
    filename = latest_frame.get("filename")
    ts = latest_frame.get("timestamp")
    png_path = os.path.join(work_dir, filename)
    if not os.path.exists(png_path):
        png_path = os.path.join(os.path.dirname(frames_json_path), filename)
        if not os.path.exists(png_path):
            return None

    img = Image.open(png_path).convert('RGBA')
    cx, cy = 643, 630 # Titik rumah (-2.5858, 104.12295) pada grid mosaik Sumatera 1024x1024
    
    rain_pixels = 0
    heavy_pixels = 0
    min_dist_px = 999
    
    # Radius ~30 km (~12 pixel, 1 pixel ~ 2.44 km)
    for dx in range(-12, 13):
        for dy in range(-12, 13):
            dist = (dx*dx + dy*dy) ** 0.5
            if dist > 12.5:
                continue
            x = cx + dx
            y = cy + dy
            if 0 <= x < 1024 and 0 <= y < 1024:
                r, g, b, a = img.getpixel((x, y))
                if a > 40:
                    # Spektrum pantulan Doppler BMKG CMAX:
                    # Biru/Cyan: ~15-25 dBZ (rintik/gerimis)
                    # Hijau: ~25-35 dBZ (hujan ringan-sedang)
                    # Kuning/Oranye: ~35-45 dBZ (hujan lebat)
                    # Merah/Ungu: >= 45 dBZ (sangat lebat/badai)
                    is_blue = (b > 170 and r < 120)
                    is_green = (g > 130 and b < 110)
                    is_yellow_red = (r > 170 and g > 90) or (r > 190 and g < 90)
                    
                    if is_blue or is_green or is_yellow_red:
                        rain_pixels += 1
                        if dist < min_dist_px:
                            min_dist_px = dist
                        if is_yellow_red or (g > 200 and r > 150):
                            heavy_pixels += 1
                            
    km_dist = round(min_dist_px * 2.44, 1) if min_dist_px < 999 else None
    time_label = format_wib(latest_frame.get("timeLabel", data.get("obsTime", "Live WIB")), ts)
    
    res = {
        "sensor": "radar_mosaik",
        "hasRain": bool(rain_pixels >= 4),
        "rainPixels": rain_pixels,
        "heavyRainPixels": heavy_pixels,
        "isHeavy": bool(heavy_pixels >= 3),
        "distanceKm": km_dist,
        "obsTime": time_label
    }
    return res

if __name__ == "__main__":
    work_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    json_path = os.path.join(work_dir, "radar-frames.json")
    out = detect_rain_mosaic(json_path, work_dir)
    print(json.dumps(out))
