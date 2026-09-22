# Lobbyist portraits

The app and Excel exports use public, named portraits from the Oregon Capitol Club member directory: https://oregoncapitolclub.org/user/.

The Call list and Lobbyists sheets place an embedded photo beside the lobbyist's name. Firm rows show the designated primary contact's photo and name first, with the firm name beneath. A firm without a designated primary retains its firm name and a photo placeholder. The Contact photos sheet includes other firm members and profile source links. Donor groups remain collapsed, and financial calculations and source columns are unchanged.

Portraits match the lobbyist's Capitol Club ID. A manual contact without an ID can match only a unique exact full name or recorded alias. Missing or ambiguous matches display “Photo unavailable.” This is directory matching, not face recognition.

`refresh_lobbyist_photos.py` creates 160×200 JPEG thumbnails without cropping, strips embedded image metadata, and publishes a source manifest. The app serves these assets locally, and Excel embeds their bytes, so workbooks can display them offline. No database migration is required.

Run `python scraper/refresh_lobbyist_photos.py` with requests, BeautifulSoup, and Pillow installed. The Lobbyist Portraits workflow runs manually, and opens a PR for review. For a local retry, `--from-json` reuses the last directory snapshot and resumes successful image downloads checkpointed within the past day. Failed or rate-limited acquisitions do not replace the existing catalog. A small number of failed photos retain an existing same-name, same-ID portrait when available; missing ones remain placeholders. A directory must contain at least 100 unique members and at least 50 downloadable portraits, and no more than 10% of images may fail before a refresh is rejected.

Reference layout: https://docs.google.com/spreadsheets/d/1fl83AlfpSAXcBdUwOY-rgLjZ32w3I6lC08vq1Wu68M8/edit. The implementation adopts the portrait-beside-name placement while retaining the app's existing grouped export layout.

Initial coverage: 40 verified portraits from the 451-member directory. Capitol Club rate-limited acquisition on September 22, 2026; unmatched contacts retain the placeholder until a later successful refresh.
