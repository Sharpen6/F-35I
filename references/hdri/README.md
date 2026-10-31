# Sky (HDRI)

`kloofendal_48d_partly_cloudy_2k.hdr`: "Kloofendal 48d Partly Cloudy" by Greg Zaal,
https://polyhaven.com/a/kloofendal_48d_partly_cloudy, licence CC0 (public domain).

The presentation scene (`scripts/f35/scene.py`) lights the jet with it. The sun is clipped out of the
image and replaced by a sun lamp with the same direction and irradiance (cached in `*.sun.json`), and
the sky is turned so that the sun stands at `SUN_ROT`. Without this file the build falls back to
Blender's procedural sky.

Review and clip renders swap in a bigger copy when one is here (`--hdri 8k,4k` in `clips.py`).
Those are not kept in git; fetch them with:

    python3 scripts/tools/get_hdri.py kloofendal_48d_partly_cloudy 4k 8k
