"""
Ninox LV Diagnostic Tool — FastAPI Backend
Drives the `lv` CLI on remote hosts via Teleport `tsh ssh`.
All access is read-only. Runs on localhost only.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shlex
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------------------
# Constants & Configuration
# ---------------------------------------------------------------------------

ALLOWED_LV_SUBCOMMANDS = frozenset({
    "diagnose", "report", "stats", "tables", "validate",
    "orphans", "schema", "metrics", "sizes", "keys",
    "search", "history", "version", "analyze", "views",
})

FORBIDDEN_LV_SUBCOMMANDS = frozenset({
    "repair", "compact", "strip-field", "purge-history",
    "backup", "generate", "export", "export-history", "get", "repl",
})

DB_PATH_REGEX = re.compile(r"^/var/nxdb/accounts/[a-z0-9]+/db/[a-z0-9]+/data$")

ALLOWED_HOST_COMMANDS = {
    "df_h":                    "df -h",
    "free_h":                  "free -h",
    "uptime":                  "uptime",
    "systemctl_status_nxdb":   "systemctl status nxdb --no-pager",
    "journalctl_nxdb":         "journalctl -u nxdb --since '{since}' --no-pager | tail -{lines}",
    "du_databases_sorted":     "du -sh /var/nxdb/accounts/*/db/*/data 2>/dev/null | sort -hr",
    "find_databases":          "find /var/nxdb/accounts -maxdepth 4 -path '*/db/*/data' -type d",
}

# Paths that are allowed for cleanup (rm -rf) on the remote host
ALLOWED_CLEANUP_PREFIX = "/tmp/lv-"

# Remote user for tsh ssh
REMOTE_USER = "apollo"

# Default and extended timeouts
DEFAULT_TIMEOUT = 60
EXTENDED_TIMEOUT = 600

# Update settings
CURRENT_VERSION = "v1.0.1"
GITHUB_REPO = "MotasemZa/ninox-lv-diag" # Replace with your actual repo


# Directories
LV_DIAG_DIR = Path.home() / ".lv-diag"
REPORTS_DIR = Path.home() / "lv-diag" / "reports"
AUDIT_LOG_PATH = Path.home() / "lv-diag" / "audit.log"
HOSTS_CACHE_PATH = LV_DIAG_DIR / "hosts.json"

# Playbooks file (relative to app.py)
PLAYBOOKS_PATH = Path(__file__).parent / "playbooks.yaml"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("lv-diag")

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Ninox LV Diagnostic Tool",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8765"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Helpers — filesystem
# ---------------------------------------------------------------------------


def ensure_dirs():
    """Create runtime directories if they don't exist."""
    LV_DIAG_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    AUDIT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)


ensure_dirs()


# ---------------------------------------------------------------------------
# Helpers — audit log
# ---------------------------------------------------------------------------


def audit_log(host: str, command: str, exit_code: int, duration_s: float):
    """Append an entry to the JSON Lines audit log."""
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "host": host,
        "command": command,
        "exit_code": exit_code,
        "duration_s": round(duration_s, 3),
    }
    try:
        with open(AUDIT_LOG_PATH, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError as e:
        logger.error("Failed to write audit log: %s", e)


# ---------------------------------------------------------------------------
# Helpers — command validation
# ---------------------------------------------------------------------------


def validate_db_path(path: str) -> bool:
    """Validate that a database path matches the expected pattern."""
    return bool(DB_PATH_REGEX.match(path))


def parse_lv_command(cmd: str) -> tuple[str | None, str | None]:
    """
    Extract the subcommand from an lv command string.
    Returns (subcommand, error_message). One will be None.
    """
    parts = shlex.split(cmd)
    if not parts or parts[0] != "lv":
        return None, None  # Not an lv command, might be a shell command like rm
    if len(parts) < 2:
        return None, "lv command has no subcommand"
    return parts[1], None


def validate_lv_command(cmd: str) -> tuple[bool, str, str | None]:
    """
    Validate an lv command string.
    Returns (is_valid, possibly_modified_cmd, error_msg).
    error_msg is None if valid.
    """
    subcommand, err = parse_lv_command(cmd)

    if subcommand is None and err is None:
        # Not an lv command — could be a legitimate non-lv command (e.g., rm cleanup)
        return True, cmd, None

    if err:
        return False, cmd, err

    if subcommand in FORBIDDEN_LV_SUBCOMMANDS:
        return False, cmd, f"Forbidden lv subcommand: {subcommand}"

    if subcommand not in ALLOWED_LV_SUBCOMMANDS:
        return False, cmd, f"Unknown lv subcommand: {subcommand}. Not in allowlist."

    # Inject --readonly if missing
    if "--readonly" not in cmd:
        logger.warning(
            "Command missing --readonly, injecting: %s", cmd
        )
        # Insert --readonly right after `lv <subcommand>`
        parts = cmd.split(None, 2)  # ['lv', 'subcommand', 'rest...']
        if len(parts) >= 2:
            rest = parts[2] if len(parts) > 2 else ""
            cmd = f"lv {parts[1]} --readonly {rest}".strip()

    return True, cmd, None


def validate_cleanup_command(cmd: str) -> tuple[bool, str | None]:
    """Validate that a non-lv command is an allowed cleanup command."""
    parts = shlex.split(cmd)
    if not parts:
        return False, "Empty command"

    # Allow: rm -rf /tmp/lv-<uuid>
    if parts[0] == "rm" and "-rf" in parts:
        target = parts[-1]
        if target.startswith(ALLOWED_CLEANUP_PREFIX):
            return True, None
        return False, f"Cleanup path not allowed: {target}"

    # Allow: cat <path> (for fetch steps)
    if parts[0] == "cat" and len(parts) == 2:
        target = parts[1]
        if target.startswith(ALLOWED_CLEANUP_PREFIX):
            return True, None
        return False, f"Fetch path not allowed: {target}"

    return False, f"Non-lv command not allowed: {cmd}"


# ---------------------------------------------------------------------------
# Helpers — tsh execution
# ---------------------------------------------------------------------------


def run_tsh_command(
    host: str,
    remote_cmd: str,
    timeout: int = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    """
    Execute a command on a remote host via tsh ssh.
    Returns {stdout, stderr, returncode, duration_s}.
    """
    argv = ["tsh", "ssh", f"{REMOTE_USER}@{host}", remote_cmd]
    logger.info("Executing: tsh ssh %s@%s %r (timeout=%ds)", REMOTE_USER, host, remote_cmd, timeout)

    start = time.monotonic()
    try:
        result = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=False,  # NEVER use shell=True
        )
        duration = time.monotonic() - start
        audit_log(host, remote_cmd, result.returncode, duration)
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode,
            "duration_s": round(duration, 3),
            "timed_out": False,
        }
    except subprocess.TimeoutExpired:
        duration = time.monotonic() - start
        audit_log(host, remote_cmd, -1, duration)
        logger.error("Command timed out after %ds: %s", timeout, remote_cmd)
        return {
            "stdout": "",
            "stderr": f"Command timed out after {timeout}s",
            "returncode": -1,
            "duration_s": round(duration, 3),
            "timed_out": True,
        }
    except FileNotFoundError:
        duration = time.monotonic() - start
        logger.error("tsh not found in PATH")
        return {
            "stdout": "",
            "stderr": "tsh command not found. Is Teleport installed?",
            "returncode": -1,
            "duration_s": round(duration, 3),
            "timed_out": False,
        }


