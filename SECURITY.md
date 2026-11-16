# Security Policy

## Reporting a vulnerability

Report security issues privately — do not open a public issue.

- Telegram: [@AskKawaBot](https://t.me/AskKawaBot)

You will get a reply as soon as possible. A fix ships in the next release
when the report is confirmed.

## Scope notes

Folio is a fully offline app: it makes no network calls, has no accounts,
and stores notes as plain Markdown files next to the exe. The most
sensitive thing Folio handles is the content of your own notes on your
own machine.

Notes are **not encrypted** and there is no app lock: anyone who can
open the Folio folder can read every note. That is the deliberate
tradeoff of plain files you own — protect the folder itself if the
notes are private.

Reports that matter most:

- Any way for note content to be lost, corrupted, or overwritten silently
- Any way for a crafted note file or folder name to make the app read or
  write outside its own folder
- Any way for rendered Markdown in the preview to run script

## Verifying a download

Release executables are published on the
[Releases](https://github.com/iK4w4/Folio/releases) page with an MD5
checksum in the release notes. Compare it with the file you downloaded
before running it.
