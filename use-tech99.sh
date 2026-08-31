#!/usr/bin/env bash
# source this file (do not execute) to scope gh + git to the JaswanthTech99 account
# usage:  source ./use-tech99.sh
GAME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export GH_CONFIG_DIR="$GAME_DIR/.gh-config"
export GIT_AUTHOR_NAME="JaswanthTech99"
export GIT_AUTHOR_EMAIL="jaswanthkumartech@gmail.com"
export GIT_COMMITTER_NAME="JaswanthTech99"
export GIT_COMMITTER_EMAIL="jaswanthkumartech@gmail.com"
echo "gh/git scoped to JaswanthTech99 (GH_CONFIG_DIR=$GH_CONFIG_DIR)"