def run_local_command(argv: list[str], timeout: int = 10) -> dict[str, Any]:
    """Run a command locally (for tsh status, tsh ls, etc.)."""
    logger.info("Local command: %s", " ".join(argv))
    start = time.monotonic()
    try:
        result = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=False,
        )
        duration = time.monotonic() - start
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode,
            "duration_s": round(duration, 3),
        }
    except subprocess.TimeoutExpired:
        duration = time.monotonic() - start
        return {
            "stdout": "",
            "stderr": f"Command timed out after {timeout}s",
            "returncode": -1,
            "duration_s": round(duration, 3),
        }
    except FileNotFoundError:
        return {
            "stdout": "",
            "stderr": "tsh command not found. Is Teleport installed?",
            "returncode": -1,
            "duration_s": 0,
        }


# ---------------------------------------------------------------------------
# Helpers — playbooks
# ---------------------------------------------------------------------------


def load_playbooks() -> list[dict]:
    """Load playbooks from YAML file."""
    with open(PLAYBOOKS_PATH) as f:
        data = yaml.safe_load(f)
    return data.get("playbooks", [])


def get_playbook(playbook_id: str) -> dict | None:
    """Get a specific playbook by ID."""
    for pb in load_playbooks():
        if pb["id"] == playbook_id:
            return pb
    return None


def determine_timeout(step: dict, cmd: str) -> int:
    """Determine the timeout for a step."""
    # Explicit timeout in step definition
    if "timeout_seconds" in step:
        return step["timeout_seconds"]
    # Extended timeout for lv report or --deep
    if "lv report" in cmd or "--deep" in cmd:
        return EXTENDED_TIMEOUT
    return DEFAULT_TIMEOUT


# ---------------------------------------------------------------------------
# Helpers — severity evaluation
# ---------------------------------------------------------------------------


def _safe_get(data: Any, *keys, default=None) -> Any:
    """Safely navigate nested dicts/lists."""
    current = data
    for key in keys:
        if isinstance(current, dict):
            current = current.get(key, default)
        elif isinstance(current, list) and isinstance(key, int) and key < len(current):
            current = current[key]
        else:
            return default
        if current is None:
            return default
    return current


def evaluate_severity(playbook_id: str, step_results: list[dict], fetched: dict | None = None) -> str:
    """
    Evaluate the overall severity for a completed playbook run.
    Returns 'green', 'amber', or 'red'.
    """
    try:
        if playbook_id == "quick_health":
            return _evaluate_quick_health(step_results)
        elif playbook_id == "full_report":
            return _evaluate_full_report(step_results, fetched)
        elif playbook_id == "integrity_check":
            return _evaluate_integrity_check(step_results)
        elif playbook_id == "deep_scan":
            return _evaluate_deep_scan(step_results)
        elif playbook_id == "host_health":
            return _evaluate_host_health(step_results)
        elif playbook_id == "recent_nxdb_logs":
            return _evaluate_recent_nxdb_logs(step_results)
        elif playbook_id in ("disk_per_database", "list_accounts_and_databases"):
            if any(r.get("status") == "error" for r in step_results):
                return "red"
            return "green"
    except Exception as e:
        logger.error("Severity evaluation failed for %s: %s", playbook_id, e)

    # If any step failed to execute, red
    if any(r.get("status") == "error" for r in step_results):
        return "red"
    return "amber"


