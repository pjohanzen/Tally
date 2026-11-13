# Tally

Scanned survey forms in, spreadsheet out. Currently set up for the **E-WACS Household Survey** (Bacolod City).

Upload scanned, handwritten survey PDFs and get a CSV / Excel file back.

- **Checkboxes:** read on your computer. No AI is used.
- **Handwriting:** only small cut-outs of the handwritten boxes are sent to the AI you pick (Claude or Gemini, on your own subscription), never whole pages.
- **Usage:** roughly 10–15× less than uploading the PDFs to a chat.

## Pick how handwriting is read

| Option | Uses | One-time setup |
|---|---|---|
| **Claude** | Your Claude Pro/Max subscription | Install Claude Code (https://code.claude.com), run `claude` once and log in with your Claude account |
| **Gemini** | Your Google AI Pro/Ultra subscription | Install Antigravity CLI (Google's replacement for Gemini CLI for personal accounts): Mac `curl -fsSL https://antigravity.google/cli/install.sh \| bash`, Windows PowerShell `irm https://antigravity.google/cli/install.ps1 \| iex`. Then run `agy` once and sign in with the Google account that has the subscription |
| **Offline** | Nothing | None. Much less accurate; names and some digits will be wrong |

Requires Node.js 18+ for the helper itself. No API keys are used: the helper removes `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` from the environment so usage always comes from the subscription login. Each person's choice is saved in their own browser.

### Each time you process a batch

The tool shows a ready-made command with a **Copy** button. Paste it into Terminal (Mac) or PowerShell (Windows), press Enter, and leave the window open. It downloads the latest `ai-helper.mjs` from the tool site and starts it. The status in the tool turns green ("Helper running · Claude Code found" or "… Gemini (agy) found").

- The first time, the browser may ask to let the site access "devices on your local network". Click **Allow**, because that's how the page talks to the helper.
- The helper only accepts requests from github.io pages and localhost, sends only the handwriting sheet images to the AI, and deletes them after each batch.
- To choose a model, set `EWACS_CLAUDE_MODEL` (e.g. `sonnet`) or `EWACS_GEMINI_MODEL` (a slug from `agy models`) before starting the helper. By default the helper picks the newest Gemini Flash model and low effort for speed.

## How to use

1. Open https://pjohanzen.github.io/pdf-tool/, choose Claude, Gemini or Offline, and (for Claude/Gemini) start the helper with the copied command.
2. Optional: under **Known names**, list the barangays/puroks and surveyor names. Readings are matched to these spellings, and anything that doesn't match is flagged.
3. Add the scans: drop in PDFs, **ZIP files** (folders inside the ZIP are fine) or a **whole folder**, or use **Choose PDFs or ZIPs** / **Choose a folder**. Non-PDF files are skipped. Then click **Process PDFs**. Each respondent ID is the PDF's path (e.g. `BrgyA/day1/s01`), with `#2`, `#3`… when one PDF holds several surveys.
4. Click **Download CSV** (or Excel).
5. Optional: open **Check handwritten values**. Anything the AI marked as unsure, or that failed a check (a count that isn't a number, a date that isn't a date, a name not on your list), is listed next to its cut-out. Fixes go into the downloads.

PDFs that can't be opened or don't contain this form are listed in the Review sheet. If processing stops partway (for example a usage limit or no internet), click **Read remaining handwriting** to continue without re-reading the PDFs.

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
- Tested on the sample, a rotated/rescaled/blurred 150 dpi copy, a 60-PDF ZIP (≈3.5 min, ~100 MB memory) and a messy batch (nested folders, corrupt PDF, unrelated PDF, missing pages, two surveys in one PDF): every checkbox was correct or flagged for checking. Handwriting recognition is the weakest part (names and messy writing especially), so spot-check the first real batch against the paper forms.
- A different questionnaire needs its own template JSON plus reference page images.

Third-party libraries (in `vendor/`): pdf.js, SheetJS Community Edition, OpenCV.js, transformers.js + ONNX Runtime Web (all Apache-2.0 / MIT). Model: microsoft/trocr-small-handwritten (ONNX export by Xenova).
