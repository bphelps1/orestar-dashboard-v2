"""Download named Capitol Club portraits into reviewed same-origin web assets.

No database changes. Match by the directory's stable cc_id, not face recognition.
Run manually or through the manual photo PR workflow. Failed downloads preserve
an existing portrait only when its cc_id and source name still agree.
"""
import argparse
import hashlib
import io
import json
import re
import time
from pathlib import Path
from urllib.parse import urlparse

import requests
from PIL import Image, ImageOps
from fetch_capitol_club import HEADERS, MEMBER_URL, scrape_members

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'docs/assets/lobbyist-photos.json'
IMAGE_DIR = ROOT / 'docs/assets/lobbyist-photos'


def allowed_photo(url):
    p = urlparse(url)
    return (p.scheme == 'https' and p.netloc in {'oregoncapitolclub.org', 'www.oregoncapitolclub.org'}
            and p.path.startswith('/wp-content/uploads/')
            and not re.search(r'placeholder|default|no[-_]?image|blank|avatar', p.path, re.I))


def thumbnail(content):
    Image.MAX_IMAGE_PIXELS = 25000000
    with Image.open(io.BytesIO(content)) as source:
        # Large camera JPEGs can be decoded at reduced resolution without
        # allocating their full pixel buffers. Keep the decoded-pixel bound.
        if source.format == 'JPEG' and source.width * source.height > 25000000:
            source.draft('RGB', (320, 400))
        if source.width * source.height > 25000000:
            raise ValueError('Portrait exceeds pixel limit')
        source.load()
        image = ImageOps.exif_transpose(source).convert('RGB')
        # Fit, never crop a face. A common canvas keeps Excel portraits aligned.
        image.thumbnail((160, 200))
        canvas = Image.new('RGB', (160, 200), 'white')
        canvas.paste(image, ((160-image.width)//2, (200-image.height)//2))
        out = io.BytesIO()
        canvas.save(out, format='JPEG', quality=85, optimize=True)
        return out.getvalue()


def refresh(members, session, delay_seconds=5.0):
    if delay_seconds < 1:
        raise ValueError('Photo request delay must be at least one second')
    if len(members) < 100 or len({m['cc_id'] for m in members}) != len(members):
        raise ValueError('Incomplete or duplicated directory; keeping prior photo manifest')
    previous = json.loads(MANIFEST.read_text()).get('photos', {}) if MANIFEST.exists() else {}
    # Individually reviewed official-site portraits are maintained separately
    # from directory acquisition and must survive a successful CC refresh.
    photos = {key: photo for key, photo in previous.items()
              if re.fullmatch(r'lobbyist-\d+', key)
              and re.fullmatch(r'assets/lobbyist-photos/lobbyist-\d+-[a-f0-9]{12}\.jpg', photo.get('path', ''))
              and (ROOT / 'docs' / photo['path']).is_file()}
    files, failed = {}, []
    cache_file = ROOT / 'data/capitol_club_photo_cache.json'
    cache = json.loads(cache_file.read_text()) if cache_file.exists() else {}
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    for index, m in enumerate(members):
        if index % 25 == 0:
            print(f'Photos: {index}/{len(members)}', flush=True)
        key, url = m['cc_id'], m.get('photo_url', '')
        if not re.fullmatch(r'user-\d+', key) or not allowed_photo(url):
            continue
        cached = cache.get(key)
        if (cached and cached['photo']['source'] == url and cached['photo']['name'] == m['name']
                and time.time() - cached['time'] < 86400
                and (ROOT / 'docs' / cached['photo']['path']).is_file()):
            photos[key] = cached['photo']
            continue
        response = None
        time.sleep(delay_seconds)
        try:
            response = session.get(url, headers={'Referer': MEMBER_URL}, timeout=20, stream=True, allow_redirects=False)
            if response.status_code == 429:
                raise RuntimeError(f'Source rate limited at {key}; retry in a later run (Retry-After: {response.headers.get("Retry-After", "not supplied")})')
            response.raise_for_status()
            if response.status_code != 200 or not response.headers.get('Content-Type', '').startswith('image/'):
                raise ValueError('Not an image response')
            data = bytearray()
            for chunk in response.iter_content(65536):
                data.extend(chunk)
                if len(data) > 8_000_000:
                    raise ValueError('Image exceeds download limit')
            response.close()
            jpg = thumbnail(data)
            filename = f'{key}-{hashlib.sha256(jpg).hexdigest()[:12]}.jpg'
            files[filename] = jpg
            photos[key] = {'name': m['name'], 'path': f'assets/lobbyist-photos/{filename}',
                           'source': url, 'profile': m.get('profile_url') or MEMBER_URL}
            # Checkpoint completed files without publishing an incomplete catalog.
            (IMAGE_DIR / filename).write_bytes(jpg)
            cache[key] = {'time':time.time(), 'photo':photos[key]}
            cache_file.write_text(json.dumps(cache))
        except (requests.RequestException, OSError, ValueError, Image.DecompressionBombError) as error:
            failed.append(key)
            if len(failed) > max(10, len(members) * .1):
                raise ValueError('Photo downloads blocked; preserving previous assets') from error
            old = previous.get(key)
            if old and old['name'] == m['name'] and (ROOT / 'docs' / old['path']).is_file():
                photos[key] = old
            print(f'{key}: photo unavailable ({type(error).__name__})', flush=True)
        finally:
            if response is not None:
                response.close()
    if len(photos) < 50 or len(failed) > max(10, len(members) * .1):
        raise ValueError('Photo acquisition incomplete; keeping prior assets')
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    for filename, content in files.items():
        (IMAGE_DIR / filename).write_bytes(content)
    temporary = MANIFEST.with_suffix('.tmp')
    temporary.write_text(json.dumps({'version': 1, 'source': MEMBER_URL, 'photos': photos}, indent=2) + '\n')
    temporary.replace(MANIFEST)
    used = {Path(p['path']).name for p in photos.values()}
    for old_file in IMAGE_DIR.glob('user-*-*.jpg'):
        if old_file.name not in used and re.fullmatch(r'user-\d+-[a-f0-9]{12}\.jpg', old_file.name):
            old_file.unlink()
    print(f'{len(photos)} portraits; {len(failed)} unavailable downloads', flush=True)


def main():
    session = requests.Session()
    session.headers.update(HEADERS)
    parser = argparse.ArgumentParser()
    parser.add_argument('--from-json', action='store_true', help='Resume the most recent local directory snapshot')
    parser.add_argument('--delay-seconds', type=float, default=5.0, help='Pause before each image request (default: 5 seconds)')
    args = parser.parse_args()
    snapshot = ROOT / 'data/capitol_club_photos_source.json'
    if args.from_json:
        members = json.loads(snapshot.read_text())['members']
    else:
        members = scrape_members(session)
        snapshot.write_text(json.dumps({'members':members}))
    # Directory browsing and static asset delivery use separate sessions.
    images = requests.Session()
    images.headers.update(HEADERS)
    refresh(members, images, args.delay_seconds)


if __name__ == '__main__':
    main()