def _evaluate_quick_health(step_results: list[dict]) -> str:
    """Severity for quick_health playbook."""
    # Check if diagnose step failed to run
    if not step_results or step_results[0].get("status") == "error":
        return "red"

    diagnose = step_results[0].get("parsed")
    if not diagnose or not isinstance(diagnose, dict):
        return "amber"

    # Red if any check has status 'fail'
    checks = diagnose.get("checks", [])
    for check in checks:
        if check.get("status") == "fail":
            return "red"

    # Amber if top-level status is 'warning', BUT:
    # A locked database is normal — if the only warning is lock, treat as green
    top_status = diagnose.get("status", "")
    if top_status == "warning":
        warnings = diagnose.get("warnings", [])
        non_lock_warnings = [
            w for w in warnings
            if "locked" not in w.lower()
        ]
        # Also check checks for non-lock warns
        warn_checks = [
            c for c in checks
            if c.get("status") == "warn" and "lock" not in c.get("name", "").lower()
        ]
        if non_lock_warnings or warn_checks:
            return "amber"
        # Only lock warnings — this is normal
        return "green"

    return "green"


def _evaluate_full_report(step_results: list[dict], fetched: dict | None) -> str:
    """Severity for full_report playbook."""
    # Check if any step failed
    if any(r.get("status") == "error" for r in step_results):
        return "red"

    # Look for the fetched JSON report data
    report_json = None

    # Try fetched dict first
    if fetched and "json" in fetched:
        report_json = fetched["json"]

    # Also check step results for the Fetch JSON step
    if report_json is None:
        for r in step_results:
            if r.get("name") == "Fetch JSON" and r.get("parsed"):
                report_json = r["parsed"]
                break

    if not report_json or not isinstance(report_json, dict):
        return "amber"

    # Red if errors > 0 or health == 'fail'
    analysis = report_json.get("analysis", {})
    errors = analysis.get("errors", 0)
    health = report_json.get("health", "")

    if (isinstance(errors, int) and errors > 0) or health == "fail":
        return "red"

    # Amber if warnings > 0 or health == 'warning'
    warnings = analysis.get("warnings", 0)
    if (isinstance(warnings, int) and warnings > 0) or health == "warning":
        return "amber"

    return "green"


def _evaluate_integrity_check(step_results: list[dict]) -> str:
    """Severity for integrity_check playbook."""
    if any(r.get("status") == "error" for r in step_results):
        return "red"

    # Step 0: validate — check for issues
    validate = step_results[0].get("parsed", {}) if step_results else {}
    if isinstance(validate, dict):
        issues = validate.get("issues", [])
        if isinstance(issues, list) and len(issues) > 0:
            return "red"

    # Step 1: orphans — check for orphans
    if len(step_results) > 1:
        orphans_data = step_results[1].get("parsed", {})
        if isinstance(orphans_data, dict):
            orphans = orphans_data.get("orphans", [])
            if isinstance(orphans, list) and len(orphans) > 0:
                return "red"

    return "green"


def _evaluate_deep_scan(step_results: list[dict]) -> str:
    """Severity for deep_scan playbook."""
    if not step_results or step_results[0].get("status") == "error":
        return "red"

    diagnose = step_results[0].get("parsed")
    if not diagnose or not isinstance(diagnose, dict):
        return "amber"

    checks = diagnose.get("checks", [])
    for check in checks:
        if check.get("status") == "fail":
            return "red"

    # For deep scan, any warning is amber (even lock)
    for check in checks:
        if check.get("status") == "warn":
            return "amber"

    return "green"


def _evaluate_host_health(step_results: list[dict]) -> str:
    """Severity for host_health playbook."""
    if any(r.get("status") == "error" for r in step_results):
        return "red"
    
    disk_usage = 0
    load_avg = 0.0
    nxdb_active = False
    
    for r in step_results:
        cmd = r.get("command", "")
        out = r.get("output", "")
        if "df -h" in cmd:
            for line in out.splitlines():
                if "/var/nxdb" in line:
                    parts = line.split()
                    if len(parts) >= 5:
                        use_pct = parts[-2].replace("%", "")
                        if use_pct.isdigit():
                            disk_usage = int(use_pct)
        elif "uptime" in cmd:
            if "load average:" in out:
                idx = out.find("load average:")
                load_str = out[idx + len("load average:"):].split(",")[0].strip()
                try:
                    load_avg = float(load_str)
                except ValueError:
                    pass
        elif "systemctl status nxdb" in cmd:
            if "active (running)" in out:
                nxdb_active = True
                
    if not nxdb_active or disk_usage > 90:
        return "red"
    if disk_usage > 80:
        return "amber"
    # CPU count not explicitly fetched; assuming load average > 4 is amber for a small VM.
    if load_avg > 4:
        return "amber"
        
    return "green"


def _evaluate_recent_nxdb_logs(step_results: list[dict]) -> str:
    """Severity for recent_nxdb_logs playbook."""
    if any(r.get("status") == "error" for r in step_results):
        return "red"
    
    for r in step_results:
        out = r.get("output", "").lower()
        if "error" in out or "panic" in out or "fatal" in out:
            return "amber"
            
    return "green"


