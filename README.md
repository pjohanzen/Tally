# Tally

Scanned survey forms in, spreadsheet out. Currently set up for the **E-WACS Household Survey** (Bacolod City).

**Open the tool:** https://pjohanzen.github.io/Tally/
**Repository:** https://github.com/pjohanzen/Tally

- **Checkboxes:** read on your own computer. No AI is used for them.
- **Handwriting:** only small cut-outs of the handwritten boxes go to the AI you choose (Claude or Gemini, on your own subscription), never whole pages.
- **Your PDFs:** stay in your browser. Nothing is uploaded to GitHub or anywhere else.
- **Usage:** roughly 10–15× less than uploading the PDFs to a chat.

---

## Requirements

| You need | Why |
|---|---|
| Google Chrome or Microsoft Edge (tested in Chrome) | Runs the tool |
| **Node.js 18 or newer** | Runs the small helper that connects Tally to your AI |
| **One** AI subscription: Claude Pro/Max **or** Google AI Pro/Ultra | Reads the handwriting. Not needed for Offline mode, which is much less accurate. |
| Windows 10 (1809+) / 11, macOS 13+, or Linux (Ubuntu 20.04+, Debian 10+, Fedora/RHEL, Alpine) | What Claude Code supports; Antigravity CLI runs on Windows, macOS and Linux |

Where to type the commands below:
- **Windows:** open **PowerShell** (Start menu → type "PowerShell"). The prompt starts with `PS C:\`.
- **macOS:** open **Terminal** (Spotlight → type "Terminal").
- **Linux:** open your **Terminal** app.

---

## Setup (once per computer)

### Step 1: Install Node.js

First check whether you already have it:
```
node -v
```
A version of `v18` or higher means you can skip to Step 2.

**Windows (PowerShell):**
```powershell
winget install OpenJS.NodeJS.LTS
```

**macOS:** with [Homebrew](https://brew.sh):
```bash
brew install node
```
No Homebrew? Download the macOS installer (`.pkg`, **LTS**) from https://nodejs.org/en/download and run it.

**Linux, Ubuntu / Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Linux, Fedora:**
```bash
sudo dnf install nodejs
```

**Linux, Arch:**
```bash
sudo pacman -S nodejs npm
```

Then **close and reopen** PowerShell/Terminal and run `node -v` again to confirm.

### Step 2a: If you use Claude

Your Claude account must be on **Pro or Max**. The free plan doesn't include Claude Code.

1. Install Claude Code.

   **Windows (PowerShell):**
   ```powershell
   irm https://claude.ai/install.ps1 | iex
   ```

   **macOS and Linux:**
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```

2. Close and reopen PowerShell/Terminal, then check it installed:
   ```
   claude --version
   ```

3. Log in once:
   ```
   claude
   ```
   Follow the browser prompt and sign in with **the Claude account that has your Pro or Max plan**. When it's done, type `/exit`.

### Step 2b: If you use Gemini

Your Google account must be on **Google AI Pro or Ultra**. Gemini is reached through **Antigravity CLI** (`agy`), which replaced Gemini CLI for personal accounts. The old `gemini` command no longer accepts personal sign-ins.

1. Install Antigravity CLI.

   **Windows (PowerShell):**
   ```powershell
   irm https://antigravity.google/cli/install.ps1 | iex
   ```

   **macOS and Linux:**
   ```bash
   curl -fsSL https://antigravity.google/cli/install.sh | bash
   ```

2. Close and reopen PowerShell/Terminal, then sign in once:
   ```
   agy
   ```
   Sign in with **the Google account that has your Google AI Pro or Ultra plan**, then exit.

### Step 3: Connect Tally to your AI

1. Open https://pjohanzen.github.io/Tally/.
2. Under **Read the handwriting with**, tick **Claude** or **Gemini**.
3. In the **Helper on this computer** box, click **Copy**. The command is already set for your system:
   - **Windows:** `irm … -OutFile $HOME\tally-helper.mjs; node $HOME\tally-helper.mjs`
   - **macOS / Linux:** `curl -fsSL … -o ~/tally-helper.mjs && node ~/tally-helper.mjs`
