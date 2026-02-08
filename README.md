# session-proxy

A local HTTP proxy that reuses browser session state for authenticated requests.

In automated workflows, downloading files behind authenticated sessions is painful — logins are interactive, cookies are browser-managed, and headless tools like `wget` or `curl` can't easily reproduce that state. **session-proxy** bridges the gap: log in once in a real browser, then let your scripts fetch protected resources through a local proxy.


## Install

```bash
npm install -g session-proxy
```

> **Prerequisite:** Playwright's Chromium browser is required. After installing, run:
>
> ```bash
> npx playwright install chromium
> ```


## Quick Start

**1. Initialize a session** — log in interactively and save the browser state:

```bash
session-proxy init --session my-site --url https://example.com/login
```

A browser window opens. Log in as you normally would, then close the browser. The session (cookies, storage) is saved to disk.

**2. Start the proxy server:**

```bash
session-proxy serve
```

**3. Fetch protected resources** using any HTTP client:

```bash
# Download a file
wget "http://localhost:8020/v1?session=my-site&url=https%3A%2F%2Fexample.com%2Fprotected%2Ffile.zip"

# Retrieve a page
curl "http://localhost:8020/v1?session=my-site&url=https%3A%2F%2Fexample.com%2Fdashboard"
```

> [!TIP]
> You can run `session-proxy init` on your local machine (where a headed browser is available), then copy the resulting session JSON file to a remote server or headless environment. This way, `session-proxy serve` can run on a machine without a display — only the one-time login needs a browser UI.


## CLI Reference

### `session-proxy init`

Initializes a session by opening an interactive browser login.

```
session-proxy init --session <name_or_path> --url <login_url> [--sessions-dir <path>]
```

| Flag | Alias | Description |
| --- | --- | --- |
| `--session` | `-s` | Name or path of the session file to create. |
| `--url` | `-u` | Login URL to open in the browser. |
| `--sessions-dir` | | Path to the sessions directory. |

**What happens:**

1. A Chromium window opens and navigates to the login URL.
2. You complete the login flow manually.
3. When you close the browser, session state (cookies, local/session storage) is captured and saved.

### `session-proxy serve`

Starts the proxy server.

```
session-proxy serve [--host <address>] [--port <port>] [--sessions-dir <path>]
```

| Flag | Alias | Default | Description |
| --- | --- | --- | --- |
| `--host` | `-H` | `127.0.0.1` | Address to listen on. Use `0.0.0.0` to listen on all interfaces. |
| `--port` | `-p` | `8020` | Port to bind the HTTP server to. |
| `--sessions-dir` | | *(see below)* | Path to the sessions directory. |

### Proxy Endpoint

```
GET /v1?session=<name>&url=<encoded_url>
```

| Parameter | Description |
| --- | --- |
| `session` | Session file name (resolved relative to the sessions directory) or absolute path. |
| `url` | URL-encoded target URL to fetch. |

**Behavior:**

- **File downloads** (non-HTML responses) are streamed directly to the client with original headers preserved, giving you real streaming performance.
- **Web pages** (HTML responses) are rendered through a full browser context via Playwright, returning the fully rendered HTML content.
- Cookies and session state are updated and persisted back to disk whenever the upstream response includes `Set-Cookie` headers or browser state changes.


## Configuration

### Sessions Directory

Session files are stored as JSON. The default directory is:

```
$XDG_STATE_HOME/session-proxy/sessions
```

which typically resolves to `~/.local/state/session-proxy/sessions`.

Override it with the `--sessions-dir` flag or the `SESSION_PROXY_SESSIONS_DIR` environment variable.

### Session Names

The `--session` / `session` parameter can be:

- **A bare name** — resolved relative to the sessions directory with `.json` appended (e.g., `my-site` → `~/.local/state/session-proxy/sessions/my-site.json`).
- **A relative path** — resolved relative to the sessions directory.
- **An absolute path** — used as-is.

### Environment Variables

All CLI parameters fall back to environment variables when not explicitly provided:

| Variable | Corresponds to | Default |
| --- | --- | --- |
| `SESSION_PROXY_SESSIONS_DIR` | `--sessions-dir` | `$XDG_STATE_HOME/session-proxy/sessions` |
| `SESSION_PROXY_HOST` | `--host` | `127.0.0.1` |
| `SESSION_PROXY_PORT` | `--port` | `8020` |

Resolution order: CLI flag → environment variable → built-in default.