# ---------------------------------------------------------------------------
# Helpers — report saving
# ---------------------------------------------------------------------------


def save_report(
    host: str,
    db_path: str,
    playbook_id: str,
    severity: str,
    step_results: list[dict],
    fetched: dict | None,
    errors: list[str],
    reasoning: str = "",
) -> str:
    """
    Save a run report to disk.
    Returns the report directory path.
    """
    # Extract db_id from path
    # /var/nxdb/accounts/<account_id>/db/<db_id>/data
    path_parts = db_path.strip("/").split("/")
    db_id = path_parts[4] if len(path_parts) > 4 else "unknown"

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    report_name = f"{timestamp}__{host}__{db_id}__{playbook_id}"
    report_dir = REPORTS_DIR / report_name
    report_dir.mkdir(parents=True, exist_ok=True)

    # Save result.json
    result_data = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "host": host,
        "db_path": db_path,
        "playbook_id": playbook_id,
        "severity": severity,
        "reasoning": reasoning,
        "steps": step_results,
        "errors": errors,
    }
    with open(report_dir / "result.json", "w") as f:
        json.dump(result_data, f, indent=2, default=str)

    # Save summary.md
    summary_lines = [
        f"# Diagnostic Report: {playbook_id}",
        "",
        f"- **Host:** {host}",
        f"- **Database:** {db_path}",
        f"- **Playbook:** {playbook_id}",
        f"- **Severity:** {severity.upper()}",
        f"- **Reasoning:** {reasoning}",
        f"- **Timestamp:** {result_data['timestamp']}",
        "",
        "## Steps Summary",
        "",
        "| Step | Status | Duration | Command |",
        "|---|---|---|---|",
    ]
    for i, step in enumerate(step_results):
        status_icon = {"success": "✅", "error": "❌", "skipped": "⏭️"}.get(
            step.get("status", ""), "❓"
        )
        duration = step.get("duration_s", 0)
        cmd = step.get("command", "")
        if len(cmd) > 60:
            cmd = cmd[:57] + "..."
        summary_lines.append(f"| {i+1}. {step.get('name', 'Unknown')} | {status_icon} | {duration:.1f}s | `{cmd}` |")

    summary_lines.extend(["", "## Detailed Step Output", ""])
    for i, step in enumerate(step_results):
        summary_lines.extend([
            f"### {i+1}. {step.get('name', 'Unknown')}",
            f"**Command:** `{step.get('command', 'N/A')}`"
        ])
        if step.get("status") == "error":
            summary_lines.append(f"**Error:** {step.get('error', 'Unknown error')}")
        elif step.get("output"):
            summary_lines.extend([
                "```",
                step["output"].strip() or "(no output)",
                "```"
            ])
        summary_lines.append("")

    if errors:
        summary_lines.extend(["## Errors", ""])
        for err in errors:
            summary_lines.append(f"- {err}")

    with open(report_dir / "summary.md", "w") as f:
        f.write("\n".join(summary_lines))

    # Save fetched files (for full_report)
    if fetched:
        if "markdown" in fetched:
            with open(report_dir / "report.md", "w") as f:
                f.write(fetched["markdown"])
        if "json" in fetched and isinstance(fetched["json"], dict):
            with open(report_dir / "report.json", "w") as f:
                json.dump(fetched["json"], f, indent=2, default=str)

    logger.info("Report saved to %s", report_dir)
    return str(report_dir)


# ---------------------------------------------------------------------------
# Helpers — generate summary text
# ---------------------------------------------------------------------------


def generate_summary(playbook_id: str, severity: str, step_results: list[dict]) -> tuple[str, str]:
    """Generate a human-readable summary string for the report header, and a reasoning string."""
    total_steps = len(step_results)
    ok_steps = sum(1 for s in step_results if s.get("status") == "success")
    failed_steps = sum(1 for s in step_results if s.get("status") == "error")
    total_duration = sum(s.get("duration_s", 0) for s in step_results)

    parts = []
    reasoning = ""
    if severity == "green":
        parts.append("All checks passed.")
        reasoning = f"The {playbook_id} scan found no critical errors or warnings, indicating the database is in a healthy state."
    elif severity == "amber":
        parts.append("Completed with warnings.")
        reasoning = f"The {playbook_id} scan completed but found some warnings. This may be normal (e.g., active locks) or require minor attention."
    else:
        parts.append("Issues detected — review required.")
        reasoning = f"The {playbook_id} scan found critical errors or failures that require immediate attention."

    parts.append(f"{ok_steps}/{total_steps} steps completed successfully.")
    if failed_steps:
        parts.append(f"{failed_steps} step(s) failed.")
    parts.append(f"Total time: {total_duration:.1f}s.")

    return " ".join(parts), reasoning


# ---------------------------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------------------------


