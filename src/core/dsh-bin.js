'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/** Resolve the DSH executable from explicit configuration, PATH, or common install locations. */
function findDshBin() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;

  const which = spawnSync('which', ['dsh'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();

  const candidates = [
    '/opt/homebrew/bin/dsh',
    '/usr/local/bin/dsh',
    path.join(os.homedir(), '.local', 'bin', 'dsh'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates.at(-1);
}

module.exports = { findDshBin };
