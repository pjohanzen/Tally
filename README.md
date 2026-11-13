# E-WACS Survey Encoder

Turns scanned, handwritten E-WACS household survey PDFs into an Excel/CSV file, while sending as little as possible to Claude or Gemini.

- **Checkboxes** are read on your computer by the page itself. No AI is used for them.
- **Handwriting** (names, dates, barangay, device counts, storage locations) is cut out and packed into small "sheets". You paste those into Claude or Gemini, which reads only the handwriting.
- **Your PDFs never leave the browser.** Nothing is uploaded anywhere, GitHub included.

One survey becomes roughly a quarter of one sheet (about 400–500 tokens), instead of 5 full page images (about 12,000+ tokens).

## How to use (5 steps)

1. Open the tool link (GitHub Pages, see below) in Chrome or Edge.
2. **Step 1:** drop in the scanned PDFs (one or many; a PDF can hold one or several surveys) and click **Process PDFs**. It takes about 3 seconds per survey; you can switch tabs while it runs.
3. **Step 2:** click **Copy prompt** and paste it into a new Claude or Gemini chat. Then attach the sheet images, up to 10 per message (**Download all unread sheets**, then drag them in).
4. Copy each AI reply into the box and click **Apply reply**. Lines look like `12n|3`.
5. **Step 3:** fix anything listed under Review. **Step 4:** click **Download Excel** (or the CSVs).

For analysis, upload `ewacs-respondents-….csv` (and `ewacs-devices-….csv`) to Claude or Gemini. It's plain text, so it uses very little.

If you need to stop halfway, click **Save session**. Later, **Load session** continues where you left off. Large batches: process 50–100 PDFs at a time.

## What the Excel contains

| Sheet | One row per | Notes |
|---|---|---|
| Respondents | survey | Every question as a column. Multi-answer questions also get one 1/0 column per option (`s4_q2_incentive__1` …). Device counts appear as `smartphones_active`, `smartphones_broken`, `smartphones_where`, … |
| Devices | survey × device that has any value | Long format: `active_in_use`, `broken_in_storage`, `storage_location` |
| Review | issue | Missing pages, more than one tick on a single-answer question, unreadable values |

A dash written in a count cell becomes `0`. An empty cell stays empty. `PENDING` means the AI hasn't read that box yet.

## Host it on GitHub Pages (free)

1. Create a new **public** repository on GitHub, e.g. `ewacs-encoder` (GitHub Free only serves Pages from public repos; the site is public either way, but it holds no survey data).
2. Push this folder:
   ```bash
   git remote add origin https://github.com/<your-username>/ewacs-encoder.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)` → Save**.
4. After a minute the tool is live at `https://<your-username>.github.io/ewacs-encoder/`. Share that link with your teammate.

**Never commit survey PDFs or exported files.** `.gitignore` already blocks `*.pdf`, `*.xlsx`, `*.csv` and session files.

To run it locally instead: `python3 -m http.server` in this folder, then open http://localhost:8000. Double-clicking `index.html` won't work, because browsers block it from loading its own files.

## How it works

1. **Render and identify:** pdf.js renders each page. OpenCV.js (ORB features + RANSAC homography) works out which of the 5 form pages it is and lines it up with the template, which handles skew, shifts and different scan resolutions.
2. **Local alignment:** each field is fine-aligned against nearby printed text, because paper often curls in the scanner.
3. **Checkboxes:** ink is counted in the areas that are always empty on a blank form: inside the `[ ]`, the gap after `]`, and the strip above the option text. Clear ticks are recorded directly. Borderline ones are sent to the AI sheet as `…c` items.
4. **Handwriting:** the blank form is subtracted from each field. If anything is left, it is cropped tightly and added to a sheet.

Debug view: add `?debug=1` to the URL to see each aligned page with the field boxes drawn (green = ticked, orange = unsure, blue = handwriting found).

## Limits / next steps

- The template (`templates/ewacs-v1.json`) was mapped from one filled sample, and the page 1–2 references are blank scans. A clean **blank scan of pages 3–5** would make the references cleaner.
- Tested on the sample and on a rotated, rescaled, blurred 150 dpi copy: every checkbox was either correct or sent to the AI as unsure. Spot-check the first real batch against the paper forms.
- A different questionnaire needs its own template JSON plus reference page images.

Third-party libraries (in `vendor/`): pdf.js (Apache-2.0), SheetJS Community Edition (Apache-2.0), OpenCV.js (Apache-2.0).