@app.get("/api/status")
async def api_status():
    """Check tsh login status."""
    result = run_local_command(["tsh", "status", "--format=json"], timeout=10)

    if result["returncode"] != 0:
        # Try without --format=json in case older tsh version
        result = run_local_command(["tsh", "status"], timeout=10)

        if result["returncode"] != 0:
            return {
                "logged_in": False,
                "user": None,
                "proxy": None,
                "expires": None,
                "error": result["stderr"].strip() or "Not logged in",
            }

        # Parse text output
        stdout = result["stdout"]
        user = None
        proxy = None
        expires = None

        for line in stdout.splitlines():
            line = line.strip()
            if ":" in line:
                key, _, value = line.partition(":")
                key = key.strip().lower()
                value = value.strip()
                if "user" in key or "logged in as" in key:
                    user = value
                elif "proxy" in key:
                    proxy = value.split(":")[0] if value else None
                elif "valid until" in key or "expires" in key:
                    expires = value

        return {
            "logged_in": user is not None,
            "user": user,
            "proxy": proxy,
            "expires": expires,
        }

    # Parse JSON output
    try:
        data = json.loads(result["stdout"])
        # tsh status --format=json returns various shapes depending on version
        if isinstance(data, list) and data:
            data = data[0]

        user = data.get("username") or data.get("user") or data.get("logins", [None])[0]
        proxy = data.get("proxy_url") or data.get("proxyhost") or data.get("proxy", {}).get("host")
        expires = data.get("valid_until") or data.get("expires")

        return {
            "logged_in": True,
            "user": user,
            "proxy": proxy,
            "expires": expires,
        }
    except (json.JSONDecodeError, KeyError, IndexError):
        return {
            "logged_in": True,
            "user": None,
            "proxy": None,
            "expires": None,
        }


@app.get("/api/hosts")
async def api_hosts(refresh: bool = Query(False)):
    """Return cached host list, optionally refreshing from tsh ls."""
    if not refresh and HOSTS_CACHE_PATH.exists():
        try:
            with open(HOSTS_CACHE_PATH) as f:
                cache = json.load(f)
            return cache
        except (json.JSONDecodeError, OSError):
            pass  # Fall through to refresh

    # Refresh from tsh ls
    result = run_local_command(["tsh", "ls", "--format=json"], timeout=30)

    hosts = []

    if result["returncode"] == 0 and result["stdout"].strip():
        try:
            data = json.loads(result["stdout"])
            # tsh ls --format=json returns a list of node objects
            if isinstance(data, list):
                for node in data:
                    spec = node.get("spec", {})
                    metadata = node.get("metadata", {})
                    hostname = spec.get("hostname") or metadata.get("name", "")
                    labels = metadata.get("labels", {})
                    if hostname:
                        hosts.append({"name": hostname, "labels": labels})
        except json.JSONDecodeError:
            pass

    if not hosts:
        # Fallback: try parsing text output
        result = run_local_command(["tsh", "ls"], timeout=30)
        if result["returncode"] == 0:
            lines = result["stdout"].strip().splitlines()
            # Skip header lines (usually first 2 lines)
            for line in lines[2:]:
                parts = line.split()
                if parts:
                    hostname = parts[0]
                    if hostname and not hostname.startswith("-"):
                        hosts.append({"name": hostname, "labels": {}})

    if not hosts and result["returncode"] != 0:
        raise HTTPException(
            status_code=502,
            detail=f"tsh ls failed: {result['stderr'].strip()}"
        )

    cache_data = {
        "hosts": hosts,
        "cached_at": datetime.now(timezone.utc).isoformat(),
    }

    # Save cache
    try:
        with open(HOSTS_CACHE_PATH, "w") as f:
            json.dump(cache_data, f)
    except OSError as e:
        logger.error("Failed to cache hosts: %s", e)

    return cache_data


@app.get("/api/dbs")
async def api_dbs(host: str = Query(...)):
    """List databases on a host, grouped by account ID, along with workspace user emails."""
    if not host:
        raise HTTPException(status_code=400, detail="host is required")

    # 1. Find live LevelDB databases
    cmd = "find /var/nxdb/accounts -maxdepth 4 -path '*/db/*/data' -name 'data' -type d"
    result = run_tsh_command(host, cmd, timeout=30)

    if result["returncode"] != 0:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to list databases: {result['stderr'].strip()}"
        )

    accounts: dict[str, list[str]] = {}
    for line in result["stdout"].strip().splitlines():
        line = line.strip()
        if not line:
            continue

        # Skip paths containing /undefined/
        if "/undefined/" in line:
            continue

        # Parse: /var/nxdb/accounts/<account_id>/db/<db_id>/data
        match = re.match(
            r"^/var/nxdb/accounts/([a-z0-9]+)/db/([a-z0-9]+)/data$",
            line,
        )
        if match:
            account_id = match.group(1)
            db_id = match.group(2)
            accounts.setdefault(account_id, []).append(db_id)

    # 2. Try fetching User Management System (ums.json) to map workspace names and user emails
    accounts_metadata = {}
    ums_result = run_tsh_command(host, "cat /var/nxdb/ums.json", timeout=15)
    if ums_result["returncode"] == 0 and ums_result["stdout"].strip():
        try:
            ums_data = json.loads(ums_result["stdout"])
            users_map = {u["id"]: u for u in ums_data.get("users", [])}
            
            for team in ums_data.get("teams", []):
                team_id = team.get("id")
                if not team_id:
                    continue
                    
                team_name = team.get("name", "Unknown")
                member_emails = []
                for mu in team.get("users", []):
                    user_id = mu.get("user")
                    if user_id in users_map:
                        email = users_map[user_id].get("email")
                        if email:
                            member_emails.append(email)
                            
                accounts_metadata[team_id] = {
                    "name": team_name,
                    "emails": sorted(list(set(member_emails)))
                }
        except Exception as e:
            logger.warning("Failed to parse ums.json on %s: %s", host, str(e))

    return {
        "accounts": accounts,
        "metadata": accounts_metadata
    }


