# remimbers

Voice-capture spaced-repetition PWA. Static SPA (Vite + React 19 + TS) on GitHub
Pages at https://hgzech.github.io/remimbers/, Firestore + Cloud Functions behind it.
Design doc: `DESIGN.md` (kept in sync with the copy in ~/Nextcloud/Remimbers/).

## Git — Claude can push

Push access is configured via an SSH deploy key at `.git/remimbers_deploy_key`
(inside `.git`, so never committed). Repo-local config already set:

- `origin` = `git@github.com:hgzech/remimbers.git`
- `core.sshCommand` = `ssh -i .git/remimbers_deploy_key -o UserKnownHostsFile=.git/known_hosts -o IdentitiesOnly=yes`

So `git push` just works — no extra flags.

**Run git from this machine**, i.e. via Desktop Commander
(`mcp__remote-devices__Desktop_Commander__start_process`), which is a real macOS
shell with full network. The other two shells cannot push:

- the cloud container's `Bash`: its git proxy refuses by repository name *before*
  credentials, and SSH egress is blocked on both 22 and 443
- `device_bash`: mounted-folder Linux VM with no network at all

`firebase` and `gh` are also installed here, so function deploys
(`firebase deploy --only functions --project remimbers`) and PR/CI checks are
runnable from the same shell.

A push to `main` ships the live site via Pages CI.

Hilmar's preference: for small changes, commit and push automatically rather
than asking first.
