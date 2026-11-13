# E-WACS Survey Encoder

Upload scanned, handwritten E-WACS survey PDFs and get a CSV / Excel file back. No AI chat and no API keys; everything runs in the browser, and the PDFs are never uploaded anywhere.

1. Open the tool link and drop in the PDFs (one or many; a PDF can hold one or several surveys).
2. Click **Process PDFs**.
3. Click **Download CSV** (or Excel).

Optional: open **Check handwritten values** to fix anything the reader wasn't sure about. The downloads use your corrections.

How it reads the forms:
- **Checkboxes:** ink is measured in the parts of each box that are empty on a blank form.
- **Handwriting** (names, dates, counts, storage places): read by a small handwriting-recognition model (TrOCR) running on your computer. The model (~65 MB) downloads from Hugging Face the first time and is cached after that.
- **Counts:** cleaned to whole numbers. A dash means 0.
- **Storage places:** matched to House / Bodega / Cabinet / Garage / Outdoors when close.

Upload the downloaded CSV to Claude or Gemini for analysis. It's plain text, so it uses very little.

## What the Excel contains

| Sheet | One row per | Notes |
|---|---|---|
| Respondents | survey | Every question as a column. Multi-answer questions also get one 1/0 column per option (`s4_q2_incentive__1` …). Device counts appear as `smartphones_active`, `smartphones_broken`, `smartphones_where`, … |
| Devices | survey × device that has any value | Long format: `active_in_use`, `broken_in_storage`, `storage_location` |
| Review | issue | Missing pages, more than one tick on a single-answer question, unreadable values |

A dash written in a count cell becomes `0`. An empty cell stays empty. 

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

pdf.js renders each page. OpenCV.js (ORB features + homography) identifies which of the 5 form pages it is and lines it up with the template. Each field is then fine-aligned, checkboxes are scored by ink, and the blank form is subtracted from each handwriting field. Any field with leftover ink is cropped and read by TrOCR through transformers.js (WebGPU when available, otherwise WebAssembly).

Debug view: add `?debug=1` to the URL to see the aligned pages with the field boxes drawn.

## Limits / next steps

- The template (`templates/ewacs-v1.json`) was mapped from one filled sample, and the page 1–2 references are blank scans. A clean **blank scan of pages 3–5** would make the references cleaner.
- Tested on the sample and on a rotated, rescaled, blurred 150 dpi copy: every checkbox was either correct or sent to the AI as unsure. Spot-check the first real batch against the paper forms.
- A different questionnaire needs its own template JSON plus reference page images.

Third-party libraries (in `vendor/`): pdf.js, SheetJS Community Edition, OpenCV.js, transformers.js + ONNX Runtime Web (all Apache-2.0 / MIT). Model: microsoft/trocr-small-handwritten (ONNX export by Xenova).
