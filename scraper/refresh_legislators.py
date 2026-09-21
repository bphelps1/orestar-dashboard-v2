"""Refresh the reviewed current-member asset from official chamber rosters.

Run weekly through the roster PR workflow, or manually before opening a PR.
Failures preserve the previous asset; no partial chamber roster is published.
"""
import json
import re
from datetime import date
from pathlib import Path

import requests
from bs4 import BeautifulSoup

SOURCES = {
    'house': 'https://www.oregonlegislature.gov/house/Pages/representativesall.aspx',
    'senate': 'https://www.oregonlegislature.gov/senate/Pages/senatorsall.aspx',
}
OUTPUT = Path(__file__).resolve().parents[1] / 'docs/assets/current_legislators.json'


def parse_members(html, chamber):
    prefix = 'Representative' if chamber == 'house' else 'Senator'
    names = []
    for heading in BeautifulSoup(html, 'html.parser').find_all('h3'):
        text = re.sub(r'[\u200b-\u200d\ufeff]', '', heading.get_text(' ', strip=True)).strip()
        match = re.match(rf'^{prefix}\s+(.+)$', text)
        if match:
            names.append(re.sub(r'\s+', ' ', match[1]).strip())
    maximum = 60 if chamber == 'house' else 30
    if not maximum - 5 <= len(names) <= maximum or len(set(names)) != len(names):
        raise ValueError(f'Unexpected {chamber} roster: {len(names)} members; refusing to replace asset')
    return sorted(names)


def main():
    members = {}
    for chamber, url in SOURCES.items():
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        members[chamber] = parse_members(response.text, chamber)
    previous = json.loads(OUTPUT.read_text()) if OUTPUT.exists() else {}
    if previous.get('members') == members:
        print('Current membership unchanged')
        return
    OUTPUT.write_text(json.dumps({'verified_on': date.today().isoformat(), 'sources': SOURCES,
                                  'members': members}, ensure_ascii=False, indent=2) + '\n')
    print('Updated complete House and Senate rosters; review the diff before merging')


if __name__ == '__main__':
    main()
