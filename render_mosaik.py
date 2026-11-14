import json, os, io, sys
from PIL import Image, ImageDraw, ImageFont
import urllib.request

def render_mosaik():
    frames_path = os.path.join(os.path.dirname(__file__), "radar-frames.json")
    if not os.path.exists(frames_path):
        return

    with open(frames_path) as f:
        data = json.load(f)

    if not data.get("frames"):
        return

    latest = data["frames"][-1]
    ts = latest.get("timestamp")
    radar_file = os.path.join(os.path.dirname(__file__), f"radar_sumsel_{ts}.png")
    if not os.path.exists(radar_file):
        return

    z = 6
    x_range = range(48, 52)
    y_range = range(30, 34)

    basemap = Image.new("RGBA", (1024, 1024))
    opener = urllib.request.build_opener()
    opener.addheaders = [("User-Agent", "Mozilla/5.0")]

    for col_idx, x in enumerate(x_range):
        for row_idx, y in enumerate(y_range):
            url = f"https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"
            try:
                with opener.open(url, timeout=10) as res:
                    tile = Image.open(io.BytesIO(res.read())).convert("RGBA")
                    basemap.paste(tile, (col_idx * 256, row_idx * 256))
            except Exception as e:
                pass

    radar = Image.open(radar_file).convert("RGBA")
    composed = Image.alpha_composite(basemap, radar)

    # Simpan komposit statis
    out_jpg = os.path.join(os.path.dirname(__file__), "mosaik_sumatera_latest.jpg")
    composed.convert("RGB").save(out_jpg, quality=92)
    print("Mosaik berhasil di-render:", out_jpg)

if __name__ == "__main__":
    render_mosaik()
