import io
import sys
from pathlib import Path
from bs4 import BeautifulSoup
from PIL import Image
sys.path.insert(0,str(Path(__file__).parents[1]/'scraper'))
from fetch_capitol_club import parse_profile
from refresh_lobbyist_photos import allowed_photo, thumbnail, refresh
import pytest


def test_named_photo_source_is_scraped_without_changing_contacts():
    p=BeautifulSoup('<div class="user-profile" id="user-123"><h1 class="profile-title"><a href="https://oregoncapitolclub.org/user/?search=Jane">Jane Example</a></h1><img class="photo" src="https://oregoncapitolclub.org/wp-content/uploads/2026/jane.jpg" alt="Photo of Jane Example"></div>','html.parser').div
    r=parse_profile(p)
    assert r['cc_id']=='user-123'
    assert r['photo_url'].endswith('/jane.jpg')
    assert r['profile_url'].endswith('search=Jane')
    assert r['name']=='Jane Example'


def test_source_allowlist_rejects_external_and_placeholder_images():
    assert allowed_photo('https://oregoncapitolclub.org/wp-content/uploads/2026/jane.jpg')
    for url in ['http://oregoncapitolclub.org/wp-content/uploads/a.jpg','https://evil.example/a.jpg','https://oregoncapitolclub.org.evil.example/wp-content/uploads/a.jpg','https://oregoncapitolclub.org/wp-content/uploads/default-avatar.png']:
        assert not allowed_photo(url)


def test_thumbnail_preserves_entire_portrait_and_has_fixed_excel_canvas():
    source=Image.new('RGB',(400,400),'red');b=io.BytesIO();source.save(b,format='PNG')
    result=Image.open(io.BytesIO(thumbnail(b.getvalue())))
    assert result.size==(160,200)
    assert result.getpixel((80,0))==(255,255,255)
    assert result.getpixel((80,100))[0]>240


def test_partial_directory_never_replaces_catalog():
    with pytest.raises(ValueError,match='Incomplete'):refresh([],None)


def test_rate_limit_stops_requests_and_preserves_published_catalog(tmp_path, monkeypatch):
    import refresh_lobbyist_photos as module
    catalog = tmp_path / 'docs/assets/lobbyist-photos.json'
    catalog.parent.mkdir(parents=True)
    catalog.write_text('{"version":1,"photos":{}}')
    original = catalog.read_bytes()
    monkeypatch.setattr(module, 'ROOT', tmp_path)
    monkeypatch.setattr(module, 'MANIFEST', catalog)
    monkeypatch.setattr(module, 'IMAGE_DIR', catalog.parent / 'lobbyist-photos')
    class Response:
        status_code = 429
        headers = {'Retry-After': '3600'}
        closed = False
        def close(self): self.closed = True
    response = Response()
    class Session:
        calls = 0
        def get(self, *args, **kwargs):
            self.calls += 1
            return response
    session = Session()
    members = [{'cc_id': f'user-{i}', 'name': f'Contact {i}',
                'photo_url': 'https://oregoncapitolclub.org/wp-content/uploads/contact.jpg'} for i in range(100)]
    with pytest.raises(RuntimeError, match='Retry-After: 3600'):
        module.refresh(members, session)
    assert session.calls == 1
    assert response.closed
    assert catalog.read_bytes() == original


def test_successful_directory_refresh_preserves_reviewed_official_site_portraits(tmp_path, monkeypatch):
    import json
    import refresh_lobbyist_photos as module
    image_dir = tmp_path / 'docs/assets/lobbyist-photos'
    image_dir.mkdir(parents=True)
    (tmp_path / 'data').mkdir()
    catalog = image_dir.parent / 'lobbyist-photos.json'
    official = {'name': 'Reviewed Contact', 'path': 'assets/lobbyist-photos/lobbyist-42-123456abcdef.jpg',
                'source': 'https://official.example/contact.jpg', 'profile': 'https://official.example/team'}
    (tmp_path / 'docs' / official['path']).write_bytes(b'reviewed-file')
    catalog.write_text(json.dumps({'version': 1, 'photos': {'lobbyist-42': official}}))
    monkeypatch.setattr(module, 'ROOT', tmp_path)
    monkeypatch.setattr(module, 'MANIFEST', catalog)
    monkeypatch.setattr(module, 'IMAGE_DIR', image_dir)
    monkeypatch.setattr(module.time, 'sleep', lambda seconds: None)
    image = Image.new('RGB', (2, 2), 'blue'); content = io.BytesIO(); image.save(content, format='PNG')
    class Response:
        status_code = 200
        headers = {'Content-Type': 'image/png'}
        def raise_for_status(self): pass
        def iter_content(self, size): yield content.getvalue()
        def close(self): pass
    class Session:
        def get(self, *args, **kwargs): return Response()
    members = [{'cc_id': f'user-{i}', 'name': f'Contact {i}',
                'photo_url': 'https://oregoncapitolclub.org/wp-content/uploads/contact.png'} for i in range(100)]
    module.refresh(members, Session())
    saved = json.loads(catalog.read_text())['photos']
    assert saved['lobbyist-42'] == official
    assert len(saved) == 101
    assert (tmp_path / 'docs' / official['path']).read_bytes() == b'reviewed-file'


def test_large_camera_jpeg_is_decoder_downsampled_and_exif_orientation_preserved():
    source = Image.new('RGB', (6000, 4500), 'red')
    exif = Image.Exif(); exif[274] = 6  # rotate the landscape camera buffer upright
    content = io.BytesIO(); source.save(content, format='JPEG', exif=exif)
    source.close()
    with pytest.warns(Image.DecompressionBombWarning):
        result = Image.open(io.BytesIO(thumbnail(content.getvalue())))
    assert result.size == (160, 200)
    assert min(result.getpixel((0, 100))) > 245  # upright portrait has white side padding
    assert result.getpixel((80, 100))[0] > 240