@app.get("/api/host/dashboard")
async def api_host_dashboard(host: str = Query(...)):
    """Fetch automatic host-level diagnostics for the dashboard."""
    if not host:
        raise HTTPException(status_code=400, detail="host is required")
        
    dashboard = {
        "disk_usage": "Unknown",
        "memory": "Unknown",
        "uptime": "Unknown",
        "nxdb_status": "Unknown",
        "logs": "",
        "db_sizes": {}
    }
    
    # 1. Host stats + nxdb status + df
    cmds = [
        "df -h /var/nxdb",
        "free -h",
        "uptime",
        "systemctl status nxdb --no-pager"
    ]
    cmd_str = " ; echo '---' ; ".join(cmds)
    result = run_tsh_command(host, cmd_str, timeout=30)
    
    if result["returncode"] == 0:
        parts = result["stdout"].split("---")
        if len(parts) >= 4:
            df_out, free_out, uptime_out, status_out = parts[0], parts[1], parts[2], parts[3]
            
            # parse df
            for line in df_out.strip().splitlines():
                if "/var/nxdb" in line:
                    tokens = line.split()
                    if len(tokens) >= 5:
                        dashboard["disk_usage"] = tokens[-2] # e.g. "45%"
                        
            # parse memory (just return the whole `free -h` stdout or part of it)
            dashboard["memory"] = "\n".join(free_out.strip().splitlines()[:2])
            
            # parse uptime
            dashboard["uptime"] = uptime_out.strip()
            
            # parse status
            if "active (running)" in status_out:
                dashboard["nxdb_status"] = "Active (Running)"
            else:
                dashboard["nxdb_status"] = "Inactive/Error"
                
    # 2. Recent logs
    logs_result = run_tsh_command(host, "journalctl -u nxdb --since '1 hour ago' --no-pager | tail -100", timeout=30)
    if logs_result["returncode"] == 0:
        dashboard["logs"] = logs_result["stdout"].strip()
        
    # 3. DB Sizes
    size_cmd = "du -sh /var/nxdb/accounts/*/db/*/data 2>/dev/null"
    size_result = run_tsh_command(host, size_cmd, timeout=30)
    if size_result["returncode"] == 0:
        for line in size_result["stdout"].strip().splitlines():
            # line: "45M   /var/nxdb/accounts/acct1/db/db1/data"
            parts = line.split(maxsplit=1)
            if len(parts) == 2:
                size, path = parts
                match = re.search(r"accounts/([a-z0-9]+)/db/([a-z0-9]+)/data", path)
                if match:
                    acct = match.group(1)
                    db = match.group(2)
                    dashboard["db_sizes"][f"{acct}/{db}"] = size
                    
    return dashboard


@app.get("/api/playbooks")
async def api_playbooks():
    """Return parsed playbooks from YAML."""
    try:
        playbooks = load_playbooks()
        return {"playbooks": playbooks}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load playbooks: {e}")


