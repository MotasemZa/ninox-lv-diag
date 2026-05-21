# Ninox LV Diagnostic Tool

A local web UI for running read-only diagnostic playbooks against Ninox production databases via Teleport.

## Prerequisites

- **Python 3.11+**
- **Teleport CLI (`tsh`)** installed and in your PATH
- Active `tsh` login session:
  ```bash
  tsh login --proxy=teleport.ninox.de
  ```

## Install

```bash
pip install -r requirements.txt
```

## Run

```bash
uvicorn app:app --port 8765
```

Then open **http://127.0.0.1:8765** in your browser.

## Usage

1. The **status bar** at the top shows your Teleport login status. If not logged in, run `tsh login --proxy=teleport.ninox.de` and refresh.
2. **Select a host** from the searchable dropdown (~1000 hosts). Click "Refresh" to re-fetch from `tsh ls`.
3. **Select a database** from the tree view grouped by account ID.
4. **Choose a playbook**:
   - **Quick health check** — fast triage (~2s)
   - **Full report** — comprehensive analysis (~10-60s)
   - **Integrity check** — validates data integrity (~10s)
   - **Deep corruption scan** — full key iteration (minutes, confirmation required)
5. Click **Run** and watch real-time progress.
6. Review the **report** with traffic-light severity (green/amber/red).

## Playbooks

Playbooks are defined in `playbooks.yaml`. You can add new playbooks without code changes — just define the steps and they'll appear in the UI. All commands are validated against the allowlist and `--readonly` is enforced automatically.

## File Structure

```
.
├── app.py              # FastAPI backend
├── playbooks.yaml      # Diagnostic playbook definitions
├── requirements.txt    # Python dependencies
├── README.md           # This file
└── static/
    ├── index.html      # Single-page UI
    ├── app.js          # Frontend logic
    └── app.css         # Styles
```

## Runtime Directories

- `~/.lv-diag/hosts.json` — Cached host list
- `~/lv-diag/reports/` — Auto-saved diagnostic reports
- `~/lv-diag/audit.log` — JSON Lines audit log of all `tsh ssh` calls

## Safety

- **Read-only**: All `lv` commands include `--readonly` (auto-injected if missing)
- **Allowlisted**: Only permitted `lv` subcommands can be executed
- **No shell interpolation**: Commands are built as Python lists, never `shell=True`
- **Path validation**: Database paths are regex-validated before use
- **Audit logged**: Every remote command is logged with timestamp, host, command, exit code, and duration
- **Localhost only**: Web UI is bound to 127.0.0.1, CORS locked down

## Updates and Release Building

To build a standalone macOS application and publish updates that can be installed directly from the UI:

1. **Push source changes to GitHub**:
   Ensure you have configured the git remote and pushed your local branch:
   ```bash
   git push -u origin main
   ```

2. **Package the App**:
   Run the build script to generate the executable bundle:
   ```bash
   chmod +x build.sh
   ./build.sh
   ```
   This compiles everything and produces `dist/Ninox Diagnostics.app`.

3. **Zip the App Bundle**:
   Compress the compiled `.app` bundle into a zip file:
   ```bash
   cd dist
   zip -r Ninox-Diagnostics-macOS.zip "Ninox Diagnostics.app"
   cd ..
   ```

4. **Create a GitHub Release**:
   - Go to your repository page: `https://github.com/motasem/ninox-lv-diag`
   - Draft a new release (e.g., tag it `v1.0.1` or higher).
   - Set the Release Title to match the tag (e.g., `v1.0.1`).
   - Upload the `Ninox-Diagnostics-macOS.zip` file as a release asset.
   - Publish the release.

The application checks for updates from the UI via the GitHub API, downloads the zip file, and automatically replaces the running binary on update installation.

