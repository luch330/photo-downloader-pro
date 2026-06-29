# PicCatch

An internal tool for downloading catalog images from an Excel file, normalizing them, and packaging the results into a ZIP archive.

## What it does

- Drag & drop or choose an Excel file (`.xlsx` or `.xls`)
- Treats the first row as the header row
- Auto-detects the item-name and image-URL columns
- Downloads images with multiple fallback methods:
  - HTTP/2 and HTTP/1.1 with keep-alive
  - browser-like header and fingerprint rotation
  - redirect and cookie-aware retries
  - optional Playwright browser fallback
- Recovers images from HTML pages using `img`, `picture`, `srcset`, lazy-load attributes, social image metadata, JSON-LD, and CSS background images
- Uses an optional Partner Page URL as the `Referer`
- Produces a ZIP file with:
  - all successful images
  - `report.txt`
  - `failed_rows.csv`
- Shows live progress, ETA, logs, preview, and summary cards

## Requirements

- Node.js 20+
- npm
- Internet access for installing dependencies and Playwright Chromium

## Install

```bash
npm install
```

The `postinstall` script will download Playwright Chromium automatically.

## Run

```bash
npm start
```

Then open:

```text
http://127.0.0.1:3000
```

## Mac shortcuts

- `install.command` installs dependencies
- `start.command` installs if needed and starts the app

## Excel format

The first row is always treated as the header and is skipped.

Example:

| Item name | Image URL |
|---|---|
| Coca Cola | https://example.com/image1.jpg |
| Pepsi | https://example.com/image2.png |

## Notes

If a partner site blocks direct requests with `403`, the app tries:

1. direct image requests with realistic browser headers
2. no-Referer and same-origin Referer variants
3. alternate browser fingerprints
4. HEAD preflight followed by GET
5. HTTP/2 and HTTP/1.1 fallback
6. optional browser fallback with Playwright

Failures include diagnostics with HTTP status, content type, final URL, redirect chain, response headers, response size, retry strategy, elapsed time, browser profile, protocol, cookie count, and an HTML preview when HTML is returned.
