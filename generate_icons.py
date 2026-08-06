"""Genera los íconos icon-192.png e icon-512.png a partir de iniciales y colores.

Uso:
    python generate_icons.py --iniciales ML --color-fondo "#2e5339" --color-circulo "#4a7c59" --color-texto "#f4f6f4"

Por defecto usa los colores de la plantilla (verde AppCampo).
"""

import argparse
from PIL import Image, ImageDraw, ImageFont


def make_icon(path, size, iniciales, color_fondo, color_circulo, color_texto):
    img = Image.new("RGB", (size, size), color_fondo)
    d = ImageDraw.Draw(img)
    margin = size * 0.12
    d.ellipse([margin, margin, size - margin, size - margin], fill=color_circulo)
    try:
        font = ImageFont.truetype("arialbd.ttf", int(size * 0.34))
    except Exception:
        font = ImageFont.load_default()
    bbox = d.textbbox((0, 0), iniciales, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((size - w) / 2 - bbox[0], (size - h) / 2 - bbox[1]), iniciales, fill=color_texto, font=font)
    img.save(path, "PNG")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iniciales", default="AC", help="Iniciales a mostrar en el ícono (2-3 letras)")
    parser.add_argument("--color-fondo", default="#2e5339")
    parser.add_argument("--color-circulo", default="#4a7c59")
    parser.add_argument("--color-texto", default="#f4f6f4")
    parser.add_argument("--out-dir", default="icons")
    args = parser.parse_args()

    make_icon(f"{args.out_dir}/icon-192.png", 192, args.iniciales, args.color_fondo, args.color_circulo, args.color_texto)
    make_icon(f"{args.out_dir}/icon-512.png", 512, args.iniciales, args.color_fondo, args.color_circulo, args.color_texto)
    print("Íconos generados en", args.out_dir)
