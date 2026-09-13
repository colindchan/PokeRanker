#!/usr/bin/env python3
import argparse
import csv
import json
import mimetypes
import re
import ssl
import sys
import time
import unicodedata
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


BASE_URL = "https://www.pokemon.com"
COLLECTION_URL = f"{BASE_URL}/api/1/us/kalos/kalos"
IMAGE_BASE_URL = f"{BASE_URL}/static-assets/content-assets/cms2/img/pokedex/full"
DEFAULT_MAX_DEX = 1025
USER_AGENT = "PokemonImageDownloader/1.0 (+personal archival script; respectful delay)"

FIRST_FIVE = [
    {"number": "0001", "name": "Bulbasaur", "slug": "bulbasaur"},
    {"number": "0002", "name": "Ivysaur", "slug": "ivysaur"},
    {"number": "0003", "name": "Venusaur", "slug": "venusaur"},
    {"number": "0004", "name": "Charmander", "slug": "charmander"},
    {"number": "0005", "name": "Charmeleon", "slug": "charmeleon"},
]


def ssl_context():
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


SSL_CONTEXT = ssl_context()


def request_url(url, timeout=30):
    req = Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/json,image/avif,image/webp,image/png,*/*",
            "Referer": "https://www.pokemon.com/us/pokedex",
        },
    )
    with urlopen(req, timeout=timeout, context=SSL_CONTEXT) as response:
        return response.geturl(), response.headers, response.read()


def slugify_name(name):
    text = unicodedata.normalize("NFKD", name)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower()
    text = text.replace("♀", " female").replace("♂", " male")
    text = text.replace("'", "").replace("’", "")
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


def safe_filename_name(name):
    text = unicodedata.normalize("NFKD", name)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower().replace("♀", " female").replace("♂", " male")
    text = text.replace("'", "").replace("’", "")
    text = re.sub(r"[^a-z0-9]+", "_", text)
    return text.strip("_")


def normalize_number(value):
    digits = re.sub(r"\D", "", str(value))
    if not digits:
        raise ValueError(f"missing Pokédex number in {value!r}")
    return f"{int(digits):04d}"


def load_official_collection():
    _, headers, body = request_url(COLLECTION_URL)
    content_type = headers.get("content-type", "")
    if "json" not in content_type.lower():
        raise RuntimeError(f"official collection endpoint did not return JSON: {content_type}")
    data = json.loads(body.decode("utf-8"))
    entries = []
    for item in data:
        number = normalize_number(item.get("number"))
        entries.append(
            {
                "number": number,
                "name": item["name"],
                "slug": item.get("slug") or slugify_name(item["name"]),
                "detail_page_url": urljoin(BASE_URL, item.get("detailPageURL", "")),
                "thumbnail": item.get("ThumbnailImage", ""),
            }
        )
    return entries


def load_pokeapi_species(max_dex):
    url = f"https://pokeapi.co/api/v2/pokemon-species?limit={max_dex}&offset=0"
    _, headers, body = request_url(url)
    if "json" not in headers.get("content-type", "").lower():
        raise RuntimeError("PokéAPI fallback did not return JSON")
    payload = json.loads(body.decode("utf-8"))
    entries = []
    for index, item in enumerate(payload["results"], start=1):
        slug = item["name"]
        name = " ".join(part.capitalize() for part in slug.split("-"))
        entries.append({"number": f"{index:04d}", "name": name, "slug": slug})
    return entries


def load_entries(limit, max_dex):
    if limit and limit <= 5:
        return FIRST_FIVE[:limit]

    try:
        return load_official_collection()
    except Exception as official_error:
        manifest = Path("pokemon_manifest.json")
        if manifest.exists():
            with manifest.open("r", encoding="utf-8") as f:
                return json.load(f)
        print(f"Warning: official collection API unavailable: {official_error}", file=sys.stderr)
        print("Warning: using PokéAPI for names/slugs while keeping Pokemon.com pages/images.", file=sys.stderr)
        return load_pokeapi_species(max_dex)


def source_page_url(entry):
    return entry.get("detail_page_url") or f"{BASE_URL}/us/pokedex/{entry['slug']}"


def extract_main_image_url(entry):
    number3 = str(int(entry["number"])).zfill(3)
    page_url = source_page_url(entry)
    try:
        _, headers, body = request_url(page_url)
        if "html" in headers.get("content-type", "").lower():
            html = body.decode("utf-8", errors="replace")
            pattern = rf'https?://[^"\']*/pokedex/full/{number3}\.(?:png|webp|jpe?g)'
            match = re.search(pattern, html, flags=re.IGNORECASE)
            if match:
                return match.group(0), "page-html"
            rel_pattern = rf'["\']([^"\']*/pokedex/full/{number3}\.(?:png|webp|jpe?g))["\']'
            match = re.search(rel_pattern, html, flags=re.IGNORECASE)
            if match:
                return urljoin(BASE_URL, match.group(1)), "page-html"
    except Exception:
        pass
    return f"{IMAGE_BASE_URL}/{number3}.png", "canonical-full-asset"


