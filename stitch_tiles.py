import os, sys, json
from PIL import Image

def stitch_radar_frames():
    frames_json_path = "radar-frames.json"
    if not os.path.exists(frames_json_path):
        print("radar-frames.json tidak ditemukan!")
        return

    with open(frames_json_path) as f:
        data = json.load(f)

    frames = data.get("frames", [])
    if not frames:
        print("Tidak ada frames di radar-frames.json")
        return

    z = 6
    x_range = range(48, 52)
    y_range = range(30, 34)

    stitched_count = 0
    valid_frames = []

    for f_info in frames:
        ts = f_info.get("timestamp")
        out_png = f_info.get("filename", f"radar_sumsel_{ts}.png")
        
        # Cek apakah semua 16 tile ada
        tiles_exist = True
        for x in x_range:
            for y in y_range:
                tile_file = f"tile_{ts}_{z}_{x}_{y}.png"
                if not os.path.exists(tile_file):
                    tiles_exist = False
                    break
            if not tiles_exist:
                break

        if tiles_exist:
            mosaic = Image.new("RGBA", (len(x_range) * 256, len(y_range) * 256), (0, 0, 0, 0))
            for col_idx, x in enumerate(x_range):
                for row_idx, y in enumerate(y_range):
                    tile_file = f"tile_{ts}_{z}_{x}_{y}.png"
                    tile_img = Image.open(tile_file).convert("RGBA")
                    mosaic.paste(tile_img, (col_idx * 256, row_idx * 256))
                    try:
                        os.remove(tile_file) # Bersihkan tile sementara
                    except:
                        pass
            
            mosaic.save(out_png, "PNG")
            print(f"✅ Stitched frame {ts} -> {out_png}")
            f_info["url"] = f"https://raw.githubusercontent.com/ciroxtreme/Uvuvew/main/{out_png}"
            f_info["path"] = out_png
            valid_frames.append(f_info)
            stitched_count += 1
        else:
            # Jika tile tidak ada, cek apakah file output sudah ada sebelumnya
            if os.path.exists(out_png):
                valid_frames.append(f_info)

    data["frames"] = valid_frames
    with open(frames_json_path, "w") as f:
        json.dump(data, f, indent=2)

    print(f"🎉 Berhasil menjahit {stitched_count} frame radar mosaik BMKG!")

if __name__ == "__main__":
    stitch_radar_frames()
