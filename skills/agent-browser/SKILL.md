---
name: agent-browser
description: Use agent-browser CLI to automate and control a browser for testing, scraping, or any web task. Use this as a replacement for Playwright when agent-browser is available. Invoke when the user asks to browse, test, scrape, interact with, or automate a website.
---

# agent-browser CLI — Browser Automation Guide

`agent-browser` is a fast browser automation CLI for AI agents. It runs a local daemon and accepts commands to control a browser via CDP. Use it as a drop-in replacement for Playwright for interactive browser tasks.

## Setup (AIO Sandbox)

In the AIO Sandbox, Chrome is already running on CDP port 9222 and visible via VNC. Connect once per session:

```bash
agent-browser connect 9222
```

After connecting, all commands operate on that browser window. The user can see everything in the built-in VNC viewer at `http://localhost:8080/vnc/index.html?autoconnect=true`.

## Core Workflow

1. **Explore the page** — always start with a snapshot or annotated screenshot to understand the DOM
2. **Act** — click, type, fill, etc. using refs from the snapshot
3. **Verify** — take another snapshot or screenshot to confirm the result

```bash
# Navigate and inspect
agent-browser open https://example.com
agent-browser wait --load networkidle
agent-browser snapshot -i            # interactive elements only (best for AI)
agent-browser screenshot --annotate  # numbered labels — best for vision models

# Act using @ref from snapshot
agent-browser click @e2
agent-browser fill @e3 "search query"
agent-browser press Enter

# Verify
agent-browser snapshot -i
agent-browser screenshot result.png
```

## Command Reference

### Navigation
```bash
agent-browser open <url>      # Navigate
agent-browser back            # Browser back
agent-browser forward         # Browser forward
agent-browser reload          # Reload page
```

### Page Inspection (always use these first)
```bash
agent-browser snapshot                # Full accessibility tree with @refs
agent-browser snapshot -i             # Interactive elements only (recommended)
agent-browser snapshot -c             # Compact — removes empty structural elements
agent-browser snapshot -d <n>         # Limit tree depth
agent-browser snapshot -s <css>       # Scope to a CSS selector
agent-browser screenshot [path.png]   # Screenshot
agent-browser screenshot --full       # Full-page screenshot
agent-browser screenshot --annotate   # Numbered labels overlay (best for vision)
agent-browser get text <sel>          # Get text content
agent-browser get html <sel>          # Get inner HTML
agent-browser get value <sel>         # Get input value
agent-browser get attr <name> <sel>   # Get attribute
agent-browser get title               # Page title
agent-browser get url                 # Current URL
agent-browser get count <sel>         # Count matching elements
agent-browser get box <sel>           # Bounding box
```

### Interacting with Elements
Use `@ref` IDs from `snapshot` output (e.g., `@e1`, `@e2`) or CSS selectors.

```bash
agent-browser click <sel|@ref>
agent-browser dblclick <sel|@ref>
agent-browser type <sel|@ref> "text"          # Type (appends)
agent-browser fill <sel|@ref> "text"          # Clear then fill
agent-browser press <key>                     # Enter, Tab, Escape, Control+a, etc.
agent-browser keyboard type "text"            # Real keystrokes, no selector needed
agent-browser keyboard inserttext "text"      # Insert text without key events
agent-browser hover <sel|@ref>
agent-browser focus <sel|@ref>
agent-browser check <sel|@ref>
agent-browser uncheck <sel|@ref>
agent-browser select <sel|@ref> <value>       # Dropdown
agent-browser drag <src> <dst>                # Drag and drop
agent-browser upload <sel|@ref> <file>        # File upload
agent-browser download <sel|@ref> <path>      # Click to download
agent-browser scroll <up|down|left|right> [px]
agent-browser scrollintoview <sel|@ref>
```

### Finding Elements by Semantic Attributes
```bash
agent-browser find role button click --name "Submit"
agent-browser find text "Sign in" click
agent-browser find label "Email" fill "user@example.com"
agent-browser find placeholder "Search..." type "query"
agent-browser find testid "submit-btn" click
agent-browser find first button click
agent-browser find nth 2 input fill "value"
```

### Waiting
```bash
agent-browser wait <sel>              # Wait for element to appear
agent-browser wait <ms>               # Wait N milliseconds
agent-browser wait --load networkidle # Wait for network idle (slow pages)
agent-browser wait --load load        # Wait for load event
```

### State Checks
```bash
agent-browser is visible <sel>
agent-browser is enabled <sel>
agent-browser is checked <sel>
```

### JavaScript Execution
```bash
agent-browser eval "document.title"
agent-browser eval "window.scrollTo(0, document.body.scrollHeight)"
```

### Tabs
```bash
agent-browser tab new               # Open new tab
agent-browser tab list              # List open tabs
agent-browser tab <n>               # Switch to tab N
agent-browser tab close             # Close current tab
```

