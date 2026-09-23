"""Add one individually reviewed portrait from an official site to the manifest.

The Capitol Club refresh keys its portraits by directory id (`user-NNN`) and
takes images only from oregoncapitolclub.org. Plenty of in-house association
staff are in that directory with the placeholder avatar and no photo of their
own, so their rows in the plan show "Photo unavailable".

For those the portrait comes from the organization's own staff page and is
keyed `lobbyist-<lobbyist_id>`, which `refresh_lobbyist_photos.refresh`
deliberately preserves across a directory run. This script is the reproducible
version of what was previously done by hand: fetch, check, thumbnail to the
same canvas, and merge one entry.

The check that matters is attribution: a portrait of the wrong person is worse
than none, so the surname has to appear in the image URL or on the profile
page, and the script prints what it matched on for a human to confirm.

    python scraper/add_reviewed_photo.py --lobbyist-id 958 --name "Chris Carpenter" \
        --source https://example.org/wp-content/uploads/Chris-Carpenter-Headshot.jpeg \
        --profile https://example.org/about/leadership/
"""
import argparse
import hashlib
import json
import re
import unicodedata
from pathlib import Path
from urllib.parse import urlparse

import requests
from fetch_capitol_club import HEADERS
from refresh_lobbyist_photos import MANIFEST, IMAGE_DIR, ROOT, thumbnail

MAX_BYTES = 8_000_000
PLACEHOLDER = re.compile(r'placeholder|default|no[-_]?image|blank|avatar|silhouette', re.I)


def fold(text):
    """Lower-case and strip accents, so Muñoz matches munoz in a URL."""
    stripped = unicodedata.normalize('NFKD', str(text or ''))
    return ''.join(c for c in stripped if not unicodedata.combining(c)).lower()


def attribution(name, source, profile_text):
    """Where the name was found, or None when nothing vouches for the portrait."""
    surname = fold(name).split()[-1]
    if surname and surname in fold(urlparse(source).path):
        return 'the image filename'
    if surname and fold(name) in fold(profile_text):
        return 'the profile page'
    return None


def fetch(session, url, referer=None):
    headers = {'Referer': referer} if referer else {}
    response = session.get(url, headers=headers, timeout=20, stream=True)
    response.raise_for_status()
    data = bytearray()
    for chunk in response.iter_content(65536):
        data.extend(chunk)
        if len(data) > MAX_BYTES:
            raise ValueError('Image exceeds download limit')
    response.close()
    return response, bytes(data)


def add(lobbyist_id, name, source, profile, session):
    if urlparse(source).scheme != 'https' or urlparse(profile).scheme != 'https':
        raise ValueError('Portrait and profile must both be https')
    if PLACEHOLDER.search(urlparse(source).path):
        raise ValueError('Source looks like a placeholder avatar')

    page = session.get(profile, timeout=20)
    page.raise_for_status()
    vouched = attribution(name, source, page.text)
    if not vouched:
        raise ValueError(f'Nothing on {profile} ties that image to {name}')

    response, data = fetch(session, source, referer=profile)
    if not response.headers.get('Content-Type', '').startswith('image/'):
        raise ValueError('Not an image response')
    jpg = thumbnail(data)

    key = f'lobbyist-{lobbyist_id}'
    filename = f'{key}-{hashlib.sha256(jpg).hexdigest()[:12]}.jpg'
    manifest = json.loads(MANIFEST.read_text())
    photos = manifest['photos']
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    (IMAGE_DIR / filename).write_bytes(jpg)
    # A lobbyist re-photographed leaves its old file behind otherwise; the
    # directory run only prunes its own user-* files.
    previous = photos.get(key, {}).get('path', '')
    if previous and Path(previous).name != filename:
        (ROOT / 'docs' / previous).unlink(missing_ok=True)
    photos[key] = {'name': name, 'path': f'assets/lobbyist-photos/{filename}',
                   'source': source, 'profile': profile}
    manifest['photos'] = dict(sorted(photos.items()))
    temporary = MANIFEST.with_suffix('.tmp')
    # Same escaping as the directory refresh writes, so the two callers do not
    # rewrite each other's accented names.
    temporary.write_text(json.dumps(manifest, indent=2) + '\n')
    temporary.replace(MANIFEST)
    print(f'{key}: {name} <- {source}')
    print(f'  vouched by {vouched}; {len(data):,} bytes in, {len(jpg):,} out')
    return photos[key]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--lobbyist-id', type=int, required=True)
    parser.add_argument('--name', required=True)
    parser.add_argument('--source', required=True, help='The portrait image URL')
    parser.add_argument('--profile', required=True, help='The page it appears on')
    args = parser.parse_args()
    session = requests.Session()
    session.headers.update(HEADERS)
    add(args.lobbyist_id, args.name, args.source, args.profile, session)


if __name__ == '__main__':
    main()
