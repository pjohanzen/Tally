# E-WACS Survey Encoder

Upload scanned, handwritten E-WACS survey PDFs and get a CSV / Excel file back.

- **Checkboxes:** read on your computer. No AI is used.
- **Handwriting:** only small cut-outs of the handwritten boxes are sent to the AI you pick, never whole pages.
- **Usage:** roughly 10–15× less than uploading the PDFs to a chat.

## Pick how handwriting is read

| Option | Who it's for | Setup |
|---|---|---|
| **Claude** | Claude Pro/Max subscribers | Claude Code installed and logged in, plus the helper running (below) |
| **Gemini** | Anyone | A free API key from https://aistudio.google.com/apikey, pasted into the tool once |
| **Offline** | No AI at all | Nothing. Much less accurate; names and some digits will be wrong |

The choice and the Gemini key are saved in each person's own browser.

### Claude setup (once per computer)

1. Install Claude Code (https://code.claude.com) and run `claude` once in Terminal to log in with your Claude account.
2. Every time you process a batch, open Terminal and run:
   ```bash
   cd path/to/this/folder
   node claude-helper.mjs
   ```
   Leave that window open. The tool shows "Helper running" when it can see it. You can also download `claude-helper.mjs` from the tool page.
3. The first time, Chrome may ask to allow the site to access "devices on your local network". Click **Allow**, because that's how the page talks to the helper.

The helper only accepts requests from github.io pages and localhost. It runs `claude -p` on your subscription (it removes any `ANTHROPIC_API_KEY`, so nothing is billed to an API account), and it deletes the temporary sheet images after each batch. Set `EWACS_MODEL=sonnet` (or another model) before `node claude-helper.mjs` to choose the model.

## How to use

1. Open https://pjohanzen.github.io/pdf-tool/ and choose Claude, Gemini or Offline.
2. Optional: under **Known names**, list the barangays/puroks and surveyor names. Readings are matched to these spellings, and anything that doesn't match is flagged.
3. Drop in the PDFs and click **Process PDFs**.
4. Click **Download CSV** (or Excel).
5. Optional: open **Check handwritten values**. Anything the AI marked as unsure, or that failed a check (a count that isn't a number, a date that isn't a date, a name not on your list), is listed next to its cut-out. Fixes go into the downloads.

If processing stops partway (for example a usage limit or no internet), click **Read remaining handwriting** to continue without re-reading the PDFs.

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
- Tested on the sample and on a rotated, rescaled, blurred 150 dpi copy: every checkbox was correct or flagged for checking. Handwriting recognition is the weakest part (names and messy writing especially), so spot-check the first real batch against the paper forms.
- A different questionnaire needs its own template JSON plus reference page images.

Third-party libraries (in `vendor/`): pdf.js, SheetJS Community Edition, OpenCV.js, transformers.js + ONNX Runtime Web (all Apache-2.0 / MIT). Model: microsoft/trocr-small-handwritten (ONNX export by Xenova).
