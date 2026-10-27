#!/bin/bash
# GAcct suite holder: full unit+integration suite -> logs/waterarmy-gacct-suite.log
cd "$(dirname "$0")/.." || exit 1
node --test tests/unit/*.test.js tests/integration/*.test.js > logs/waterarmy-gacct-suite.log 2>&1
echo "exit=$?"
tail -10 logs/waterarmy-gacct-suite.log