@app.post("/api/run")
async def api_run(request: Request):
    """
    Execute a playbook. Returns Server-Sent Events stream.
    """
    body = await request.json()
    host = body.get("host", "").strip()
    db_path = body.get("db_path", "").strip()
    playbook_id = body.get("playbook_id", "").strip()

    # Validate inputs
    if not host:
        raise HTTPException(status_code=400, detail="host is required")
    if not db_path:
        raise HTTPException(status_code=400, detail="db_path is required")
    if not playbook_id:
        raise HTTPException(status_code=400, detail="playbook_id is required")

    if not validate_db_path(db_path):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid database path: {db_path}. Must match {DB_PATH_REGEX.pattern}",
        )

    playbook = get_playbook(playbook_id)
    if not playbook:
        raise HTTPException(status_code=404, detail=f"Playbook not found: {playbook_id}")

    run_id = str(uuid.uuid4())

    async def event_stream():
        step_results = []
        fetched: dict[str, Any] = {}
        errors: list[str] = []

        steps = playbook.get("steps", [])
        total_steps = len(steps)

        for step_index, step in enumerate(steps):
            step_name = step.get("name", f"Step {step_index + 1}")
            is_valid, step_cmd, step_err = _resolve_cmd(step, db_path, run_id, {})

            # Send step_start event
            yield _sse_event("step_start", {
                "step_index": step_index,
                "name": step_name,
                "total_steps": total_steps,
                "command": step_cmd,
            })

            try:
                if not is_valid:
                    result = {
                        "name": step_name,
                        "status": "error",
                        "error": step_err or "Invalid command",
                        "duration_s": 0,
                        "output": "",
                        "parsed": None,
                    }
                elif "fetch" in step:
                    # Fetch step: cat a file from the remote host
                    result = _execute_fetch_step(host, step, step_cmd)
                    fetched_as = step.get("as", "text")
                    if result["status"] == "success" and result.get("output"):
                        if fetched_as == "json":
                            try:
                                fetched["json"] = json.loads(result["output"])
                            except json.JSONDecodeError:
                                fetched["json_raw"] = result["output"]
                        elif fetched_as == "markdown":
                            fetched["markdown"] = result["output"]
                        else:
                            fetched[fetched_as] = result["output"]
                elif "cmd" in step or "cmd_key" in step:
                    # Command step: execute via tsh
                    result = _execute_cmd_step(host, step, step_cmd)
                else:
                    result = {
                        "name": step_name,
                        "status": "error",
                        "error": "Step has no 'cmd', 'cmd_key' or 'fetch' field",
                        "duration_s": 0,
                        "output": "",
                        "parsed": None,
                    }

                result["name"] = step_name
                result["command"] = step_cmd
                step_results.append(result)

                if result["status"] == "error":
                    errors.append(f"Step '{step_name}': {result.get('error', 'Unknown error')}")
                    yield _sse_event("step_error", {
                        "step_index": step_index,
                        "name": step_name,
                        "error": result.get("error", "Unknown error"),
                        "duration_s": result.get("duration_s", 0),
                    })
                else:
                    yield _sse_event("step_complete", {
                        "step_index": step_index,
                        "name": step_name,
                        "status": result["status"],
                        "duration_s": result.get("duration_s", 0),
                        "output": result.get("output", ""),
                        "parsed": result.get("parsed"),
                        "command": step_cmd,
                    })

            except Exception as e:
                logger.exception("Step %s failed with exception", step_name)
                err_result = {
                    "name": step_name,
                    "status": "error",
                    "error": str(e),
                    "duration_s": 0,
                    "output": "",
                    "parsed": None,
                }
                step_results.append(err_result)
                errors.append(f"Step '{step_name}': {e}")
                yield _sse_event("step_error", {
                    "step_index": step_index,
                    "name": step_name,
                    "error": str(e),
                    "duration_s": 0,
                })

        # Evaluate severity
        severity = evaluate_severity(playbook_id, step_results, fetched or None)

        # Generate summary
        summary, reasoning = generate_summary(playbook_id, severity, step_results)

        # Save report
        report_dir = save_report(
            host=host,
            db_path=db_path,
            playbook_id=playbook_id,
            severity=severity,
            step_results=step_results,
            fetched=fetched or None,
            errors=errors,
            reasoning=reasoning,
        )

        yield _sse_event("run_complete", {
            "status": "complete",
            "severity": severity,
            "summary": summary,
            "reasoning": reasoning,
            "steps": step_results,
            "report_dir": report_dir,
            "errors": errors,
            "fetched": {
                k: v if not isinstance(v, dict) else "(structured data)"
                for k, v in fetched.items()
            } if fetched else None,
        })

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Helpers — step execution
# ---------------------------------------------------------------------------


def _sse_event(event_type: str, data: dict) -> str:
    """Format a Server-Sent Event."""
    json_data = json.dumps(data, default=str)
    return f"event: {event_type}\ndata: {json_data}\n\n"


def _resolve_cmd(step: dict, db_path: str, run_id: str, inputs: dict) -> tuple[bool, str, str | None]:
    """Resolve the final command string that will be executed for a step."""
    if "fetch" in step:
        fetch_path = step["fetch"].replace("{db_path}", db_path).replace("{run_id}", run_id)
        if not fetch_path.startswith(ALLOWED_CLEANUP_PREFIX):
            return False, "", f"Fetch path not allowed: {fetch_path}"
        cmd = f"cat {shlex.quote(fetch_path)}"
        return True, cmd, None

    elif "cmd_key" in step:
        cmd_key = step["cmd_key"]
        if cmd_key not in ALLOWED_HOST_COMMANDS:
            return False, "", f"Unknown cmd_key: {cmd_key}"
        cmd_template = ALLOWED_HOST_COMMANDS[cmd_key]
        
        cmd = cmd_template.replace("{db_path}", db_path).replace("{run_id}", run_id)
        for k, v in inputs.items():
            cmd = cmd.replace(f"{{{k}}}", v)
        
        return True, cmd, None

    elif "cmd" in step:
        cmd_template = step["cmd"]
        cmd = cmd_template.replace("{db_path}", db_path).replace("{run_id}", run_id)
        
        subcommand, _ = parse_lv_command(cmd)
        if subcommand is not None:
            return validate_lv_command(cmd)
        else:
            is_valid, err = validate_cleanup_command(cmd)
            return is_valid, cmd, err

    return False, "", "Step has no 'cmd', 'cmd_key', or 'fetch' field"


def _execute_cmd_step(
    host: str,
    step: dict,
    cmd: str,
) -> dict:
    """Execute a command step."""
    subcommand, _ = parse_lv_command(cmd)

    # Determine timeout
    timeout = determine_timeout(step, cmd)

    # Execute
    result = run_tsh_command(host, cmd, timeout=timeout)

    if result["timed_out"]:
        return {
            "status": "error",
            "error": f"Command timed out after {timeout}s",
            "duration_s": result["duration_s"],
            "output": result["stdout"],
            "parsed": None,
        }

    if result["returncode"] != 0:
        # For cleanup commands, non-zero exit is a warning not an error
        if subcommand is None and "rm" in cmd:
            logger.warning("Cleanup command failed (non-critical): %s", result["stderr"])
            return {
                "status": "success",
                "duration_s": result["duration_s"],
                "output": result["stdout"],
                "parsed": None,
            }
        return {
            "status": "error",
            "error": result["stderr"].strip() or f"Exit code {result['returncode']}",
            "duration_s": result["duration_s"],
            "output": result["stdout"],
            "parsed": None,
        }

    # Parse output
    parsed = None
    parse_mode = step.get("parse", "none")
    if parse_mode == "json" and result["stdout"].strip():
        try:
            parsed = json.loads(result["stdout"])
        except json.JSONDecodeError as e:
            logger.warning("Failed to parse JSON output: %s", e)
            parsed = None

    return {
        "status": "success",
        "duration_s": result["duration_s"],
        "output": result["stdout"],
        "parsed": parsed,
    }


