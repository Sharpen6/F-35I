"""Encode a numbered image sequence (0001.jpg / 0001.png ...) to an H.264 MP4 with Blender's FFmpeg.

    blender -b --python scripts/video/encode_frames.py -- <frames folder> <out.mp4> [fps]

For machines without ffmpeg on the PATH (the flight-sim captures from sim/tests/pc_capture.py,
for example); with ffmpeg present, `ffmpeg -framerate 30 -i %04d.jpg -c:v libx264 -crf 18
-pix_fmt yuv420p out.mp4` does the same.
"""
import os
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) < 2:
    sys.exit("usage: blender -b --python encode_frames.py -- <frames folder> <out.mp4> [fps]")
folder, out = os.path.abspath(argv[0]), os.path.abspath(argv[1])
fps = int(argv[2]) if len(argv) > 2 else 30
names = sorted(f for f in os.listdir(folder) if f.lower().endswith((".jpg", ".jpeg", ".png")) and f[:4].isdigit())
if not names:
    sys.exit(f"no frames in {folder}")
img = bpy.data.images.load(os.path.join(folder, names[0]))
w, h = img.size
bpy.data.images.remove(img)
sc = bpy.data.scenes.new("Encode")
sc.render.resolution_x, sc.render.resolution_y = w + (w % 2), h + (h % 2)
sc.render.resolution_percentage = 100
sc.render.fps = fps
sc.frame_start, sc.frame_end = 1, len(names)
sc.view_settings.view_transform = 'Standard'
se = sc.sequence_editor_create()
strips = se.strips if hasattr(se, "strips") else se.sequences
st = strips.new_image("frames", os.path.join(folder, names[0]), 1, 1)
for n in names[1:]:
    st.elements.append(n)
r = sc.render
r.use_sequencer = True
if hasattr(r.image_settings, "media_type"):          # Blender 5: video is a media type
    r.image_settings.media_type = 'VIDEO'
r.image_settings.file_format = 'FFMPEG'
r.ffmpeg.format = 'MPEG4'
r.ffmpeg.codec = 'H264'
r.ffmpeg.constant_rate_factor = 'HIGH'
r.ffmpeg.ffmpeg_preset = 'GOOD'
r.filepath = out
os.makedirs(os.path.dirname(out), exist_ok=True)
bpy.ops.render.render(animation=True, scene=sc.name)
print(f"encoded {len(names)} frames at {fps} fps -> {out}")
