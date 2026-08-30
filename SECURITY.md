# Security policy

## Local-first design

The server binds to `127.0.0.1` only. Zotero, Obsidian files, extracted text,
PDF images, task history and credentials remain on the user's computer unless
the user explicitly sends paper content to a configured model provider.

## Credentials

- Never commit `.env`, `data/` or credential files.
- On Windows, keys saved from the UI are encrypted with the current user's
  Windows DPAPI account.
- On other operating systems, configure provider keys through environment
  variables until a native credential-store adapter is available.
- Every user must supply their own provider credentials and comply with the
  selected provider's terms.

## Research data

Do not include copyrighted PDFs, supplementary files, MinerU caches, extracted
figures, private Zotero exports or personal Obsidian vault content in bug
reports. Use a minimal anonymized fixture when reproducing an issue.

## Reporting a vulnerability

Do not open a public issue containing secrets or private research data. Contact
the repository maintainer privately through the security-reporting channel
configured on GitHub.