4. Paste it into PowerShell/Terminal and press Enter. The window should say your AI was **found**.
5. The first time, the browser may ask to let the site access **devices on your local network**. Click **Allow**, because that's how the page reaches the helper.
6. The status in Tally turns green: **Running, Claude Code found** or **Running, Gemini (agy) found**.

Setup is done.

---

## Using Tally (every batch)

1. **Start the helper.** Open Tally, click **Copy** in the helper box, paste it into PowerShell/Terminal, and press Enter. Keep that window open until you're finished. (Not needed for **Offline**.)
2. **Check the form.** Step 1 shows which survey form Tally expects. Pick another one if needed.
3. **Add scans.** Drop in PDFs, **ZIP files** (folders inside are fine) or a **whole folder**, or use the **Choose** buttons. Other file types are skipped.
4. **Optional: Known names.** List the barangays/puroks and surveyor names, one per line. Readings are matched to these exact spellings, numbers are never changed (Barangay 12 stays 12), and anything that doesn't match is flagged.
5. **Optional: Model.** Choose which model reads the handwriting. **Default** is fine for most batches.
6. Click **Process PDFs**. About 3 seconds per survey to read the pages, plus the AI time.
7. Click **Download CSV** (or **Download Excel**).
8. **Optional: Check handwritten values.** Anything the AI was unsure about, or that failed a check (a count that isn't a number, a date that isn't a date, a name not on your list), is shown next to the handwriting. Your fixes go straight into the downloads.

To stop the helper when you're done, click its window and press **Ctrl+C**.

Tips:
- **Big batches:** 50–100 PDFs at a time is comfortable. 500 works too: about 30 minutes for the pages, plus AI time.
- **If it stops partway** (usage limit, no internet, laptop slept), click **Read remaining handwriting**. Nothing is lost, and the PDFs aren't read again.
- **Respondent IDs** are the PDF's path (e.g. `BrgyA/day1/s01`), with `#2`, `#3`… when one PDF holds several surveys.
- **For analysis**, upload the downloaded CSV to Claude or Gemini. It's plain text, so it uses very little.
- **Don't close the tab** before downloading. Results live only in that tab.

---

## Using a different survey form

Tally comes with the E-WACS form built in, and you can teach it any other paper form in a few minutes.

1. **Get a blank copy** of the form as a PDF: scan an unfilled form, or export the original document to PDF.
2. In Tally, step 1 **Choose the form**: click **New form from a blank PDF**, or **Import a form** and pick the PDF. Give it a name if asked.
3. Tally finds the answer areas on every page:
   - checkboxes, printed as `[ ]` or as small squares
   - write-in lines (`Name: ________`)
   - empty table cells
4. If the helper is running, your AI (Claude or Gemini) names each box, e.g. "Housing type: Townhouse" or "Smartphones: active count", and marks boxes that aren't answers as **Ignore**.
5. **Check every page** in the editor:
   - Click a box (or its row in the list) to change its type: checkbox, number, text or ignore.
   - Edit its question, and for checkboxes the option text. Checkboxes with the same question become one column.
   - Click **Delete** for wrong boxes.
   - Tick **Draw a missing box** and drag on the page to add one.
6. **Save form.** It becomes the active form and is remembered in this browser. **Edit** and **Delete** appear next to it.

**Share a form with your team:** choose it and click **Export this form**, which gives you a `.tally.json` file with the page images inside. Your teammates use **Import a form** and pick that file. Forms are saved per browser, so each computer needs the import once.

Tips:
- **Blank copy:** the cleaner the blank copy, the better the detection. Ticks or writing on the "blank" form hide those boxes.
- **Matching scans:** filled forms must be the same layout as the blank one. Page order can vary, but a reprinted form with moved questions needs a new form.
- **Switching forms:** switch forms only with an empty list. **Clear list** in step 4 first.

---

## Troubleshooting