### Network Inspection & Control
```bash
agent-browser network requests                     # List recent requests
agent-browser network requests --filter "api/"     # Filter by URL pattern
agent-browser network route <url> --abort          # Block a URL
agent-browser network route <url> --body <json>    # Mock a response
agent-browser network unroute [url]                # Remove route
```

### Storage & Cookies
```bash
agent-browser cookies get
agent-browser cookies set <name> <value> --url <url>
agent-browser cookies clear
agent-browser storage local          # View localStorage
agent-browser storage session        # View sessionStorage
```

### Authentication
```bash
# Save and reuse login state
agent-browser auth save myapp --url https://example.com --username user --password pass
agent-browser auth login myapp

# Persist profile across restarts
agent-browser --profile ./browser-data open https://example.com

# Auto-save/restore session
agent-browser --session-name myapp open https://example.com
```

### Browser Settings
```bash
agent-browser set viewport 1920 1080
agent-browser set device "iPhone 15 Pro"
agent-browser set geo 52.3676 4.9041    # Amsterdam coordinates
agent-browser set offline on
agent-browser set headers '{"Authorization": "Bearer token"}'
agent-browser set media dark            # Dark mode
```

### Diffing / Regression Testing
```bash
agent-browser diff snapshot             # Compare current vs last snapshot (text diff)
agent-browser diff screenshot --baseline  # Compare current screenshot vs baseline
agent-browser diff url <url1> <url2>    # Compare two pages side by side
```

### Recording & Debugging
```bash
agent-browser record start recording.webm https://example.com
agent-browser record stop
agent-browser trace start trace.zip
agent-browser trace stop
agent-browser profiler start
agent-browser profiler stop profile.json
agent-browser console                   # View browser console logs
agent-browser errors                    # View JS errors
agent-browser pdf page.pdf              # Save page as PDF
agent-browser highlight <sel>           # Visually highlight element
agent-browser inspect                   # Open Chrome DevTools
agent-browser clipboard read
agent-browser clipboard write "text"
```

## Command Chaining (same daemon session)
```bash
# The daemon persists state between commands — chain with &&
agent-browser open https://example.com && \
  agent-browser wait --load networkidle && \
  agent-browser fill @e1 "user@test.com" && \
  agent-browser fill @e2 "password" && \
  agent-browser click @e3 && \
  agent-browser screenshot logged-in.png
```

## Key Flags
| Flag | Purpose |
|------|---------|
| `--cdp <port>` | Connect to existing Chrome via CDP |
| `--headed` | Show browser window (or `AGENT_BROWSER_HEADED=1`) |
| `--json` | JSON output (machine-readable) |
| `--full` | Full-page screenshot |
| `--annotate` | Annotated screenshot with numbered labels |
| `--profile <path>` | Persist cookies/storage across restarts |
| `--session-name <n>` | Auto-save/restore state by name |
| `--session <n>` | Isolated session |
| `--proxy <url>` | HTTP/HTTPS proxy |
| `--ignore-https-errors` | Skip cert validation |
| `--allow-file-access` | Allow `file://` URLs |
| `--allowed-domains <list>` | Restrict navigation |

## Config File (`~/.agent-browser/config.json`)
```json
{
  "cdp": "http://localhost:9222",
  "headed": true,
  "profile": "./browser-data",
  "screenshotDir": "./screenshots"
}
```

Priority: CLI flags > env vars > `./agent-browser.json` > `~/.agent-browser/config.json`

## Testing Patterns

### Form Submission
```bash
agent-browser open https://example.com/login
agent-browser snapshot -i
agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait --load networkidle
agent-browser screenshot after-login.png
```

### Search & Scrape
```bash
agent-browser open https://site.com
agent-browser wait --load networkidle
agent-browser snapshot -c              # Compact tree for LLM context
agent-browser get text .results        # Extract specific content
```

### Regression Screenshot Diff
```bash
# Capture baseline
agent-browser screenshot --full baseline.png

# Later, compare
agent-browser diff screenshot --baseline
```

### Intercept API Calls
```bash
agent-browser network route "*/api/users" --body '{"users":[]}'
agent-browser open https://app.com/dashboard
agent-browser screenshot mocked-dashboard.png
```

## vs Playwright

| Feature | agent-browser | Playwright |
|---------|--------------|-----------|
| Setup | `npm install -g agent-browser` | `npm install playwright` + codegen |
| Control | Shell commands / CLI | JS/TS/Python code |
| Snapshot | `snapshot -i` → @refs | `page.locator()` |
| Screenshots | `screenshot --annotate` | `page.screenshot()` |
| CDP connect | `connect 9222` | `chromium.connectOverCDP()` |
| Recording | `record start` | `--video on` |
| Network mock | `network route` | `page.route()` |
| Best for | AI agents, quick automation, shell scripts | Complex test suites, CI pipelines |
