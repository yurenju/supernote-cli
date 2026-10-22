# supernote-cli

An unofficial command-line tool and TypeScript client for
[Supernote Cloud](https://cloud.supernote.com). List your folders, walk the
whole tree, download files or have the cloud render a `.note` notebook as PDF
or PNG, and upload, move, copy, rename or delete files.

> [!WARNING]
> Supernote Cloud has no public API. This tool uses an undocumented API that
> other people worked out by watching the Supernote web app, so it can break
> whenever Supernote changes its servers. It is not affiliated with or endorsed
> by Ratta or Supernote. Commands that change your cloud use the same
> undocumented API, so try them on a test folder first.

## Credits

This is a TypeScript port of
**[rnbennett/supernote-cloud](https://github.com/rnbennett/supernote-cloud)**
by Ryan Bennett, which is itself a maintained continuation of
**[julianprester/sncloud](https://github.com/julianprester/sncloud)**
by Julian Prester. The login flow, request signing, CSRF handling and
identity-verification steps all come from their work. See [NOTICE](NOTICE) for
the list of changes made in the port.

## Requirements

Node.js 22.18 or later. There are no runtime dependencies.

## Install

Run it straight from GitHub:

```bash
npx github:yurenju/supernote-cli --help
```

Or install it globally:

```bash
npm install -g github:yurenju/supernote-cli
```

Both build the TypeScript on install, then give you a `supernote` command.

## Authentication

Every command except `login` reads an **access token** from the
`SUPERNOTE_TOKEN` environment variable. The tool never writes the token
anywhere and never asks for your password outside `login`.

### 1. Get an access token

Run `login` on a machine you trust:

```bash
npx github:yurenju/supernote-cli login
```

It asks for your email and password. If Supernote Cloud does not recognise the
login, it emails you a 6-digit code, which you must enter within about two
minutes. The prompts go to stderr and only the token goes to stdout, so you can
pipe or copy it.

**Alternative: copy it from your browser.** Log in at
<https://cloud.supernote.com>, open the browser's developer tools, and copy the
value of the `x-access-token` cookie for `supernote.com`.

Tokens expire. When one does, every command fails with a message telling you to
log in again.

### 2. Provide the token

Store the token wherever you keep secrets, then expose it as `SUPERNOTE_TOKEN`.
The tool only ever reads it; putting it there is up to you.

**Plain environment variable**

```bash
export SUPERNOTE_TOKEN='eyJ...'
supernote ls
```

**1Password.** Save the token in an item (for example, a `token` field on an
item called `Supernote` in your `Private` vault), then let the 1Password CLI
inject it:

```bash
SUPERNOTE_TOKEN='op://Private/Supernote/token' op run -- supernote ls
```

**Docker Sandboxes.** A
[custom secret](https://docs.docker.com/ai/sandboxes/configuration/credentials/)
keeps the real token on the host: inside the sandbox, `SUPERNOTE_TOKEN` holds a
placeholder, and the sandbox proxy swaps in the real token on requests to
`cloud.supernote.com`. On the host:

```bash
sbx secret set-custom \
  --sandbox <sandbox-name> \
  --host cloud.supernote.com \
  --env SUPERNOTE_TOKEN \
  --command 'op read op://Private/Supernote/token'
```

Drop `--command` for `--value "$SUPERNOTE_TOKEN"` if you don't use 1Password.
`set-custom` is experimental in Docker Sandboxes, so check `sbx secret --help`
on your version. Run `login` on the host, not inside the sandbox; otherwise the
real token ends up inside the sandbox.

This is why the tool takes a token and not a password: the password is hashed
before it is sent, so a placeholder password could never be swapped for the
real one.

## Commands

```text
supernote login [--email <email>]       Log in and print an access token to stdout
supernote ls [path] [--json]            List a folder (default: root)
supernote walk [path]                   List every folder below path, recursively
supernote get <path> [-o dir] [--pdf | --png] [--pages 1,2]
                                        Download a file, or render a .note as PDF/PNG
supernote put <file>... <folder> [--force]
                                        Upload local files into a folder
supernote mkdir <path> [-p]             Create a folder
supernote rename <path> <new-name>      Rename a file or folder in place
supernote mv <path>... <folder>         Move files and folders into a folder
supernote cp <path>... <folder>         Copy files and folders into a folder
supernote rm <path>... [-r] [-y]        Delete files and folders
```

Paths start from the cloud root, for example `/Note/Inbox/meeting.note`.

```bash
supernote ls /Note
supernote walk /Note
supernote get /Note/Inbox/meeting.note -o ./downloads
supernote get /Note/Inbox/meeting.note --pdf --pages 1,3
supernote get /Note/Inbox/meeting.note --png          # meeting.note_1.png, meeting.note_2.png, …
```

`--pdf` and `--png` ask Supernote Cloud to render the notebook, so you don't
need to parse `.note` files yourself.

```bash
supernote put ./paper.pdf ./book.epub /Document
supernote put ./paper.pdf /Document --force   # replace /Document/paper.pdf
supernote mkdir -p /Document/2026/Q4
supernote rename /Note/Inbox/meeting.note standup.note
supernote mv /Note/Inbox/standup.note /Note/Archive
supernote cp /Note/Archive /Document
supernote rm /Note/Archive/old.note
supernote rm -r --yes /Document/Archive
```

The commands that change your cloud refuse rather than guess:

- Nothing is overwritten. `put`, `mkdir`, `rename`, `mv` and `cp` stop with
  an error when the target name is taken, before changing anything. Only
  `put --force` replaces a file: it renames the old one aside, uploads the new
  one, then deletes the old one, or renames it back if the upload fails. It
  never replaces a folder, and leaves a file whose content is already the
  same alone.
- The target of `put`, `mv` and `cp` is always the last argument and must be
  an existing folder; to change a name, use `rename`.
- `put` uploads files only, not local folders. Supernote Cloud accepts any
  file type, but your device opens only the types it supports.
- `rm` lists what it is about to delete and asks first. Run from a script or
  agent, with no terminal, it deletes only with `--yes`. A folder that still
  has contents needs `-r`.

Supernote Cloud itself behaves in ways worth knowing before you script it:

- **No folders at the top level.** Creating a folder directly under `/` is
  refused; make yours inside `/Document`, `/Note` and so on.
- **Taken names are renamed, not refused.** Uploading `a.pdf` or creating
  `Inbox` where one already exists gives you `a(1).pdf` or `Inbox(1)`. That is
  why this tool checks names itself before every write.
- **Each content is stored only once.** An upload is refused when the cloud
  already has a file with exactly the same bytes, in any folder, and even
  after that file was deleted. To have the same file in a second folder, use
  `cp`.

## Library

```ts
import { SupernoteClient } from "supernote-cli";

const client = new SupernoteClient({ accessToken: process.env.SUPERNOTE_TOKEN });

for await (const { path, files } of client.walk("/Note")) {
  for (const file of files) console.log(path, file.fileName, file.md5, file.updateTime);
}

await client.getPdf("/Note/Inbox/meeting.note", "./downloads");
await client.put(["./paper.pdf"], "/Document", { force: true });
```

Each item carries `md5` and `updateTime`, which is enough to download only what
changed since the last run.

## Development

```bash
npm install
npm test          # node --test, against a fake Supernote Cloud
npm run typecheck
npm run build     # compiles src/ to dist/
```

Node runs the TypeScript sources directly during development; `dist/` is only
for the installed `supernote` command.

To try a change against the real Supernote Cloud, put a token for a test
account in `.env.local` (it is gitignored) and run the sources with it. The
tool itself never reads this file; Node loads it into `SUPERNOTE_TOKEN`, so it
is a development convenience, not a place to keep your real token:

```bash
node --env-file=.env.local src/cli.ts ls /
```

`--env-file` never overrides a variable that is already set. Inside a Docker
Sandbox, `SUPERNOTE_TOKEN` already holds the sandbox's placeholder, so unset it
first:

```bash
env -u SUPERNOTE_TOKEN node --env-file=.env.local src/cli.ts ls /
```

## License

[Apache License 2.0](LICENSE), the same license as
[supernote-cloud](https://github.com/rnbennett/supernote-cloud) and
[sncloud](https://github.com/julianprester/sncloud).