| What you see | What to do |
|---|---|
| **Helper not running** | Click **Copy**, paste into PowerShell/Terminal, press Enter, keep the window open, then click **Check again**. |
| **Running, but Claude Code / Gemini (agy) not found** | Finish Step 2a or 2b, close and reopen PowerShell/Terminal, then run the Copy command again. |
| `node` / `claude` / `agy` **is not recognized** or **command not found** | The install didn't finish or the window is too old. Close and reopen PowerShell/Terminal. If it still fails, repeat that install step. |
| Windows: **running scripts is disabled on this system** | In PowerShell run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, answer **Y**, then retry. |
| Windows: **winget is not recognized** | Install **App Installer** from the Microsoft Store, or download the Node.js LTS `.msi` from https://nodejs.org/en/download. |
| Linux: **permission denied** during the Node.js install | Make sure you typed `sudo`, and enter your computer password when asked. |
| Helper says **already running on port 8787** | One is already open in another window; use that one or close it. |
| Gemini error **"This client is no longer supported…"** | That's the old Gemini CLI. Install Antigravity CLI (Step 2b). |
| **Usage limit reached** | Wait for your plan's limit to reset, then click **Read remaining handwriting**. |
| Page still shows an old version | Press **Ctrl+Shift+R** (Windows/Linux) or **Cmd+Shift+R** (Mac). The version number is at the top right. |
| A PDF is listed as **could not open** or **no pages of this form found** | Check that the right form is chosen in step 1, or re-scan it. The file is listed in the Review sheet. |

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

The site is served from the `main` branch of [pjohanzen/Tally](https://github.com/pjohanzen/Tally) (Settings → Pages → Deploy from a branch → `main` / root) at https://pjohanzen.github.io/Tally/.

Clone it:
```bash
git clone https://github.com/pjohanzen/Tally.git
cd Tally
```

If you already have a local copy from before the rename, point it at the new address:
```bash
git remote set-url origin https://github.com/pjohanzen/Tally.git
```

Publish a change:
```bash
git add . && git commit -m "Describe the change" && git push
```

- **Version bump:** change the version in `app.js` (`APP_VERSION`) and in `index.html` (the `?v=` on the CSS and JS links, and the version label) whenever you change code. Otherwise browsers keep the old copy for up to 10 minutes.
- **Survey data:** never commit survey PDFs or exported files. `.gitignore` already blocks `*.pdf`, `*.xlsx`, `*.csv` and session files.
- **Free accounts:** GitHub Free only serves Pages from **public** repos. The repo holds no survey data, so that's fine.
- **Repo renames:** the site address changes with the repo name. Tally rewrites saved helper commands that point at an old address automatically.

To run it locally instead: `python3 -m http.server` in this folder (Windows: `py -m http.server`), then open http://localhost:8000. Double-clicking `index.html` doesn't work, because browsers block it from loading its own files.

### How it works

1. **Read the pages:** pdf.js renders each page.
2. **Line up with the template:** OpenCV.js (ORB features + homography) works out which page of the form it is and lines it up with the template, then each field is fine-aligned.
3. **Checkboxes:** ink is counted in the parts of each box that are always empty on a blank form.
4. **Handwriting:** the blank form is subtracted from each field, and fields with leftover ink are cropped and packed into labelled sheets.
5. **AI reading:** the sheets go to `ai-helper.mjs`, which runs `claude -p` (Claude Code) or `agy -p` (Antigravity CLI) and returns structured JSON. Offline mode uses TrOCR via transformers.js instead.
6. **Checks:** values are validated (numbers, dates, known names) and anything doubtful is flagged.

Debug view: add `?debug=1` to the URL to see the aligned pages with the field boxes drawn.

### Limits

- **Template:** `templates/ewacs-v1.json` was mapped from one filled sample. A clean **blank scan of pages 3–5** would make the checkbox references cleaner.
- **Testing:** tested on the sample, a rotated/rescaled/blurred 150 dpi copy, a 60-PDF ZIP (≈3.5 min, ~100 MB memory) and a messy batch (nested folders, corrupt PDF, unrelated PDF, missing pages, two surveys in one PDF). Spot-check the first real batch against the paper forms.
- **Other forms:** build them in the page (see *Using a different survey form*). Detection handles `[ ]` brackets, printed squares, underlines and ruled tables; anything else can be drawn by hand.

Third-party code in `vendor/`: pdf.js, SheetJS Community Edition, OpenCV.js, fflate, transformers.js + ONNX Runtime Web, Public Sans font (Apache-2.0 / MIT / OFL). Offline model: microsoft/trocr-small-handwritten (ONNX export by Xenova).
