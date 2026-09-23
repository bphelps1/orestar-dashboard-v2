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


# ── Individually reviewed portraits from official sites ────────────────────
#
# The Capitol Club lists plenty of in-house association staff with the
# placeholder avatar and no photo of their own. Those portraits come from the
# organization's own staff page, keyed lobbyist-<id> rather than user-<id>.

def _reviewed(tmp_path, monkeypatch):
    import add_reviewed_photo as module
    import refresh_lobbyist_photos as refresh_module
    manifest = tmp_path / 'docs/assets/lobbyist-photos.json'
    manifest.parent.mkdir(parents=True)
    manifest.write_text('{"version":1,"photos":{}}')
    for target in (module, refresh_module):
        monkeypatch.setattr(target, 'ROOT', tmp_path, raising=False)
        monkeypatch.setattr(target, 'MANIFEST', manifest, raising=False)
        monkeypatch.setattr(target, 'IMAGE_DIR', manifest.parent / 'lobbyist-photos', raising=False)
    return module, manifest


class _Session:
    """A staff page and its portrait, enough for one add()."""
    def __init__(self, page_text, image=None):
        self.text_response = page_text
        source = Image.new('RGB', (400, 500), 'red')
        buffer = io.BytesIO()
        source.save(buffer, format='JPEG')
        self.image = image if image is not None else buffer.getvalue()

    def get(self, url, headers=None, timeout=None, stream=False):
        return _Response(self.image if stream else self.text_response, stream)


class _Response:
    def __init__(self, payload, stream):
        self.headers = {'Content-Type': 'image/jpeg' if stream else 'text/html'}
        self._payload = payload
        self.text = payload if isinstance(payload, str) else ''
    def raise_for_status(self): pass
    def iter_content(self, size): yield self._payload
    def close(self): pass


def test_reviewed_portrait_is_keyed_by_lobbyist_and_sized_like_the_rest(tmp_path, monkeypatch):
    module, manifest = _reviewed(tmp_path, monkeypatch)
    entry = module.add(958, 'Chris Carpenter',
                       'https://example.org/uploads/Chris-Carpenter-Headshot.jpeg',
                       'https://example.org/about/leadership/', _Session('<p>staff</p>'))
    assert entry['path'].startswith('assets/lobbyist-photos/lobbyist-958-')
    saved = tmp_path / 'docs' / entry['path']
    assert Image.open(saved).size == (160, 200)
    # The same shape refresh() preserves, and the file it checks for.
    photos = __import__('json').loads(manifest.read_text())['photos']
    assert set(photos) == {'lobbyist-958'}
    assert photos['lobbyist-958']['source'].endswith('Headshot.jpeg')


def test_a_portrait_nothing_ties_to_the_person_is_refused(tmp_path, monkeypatch):
    module, _ = _reviewed(tmp_path, monkeypatch)
    with pytest.raises(ValueError, match='Nothing on'):
        module.add(958, 'Chris Carpenter', 'https://example.org/uploads/headshot-2026.jpeg',
                   'https://example.org/about/leadership/', _Session('<p>somebody else</p>'))


def test_the_surname_may_be_vouched_for_by_the_profile_page(tmp_path, monkeypatch):
    module, _ = _reviewed(tmp_path, monkeypatch)
    entry = module.add(509, 'Cynthia Branger Muñoz', 'https://example.org/uploads/staff-17.jpeg',
                       'https://example.org/staff/', _Session('<p>Cynthia Branger Muñoz</p>'))
    assert entry['name'] == 'Cynthia Branger Muñoz'
    # Accents differ between a URL and a page; matching folds them away.
    assert module.attribution('Cynthia Branger Muñoz',
                              'https://example.org/uploads/branger-munoz.jpg', '') == 'the image filename'


def test_placeholder_avatars_and_plain_http_are_refused(tmp_path, monkeypatch):
    module, _ = _reviewed(tmp_path, monkeypatch)
    for source, complaint in [
            ('https://example.org/uploads/img_placeholder_avatar.jpg', 'placeholder'),
            ('http://example.org/uploads/Chris-Carpenter.jpg', 'https')]:
        with pytest.raises(ValueError, match=complaint):
            module.add(958, 'Chris Carpenter', source,
                       'https://example.org/about/leadership/', _Session('<p>staff</p>'))


def test_replacing_a_portrait_removes_the_file_it_supersedes(tmp_path, monkeypatch):
    module, _ = _reviewed(tmp_path, monkeypatch)
    page = '<p>staff</p>'
    first = module.add(958, 'Chris Carpenter', 'https://example.org/uploads/Carpenter.jpeg',
                       'https://example.org/about/leadership/', _Session(page))
    other = Image.new('RGB', (400, 500), 'blue')
    buffer = io.BytesIO()
    other.save(buffer, format='JPEG')
    second = module.add(958, 'Chris Carpenter', 'https://example.org/uploads/Carpenter-2027.jpeg',
                        'https://example.org/about/leadership/', _Session(page, buffer.getvalue()))
    assert first['path'] != second['path']
    assert not (tmp_path / 'docs' / first['path']).exists()
    assert (tmp_path / 'docs' / second['path']).exists()