def extension_from_response(url, headers):
    suffix = Path(url.split("?", 1)[0]).suffix.lower()
    if suffix in {".png", ".webp", ".jpg", ".jpeg"}:
        return suffix
    guessed = mimetypes.guess_extension(headers.get("content-type", "").split(";", 1)[0].strip())
    return guessed if guessed in {".png", ".webp", ".jpg", ".jpeg"} else ".img"


def download_image(url):
    final_url, headers, body = request_url(url, timeout=60)
    content_type = headers.get("content-type", "").lower()
    if not content_type.startswith("image/"):
        raise RuntimeError(f"not an image response: {headers.get('content-type')}")
    return final_url, headers, body


def write_log(log_path, rows):
    with log_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "pokedex_number",
                "pokemon_name",
                "source_page_url",
                "downloaded_image_url",
                "local_filename",
                "success_failure",
                "selection_method",
                "error",
            ],
        )
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description="Download main Pokemon.com Pokédex artwork.")
    parser.add_argument("--limit", type=int, default=None, help="Only process the first N Pokémon.")
    parser.add_argument("--delay", type=float, default=1.0, help="Delay in seconds between requests.")
    parser.add_argument("--max-dex", type=int, default=DEFAULT_MAX_DEX, help="Fallback National Dex maximum.")
    parser.add_argument("--output-dir", default="pokemon_images", help="Folder for downloaded images.")
    parser.add_argument("--log", default="pokemon_images_log.csv", help="CSV log file path.")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    entries = load_entries(args.limit, args.max_dex)
    entries = entries[: args.limit] if args.limit else entries
    rows = []
    seen_urls = set()

    for entry in entries:
        page_url = source_page_url(entry)
        image_url = ""
        filename = ""
        status = "failure"
        method = ""
        error = ""
        try:
            image_url, method = extract_main_image_url(entry)
            normalized_image_url = image_url.split("?", 1)[0]
            if normalized_image_url in seen_urls:
                raise RuntimeError("duplicate image URL skipped")
            seen_urls.add(normalized_image_url)

            final_url, headers, body = download_image(image_url)
            ext = extension_from_response(final_url, headers)
            filename = f"{entry['number']}_{safe_filename_name(entry['name'])}{ext}"
            (output_dir / filename).write_bytes(body)
            image_url = final_url
            status = "success"
        except (HTTPError, URLError, TimeoutError, RuntimeError, OSError) as exc:
            error = str(exc)

        rows.append(
            {
                "pokedex_number": entry["number"],
                "pokemon_name": entry["name"],
                "source_page_url": page_url,
                "downloaded_image_url": image_url,
                "local_filename": filename,
                "success_failure": status,
                "selection_method": method,
                "error": error,
            }
        )
        write_log(Path(args.log), rows)
        print(f"{entry['number']} {entry['name']}: {status} {filename or error}")
        time.sleep(max(args.delay, 0))


if __name__ == "__main__":
    main()
