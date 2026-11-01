"""Minimal GLB reader / writer (plain Python) for checks and small JSON patches after export."""
import json
import struct

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942


def read(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, version, length = struct.unpack_from("<III", data, 0)
    assert magic == GLB_MAGIC and version == 2, "not a glTF 2 binary"
    off = 12
    doc, binc = None, b""
    while off < length:
        clen, ctype = struct.unpack_from("<II", data, off)
        chunk = data[off + 8: off + 8 + clen]
        if ctype == CHUNK_JSON:
            doc = json.loads(chunk.decode("utf-8"))
        elif ctype == CHUNK_BIN:
            binc = chunk
        off += 8 + clen
    return doc, binc


def write(path, doc, binc):
    js = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    js += b" " * ((4 - len(js) % 4) % 4)
    binc = binc + b"\0" * ((4 - len(binc) % 4) % 4)
    total = 12 + 8 + len(js) + (8 + len(binc) if binc else 0)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", GLB_MAGIC, 2, total))
        f.write(struct.pack("<II", len(js), CHUNK_JSON))
        f.write(js)
        if binc:
            f.write(struct.pack("<II", len(binc), CHUNK_BIN))
            f.write(binc)


def stats(doc):
    acc = doc.get("accessors", [])
    tris = 0
    prims = 0
    morph = 0
    for m in doc.get("meshes", []):
        for p in m["primitives"]:
            prims += 1
            if "indices" in p:
                tris += acc[p["indices"]]["count"] // 3
            else:
                tris += acc[p["attributes"]["POSITION"]]["count"] // 3
            morph += len(p.get("targets", []))
    imgs = []
    for im in doc.get("images", []):
        bv = doc["bufferViews"][im["bufferView"]] if "bufferView" in im else None
        imgs.append((im.get("name"), im.get("mimeType"), bv["byteLength"] if bv else 0))
    return {"nodes": len(doc.get("nodes", [])), "meshes": len(doc.get("meshes", [])), "primitives": prims,
            "triangles": tris, "materials": len(doc.get("materials", [])), "images": imgs,
            "morph_targets": morph, "extensions": doc.get("extensionsUsed", [])}


if __name__ == "__main__":
    # python3 sim/tools/aircraft/glb.py sim/data/aircraft/f35i.glb   -> a summary of the file
    import os
    import sys
    for p in sys.argv[1:]:
        d, b = read(p)
        st = stats(d)
        print(f"{p}: {os.path.getsize(p) / 1e6:.1f} MB, {st['triangles']} triangles, {st['nodes']} nodes, "
              f"{st['primitives']} primitives, {st['materials']} materials, {st['morph_targets']} morph targets")
        print("  extensions:", ", ".join(st["extensions"]))
        print("  nodes:", ", ".join(n.get("name", "?") for n in d.get("nodes", [])))
        for name, mime, size in st["images"]:
            print(f"  image {name} ({mime}, {size / 1e6:.2f} MB)")
