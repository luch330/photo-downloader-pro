#!/bin/zsh
cd "$(dirname "$0")"
if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. Install Node.js first."
  exit 1
fi
npm install
