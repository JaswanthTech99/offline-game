# Git account setup for this folder

## The requirement

> Create a folder for the game — an offline game folder — and set up new git
> credentials. Not `jaswanthmtilli`. Use this account **for this new folder only**;
> every other folder keeps using the previous account.
>
> Account (verified at setup time via `api.github.com/user`):
>
> - GitHub login: `JaswanthTech99`
> - Email: `jaswanthkumartech@gmail.com`
> - Token scopes: `read:org`, `repo`, `user:email`, `workflow`
> - Auth method: OAuth device flow — **no GitHub password is stored anywhere.
>   The token is the credential.**
>
> Other folders (e.g. `~/nudge`, `~/UIonly/nudge-1`, opened through code-server at
> `https://10.10.0.36:8102`) continue to use the `JaswanthTilli` account.

## What was done

| Setting | Value | Scope |
|---|---|---|
| `user.name` | `JaswanthTech99` | this repo (`--local`) |
| `user.email` | `jaswanthkumartech@gmail.com` | this repo (`--local`) |
| `credential.helper` | `""` then `store --file=.git/credentials-jaswanthtech99` | this repo (`--local`) |
| `credential.username` | `JaswanthTech99` | this repo (`--local`) |
| remote `origin` | `https://github.com/JaswanthTech99/offline-game.git` | this repo |
| `GH_CONFIG_DIR` | `./.gh-config` | via `use-tech99.sh` |

The GitHub repo `JaswanthTech99/offline-game` was created private with `main` as
the default branch.

## Why the isolation holds

1. **There is no global git config on this machine.** Every repo carries its own
   local `user.name` / `user.email`, so there is no shared identity to leak in
   either direction.
2. **The other repos use SSH remotes** (`git@github.com:tilli-pro/nudge.git`).
   HTTPS credentials configured here are never consulted for them.
3. **This repo's credential helper chain is reset first.** The empty
   `credential.helper` entry wipes the inherited chain before the store file is
   added, so the VS Code `JaswanthTilli` GitHub session cannot be used here.
4. **`gh` is logged in only under `./.gh-config`.** Run `gh auth status` anywhere
   outside this folder and it reports "not logged into any GitHub hosts", which is
   what it reported before this setup.
5. **`.vscode/settings.json` disables VS Code's GitHub auth injection** for this
   folder, so the Source Control panel and integrated terminal cannot substitute
   the other account's credentials.

## Secrets

The token lives in exactly two places, both outside version control:

- `.git/credentials-jaswanthtech99` — mode `600`, inside `.git`, so it can never
  be committed.
- `.gh-config/hosts.yml` — mode `700` directory, ignored via `.gitignore`.

`.gitignore` also blocks `credentials-*`, `*.token`, `.env*` and `.gh-config/`.

## Verifying

    cd /home/jaswanthm/offline-game

    git config --local --list | grep -E 'user\.|credential'   # -> JaswanthTech99
    git config --global --list                                # -> empty
    git log -1 --pretty='%an <%ae>'                           # -> JaswanthTech99

    source ./use-tech99.sh && gh auth status                  # -> JaswanthTech99
    env -u GH_CONFIG_DIR gh auth status                       # -> not logged in

## Known cosmetic issue

Commits show as **unlinked** on GitHub — no avatar, no contribution-graph credit —
because `jaswanthkumartech@gmail.com` is not yet a verified email on the
`JaswanthTech99` account. Add and verify it at
<https://github.com/settings/emails> and GitHub retroactively links existing
commits. Push access is unaffected either way.

## Opening this folder

    https://10.10.0.36:8102/?folder=/home/jaswanthm/offline-game