def _execute_fetch_step(
    host: str,
    step: dict,
    cmd: str,
) -> dict:
    """Execute a fetch step (cat a file from remote host)."""
    result = run_tsh_command(host, cmd, timeout=DEFAULT_TIMEOUT)

    if result["timed_out"]:
        return {
            "status": "error",
            "error": f"Fetch timed out after {DEFAULT_TIMEOUT}s",
            "duration_s": result["duration_s"],
            "output": "",
            "parsed": None,
        }

    if result["returncode"] != 0:
        return {
            "status": "error",
            "error": result["stderr"].strip() or f"Fetch failed with exit code {result['returncode']}",
            "duration_s": result["duration_s"],
            "output": "",
            "parsed": None,
        }

    # Parse based on step's 'as' field
    parsed = None
    as_type = step.get("as", "text")
    if as_type == "json" and result["stdout"].strip():
        try:
            parsed = json.loads(result["stdout"])
        except json.JSONDecodeError:
            parsed = None

    return {
        "status": "success",
        "duration_s": result["duration_s"],
        "output": result["stdout"],
        "parsed": parsed,
    }


# ---------------------------------------------------------------------------
# Updates
# ---------------------------------------------------------------------------

@app.get("/api/update/check")
async def api_update_check():
    """Check GitHub releases for a new version."""
    import requests
    try:
        url = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
        resp = requests.get(url, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            latest_version = data.get("tag_name", "")
            
            # Simple version comparison (e.g. v1.0.1 > v1.0.0)
            if latest_version and latest_version != CURRENT_VERSION:
                # Find the mac zip asset
                download_url = None
                for asset in data.get("assets", []):
                    if asset.get("name", "").endswith(".zip"):
                        download_url = asset.get("browser_download_url")
                        break
                        
                if download_url:
                    return {
                        "update_available": True,
                        "latest_version": latest_version,
                        "current_version": CURRENT_VERSION,
                        "download_url": download_url,
                        "release_notes": data.get("body", "")
                    }
                    
        return {
            "update_available": False,
            "current_version": CURRENT_VERSION
        }
    except Exception as e:
        logger.error("Failed to check for updates: %s", e)
        return {"update_available": False, "error": str(e)}


@app.post("/api/update/install")
async def api_update_install(request: Request):
    """Download the update and apply it."""
    import requests
    import tempfile
    import zipfile
    import sys
    import os
    import stat
    import threading
    
    body = await request.json()
    download_url = body.get("download_url")
    if not download_url:
        raise HTTPException(status_code=400, detail="download_url is required")
        
    def do_update():
        try:
            logger.info("Downloading update from %s", download_url)
            resp = requests.get(download_url, stream=True, timeout=30)
            resp.raise_for_status()
            
            with tempfile.TemporaryDirectory() as tmpdir:
                zip_path = os.path.join(tmpdir, "update.zip")
                with open(zip_path, "wb") as f:
                    for chunk in resp.iter_content(chunk_size=8192):
                        f.write(chunk)
                        
                logger.info("Extracting update...")
                with zipfile.ZipFile(zip_path, "r") as zip_ref:
                    zip_ref.extractall(tmpdir)
                    
                # Assume the zip contains a single folder or the .app bundle itself
                # For this script, we'll assume it's just the binary.
                # Since pyinstaller creates an executable, let's find the first executable file
                extracted_files = [os.path.join(tmpdir, f) for f in os.listdir(tmpdir) if f != "update.zip"]
                if not extracted_files:
                    logger.error("Update zip is empty")
                    return
                    
                new_binary = extracted_files[0]
                
                # If we are running in an .app bundle, sys.argv[0] might be inside the bundle
                # On macOS we can overwrite the binary in-place
                current_binary = os.path.abspath(sys.argv[0])
                
                logger.info("Replacing %s with %s", current_binary, new_binary)
                
                # Copy the new binary over the old one
                import shutil
                shutil.copy2(new_binary, current_binary)
                
                # Ensure executable permissions
                st = os.stat(current_binary)
                os.chmod(current_binary, st.st_mode | stat.S_IEXEC)
                
                logger.info("Restarting application...")
                os.execv(current_binary, [current_binary] + sys.argv[1:])
                
        except Exception as e:
            logger.error("Update failed: %s", e)

    # Run the update in a background thread so the HTTP response can complete
    threading.Thread(target=do_update, daemon=True).start()
    return {"status": "ok", "message": "Downloading update and restarting..."}


# ---------------------------------------------------------------------------
# Static files — serve the frontend
# ---------------------------------------------------------------------------

# Mount static files LAST so API routes take priority
static_dir = Path(__file__).parent / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
async def serve_index():
    """Serve the main page."""
    index_path = static_dir / "index.html"
    if not index_path.exists():
        return JSONResponse(
            status_code=404,
            content={"detail": "Frontend not found. Place index.html in static/"},
        )
    from fastapi.responses import FileResponse
    return FileResponse(str(index_path), media_type="text/html")
