# Tally

Scanned survey forms in, spreadsheet out. Currently set up for the **E-WACS Household Survey** (Bacolod City).

**Open the tool:** https://pjohanzen.github.io/pdf-tool/

- **Checkboxes:** read on your own computer. No AI is used for them.
- **Handwriting:** only small cut-outs of the handwritten boxes go to the AI you choose (Claude or Gemini, on your own subscription), never whole pages.
- **Your PDFs:** stay in your browser. Nothing is uploaded to GitHub or anywhere else.
- **Usage:** roughly 10–15× less than uploading the PDFs to a chat.

---

## Setup (once per computer)

Pick one reader: **Claude** if you have Claude Pro/Max, **Gemini** if you have Google AI Pro/Ultra. You only need one of them.

### Step 1: Install Node.js (everyone)

The small helper that connects Tally to your AI runs on Node.js.

1. Check whether you already have it. Open **Terminal** (Mac) or **PowerShell** (Windows) and run:
   ```
   node -v
   ```
   A version of `v18` or higher means you're done with this step.
2. If not, install the **LTS** version from https://nodejs.org. On a Mac with Homebrew you can run `brew install node` instead. Then close and reopen Terminal/PowerShell.

### Step 2a: If you use Claude

1. Install Claude Code by following https://code.claude.com.
2. In Terminal/PowerShell, run:
   ```
   claude
   ```
   Log in with **the Claude account that has your Pro or Max plan**, then type `/exit` to quit.

### Step 2b: If you use Gemini

Gemini is reached through **Antigravity CLI**, Google's replacement for Gemini CLI. The old Gemini CLI no longer accepts personal accounts.

1. Install it.
   - **Mac:**
     ```
     curl -fsSL https://antigravity.google/cli/install.sh | bash
     ```
   - **Windows (PowerShell):**
     ```
     irm https://antigravity.google/cli/install.ps1 | iex
     ```
   Then close and reopen Terminal/PowerShell.
2. Run:
   ```
   agy
   ```
   Sign in with **the Google account that has your Google AI Pro or Ultra plan**, then exit.

### Step 3: Check it works

1. Open https://pjohanzen.github.io/pdf-tool/ in Chrome or Edge.
2. Under **Read the handwriting with**, tick **Claude** or **Gemini**.
3. In the **Helper on this computer** box, click **Copy**, paste it into Terminal/PowerShell, and press Enter. The window should list your AI as **found**.
4. The first time, the browser may ask to let the site access **devices on your local network**. Click **Allow**, because that's how the page reaches the helper.
5. The status in the tool turns green: **Running, Claude Code found** or **Running, Gemini (agy) found**.

Setup is done.

---

## Using Tally (every batch)

1. **Start the helper.** Open Tally, click **Copy** in the helper box, paste it into Terminal/PowerShell, and press Enter. Leave that window open until you're finished. (Not needed for **Offline**.)
2. **Add scans.** Drop in PDFs, **ZIP files** (folders inside are fine) or a **whole folder**, or use the **Choose** buttons. Other file types are skipped.
3. **Optional: Known names.** List the barangays/puroks and surveyor names, one per line. Readings are matched to these exact spellings, numbers are never changed (Barangay 12 stays 12), and anything that doesn't match is flagged.
4. **Optional: Model.** Choose which model reads the handwriting. **Default** is fine for most batches.
5. Click **Process PDFs**. About 3 seconds per survey to read the pages, plus the AI time.
6. Click **Download CSV** (or **Download Excel**).
7. **Optional: Check handwritten values.** Anything the AI was unsure about, or that failed a check (a count that isn't a number, a date that isn't a date, a name not on your list), is shown next to the handwriting. Your fixes go straight into the downloads.

Tips:
- **Big batches:** 50–100 PDFs at a time is comfortable. 500 works too: about 30 minutes for the pages, plus AI time.
- **If it stops partway** (usage limit, no internet, laptop slept), click **Read remaining handwriting**. Nothing is lost, and the PDFs aren't read again.
- **Respondent IDs** are the PDF's path (e.g. `BrgyA/day1/s01`), with `#2`, `#3`… when one PDF holds several surveys.
- **For analysis**, upload the downloaded CSV to Claude or Gemini. It's plain text, so it uses very little.
- **Don't close the tab** before downloading. Results live only in that tab.

---

## Troubleshooting

