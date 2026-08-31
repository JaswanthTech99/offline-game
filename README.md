# Offline Game

A standalone offline game project.

## Git account

This folder is intentionally isolated from every other repo on this machine.
It commits and pushes as **JaswanthTech99 <jaswanthkumartech@gmail.com>** only.

- Identity is set in `.git/config` (local) — there is no global git identity on this box.
- HTTPS credentials come from `.git/credentials-jaswanthtech99` (mode 600, inside `.git`, never committed).
- The inherited credential helper chain is reset for this repo, so the VS Code
  `JaswanthTilli` GitHub session is never consulted here.
- All other repos (e.g. `~/nudge`, `~/UIonly/nudge-1`) use SSH + their own local
  identity and are completely unaffected.

## Using gh in this folder

    source ./use-tech99.sh
    gh auth status     # -> JaswanthTech99

That points `GH_CONFIG_DIR` at this folder's own `.gh-config`, so `gh` elsewhere
is unaffected.
