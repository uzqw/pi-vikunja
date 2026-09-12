# pi-vikunja

Pi extension that links a pi session to a [Vikunja](https://vikunja.io) task.

- `/vikunja <id|url>` — link this session to a task; the session name gets a
  `【#index-taskId title】` prefix
- `/vikunja <title>` — anything that is not a task id or `.../tasks/N` URL is
  treated as a title: a new task is created in `vikunja.defaultProjectId` and
  linked
- `/vikunja` — show current link status
- `/vikunja off` — unlink

On `agent_settled` (the agent finishes a run), a completion comment containing
the pi-web session URL and a snippet of the latest user message is appended to
the linked task. The task itself is **not** marked done.

Child sessions spawned via `spawn_session` / `spawn_subsession` inherit the
parent's link; `/fork` and `/clone` keep it via copied session entries.

## Install

```bash
pi install git:git@github.com:uzqw/pi-vikunja
# or for a local checkout
pi install /path/to/pi-vikunja
```

Or drop `extensions/vikunja-session.ts` into `~/.pi/agent/extensions/`.

## Configuration

Secrets live only in `~/.pi/agent/vikunja-session.json` (created with a
template on first run, mode 0600):

```json
{
  "vikunja": {
    "baseUrl": "https://vikunja.example.com/api/v1",
    "token": "tk_...",
    "defaultProjectId": 1
  },
  "authelia": {
    "baseUrl": "https://vikunja.example.com",
    "username": "...",
    "password": "..."
  },
  "piweb": {
    "baseUrl": "https://pi-web.example.com",
    "apiBase": "http://127.0.0.1:18504"
  }
}
```

- `vikunja`: Vikunja API base URL and an API token. `defaultProjectId` is the
  project that receives tasks auto-created via `/vikunja <title>`; without it,
  non-task arguments are rejected.
- `authelia`: only needed when the Vikunja site sits behind Authelia; the
  extension logs in via first-factor and retries on 302/303.
- `piweb.baseUrl`: browser-facing pi-web URL used in comment links.
- `piweb.apiBase`: pi-web API used to resolve project/workspace ids from the
  session cwd (longest path-prefix match, cached per cwd).