| What you see | What to do |
|---|---|
| **Helper not running** | Click **Copy**, paste into Terminal/PowerShell, press Enter, keep the window open, then click **Check again**. |
| **Running, but Claude Code / Gemini (agy) not found** | Finish Step 2a or 2b, close and reopen Terminal/PowerShell, then run the Copy command again. |
| `node: command not found` | Do Step 1, then reopen Terminal/PowerShell. |
| Helper says **already running on port 8787** | One is already open in another window; use that one or close it. |
| Gemini error **"This client is no longer supported…"** | That's the old Gemini CLI. Install Antigravity CLI (Step 2b). |
| **Usage limit reached** | Wait for your plan's limit to reset, then click **Read remaining handwriting**. |
| Page still shows an old version | Press **Cmd+Shift+R** (Mac) or **Ctrl+Shift+R** (Windows). The version number is at the top right. |
| A PDF is listed as **could not open** or **no E-WACS survey found** | Re-scan it; that file is listed in the Review sheet. |

---

## What the Excel contains

| Sheet | One row per | Notes |
|---|---|---|
| Respondents | survey | Every question as a column. Multi-answer questions also get one 1/0 column per option (`s4_q2_incentive__1` …). Device counts appear as `smartphones_active`, `smartphones_broken`, `smartphones_where`, … |
| Devices | survey × device that has any value | Long format: `active_in_use`, `broken_in_storage`, `storage_location` |
| Review | issue | Missing pages, more than one tick on a single-answer question, unreadable values, PDFs that couldn't be read |

A dash written in a count cell becomes `0`. An empty cell stays empty.

---

## Privacy and accounts

- **Subscription only:** the helper only uses your subscription login. It removes `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` and `GOOGLE_API_KEY` from its environment, so nothing is billed to an API account.
- **Who can reach it:** the helper accepts requests only from github.io pages and from this computer.
- **What it sends:** only the handwriting cut-out images go to your AI, and they're deleted after each batch.
- **Advanced model choice:** set `EWACS_CLAUDE_MODEL` (e.g. `sonnet`) or `EWACS_GEMINI_MODEL` (a name from `agy models`) before starting the helper to force a model. The **Model** menu in the page does the same thing.

---

## For maintainers

### Publishing changes (GitHub Pages)

The site is served from the `main` branch of `pjohanzen/pdf-tool` (Settings → Pages → Deploy from a branch → `main` / root).

```bash
git add . && git commit -m "Describe the change" && git push
```

- **Version bump:** change the version in `app.js` (`APP_VERSION`) and in `index.html` (the `?v=` on the CSS and JS links, and the version label) whenever you change code. Otherwise browsers keep the old copy for up to 10 minutes.
- **Survey data:** never commit survey PDFs or exported files. `.gitignore` already blocks `*.pdf`, `*.xlsx`, `*.csv` and session files.
- **Free accounts:** GitHub Free only serves Pages from **public** repos. The repo holds no survey data, so that's fine.

To run it locally instead: `python3 -m http.server` in this folder, then open http://localhost:8000. Double-clicking `index.html` doesn't work, because browsers block it from loading its own files.

### How it works

1. **Read the pages:** pdf.js renders each page.
2. **Line up with the template:** OpenCV.js (ORB features + homography) works out which of the 5 form pages it is and lines it up with the template, then each field is fine-aligned.
3. **Checkboxes:** ink is counted in the parts of each box that are always empty on a blank form.
4. **Handwriting:** the blank form is subtracted from each field, and fields with leftover ink are cropped and packed into labelled sheets.
5. **AI reading:** the sheets go to `ai-helper.mjs`, which runs `claude -p` (Claude Code) or `agy -p` (Antigravity CLI) and returns structured JSON. Offline mode uses TrOCR via transformers.js instead.
6. **Checks:** values are validated (numbers, dates, known names) and anything doubtful is flagged.

Debug view: add `?debug=1` to the URL to see the aligned pages with the field boxes drawn.

### Limits

- **Template:** `templates/ewacs-v1.json` was mapped from one filled sample. A clean **blank scan of pages 3–5** would make the checkbox references cleaner.
- **Testing:** tested on the sample, a rotated/rescaled/blurred 150 dpi copy, a 60-PDF ZIP (≈3.5 min, ~100 MB memory) and a messy batch (nested folders, corrupt PDF, unrelated PDF, missing pages, two surveys in one PDF). Spot-check the first real batch against the paper forms.
- **Other forms:** a different questionnaire needs its own template JSON plus reference page images.

Third-party code in `vendor/`: pdf.js, SheetJS Community Edition, OpenCV.js, fflate, transformers.js + ONNX Runtime Web, Public Sans font (Apache-2.0 / MIT / OFL). Offline model: microsoft/trocr-small-handwritten (ONNX export by Xenova).
