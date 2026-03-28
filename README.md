# OpenClaw USOS PW Plugin

OpenClaw plugin for authenticated USOSWeb PW automation.

## Features

- CAS login to USOSWeb PW (`usos_login`)
- Generic authenticated HTTP requests (`usos_request`)
- Requests by `_action` only (`usos_action_request`)
- Endpoint discovery from page HTML (`usos_discover_endpoints`)
- Cached page state inspection (`usos_get_page_state`)
- Link navigation from cached state (`usos_click_link`)
- Form submission with hidden fields/tokens (`usos_submit_form`)
- In-memory session cleanup (`usos_logout`)

## Requirements

- OpenClaw with plugin support
- Node.js 22+

## Install From Source

```bash
cd openclaw-usos-pw-plugin
npm install
npm run build
openclaw plugins install .
openclaw gateway restart
```

## Install From CI Package

The GitHub Actions workflow builds a ready-to-install `.tgz` package.

```bash
openclaw plugins install ./openclaw-usos-pw-plugin-<version>.tgz
openclaw gateway restart
```

## CI Packaging

Workflow file: `.github/workflows/build-package.yml`

What it does:
- installs dependencies
- builds `dist/index.js`
- creates an npm package archive (`.tgz`)
- uploads the archive as a workflow artifact
- on `v*` tags, attaches the archive to the GitHub Release

## Example Usage

1. Login with `usos_login` and store `session_id`.
2. Fetch a page with `usos_request` or `usos_action_request`.
3. Inspect available links/forms via `usos_get_page_state`.
4. Navigate with `usos_click_link` or submit forms with `usos_submit_form`.
5. Repeat state inspection and navigation as needed.

## Security Notes

- Sessions are stored only in plugin process memory.
- Do not log credentials.
- Host is restricted to `usosweb.usos.pw.edu.pl`.
