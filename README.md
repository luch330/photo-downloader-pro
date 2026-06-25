# Photo Downloader Pro

A Wolt-inspired internal tool for downloading catalog images from an Excel file and packaging them into a ZIP archive.

## What it does

- Drag & drop or choose an Excel file (`.xlsx` or `.xls`)
- Treats the first row as the header row
- Reads:
  - column A: item name
  - column B: image URL
- Downloads images with multiple fallback methods:
  - `fetch` with headers
  - browser fallback with Playwright
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

1. regular fetch with browser-like headers
2. fetch with different referer candidates
3. browser fallback with Playwright

Some sites still block automated download. That is usually a partner-side protection issue, not an app bug.
