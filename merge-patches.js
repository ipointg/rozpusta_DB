/**
 * merge-patches.js
 * Reads all db-patch-*.json files (produced by parallel update-db jobs),
 * applies them to local-game-db.json, then deletes the patch files.
 *
 * Run from the repo root:
 *   node merge-patches.js
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'local-game-db.json');

const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
const games = Array.isArray(raw) ? raw : raw.games || [];

// Build a URL → index map for fast lookup
const gameMap = {};
for (let i = 0; i < games.length; i++) {
  if (games[i].f95Url) gameMap[games[i].f95Url] = i;
}

// Find all patch files
const patchFiles = fs.readdirSync(__dirname)
  .filter(f => /^db-patch-\d+\.json$/.test(f))
  .sort();

if (patchFiles.length === 0) {
  console.log('No patch files found — nothing to merge.');
  process.exit(0);
}

console.log(`Found ${patchFiles.length} patch file(s): ${patchFiles.join(', ')}`);

let totalApplied = 0;

for (const pf of patchFiles) {
  const fullPath = path.join(__dirname, pf);
  const patches = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));

  let fileApplied = 0;
  for (const patch of patches) {
    const idx = gameMap[patch.f95Url];
    if (idx === undefined) continue;

    const g = games[idx];
    if (patch.deleted) {
      g.deleted = true;
      g.metaUpdatedAt = patch.metaUpdatedAt;
    } else {
      if (patch.version)       g.version       = patch.version;
      if (patch.releaseDate)   g.releaseDate   = patch.releaseDate;
      if (patch.status)        g.status        = patch.status;
      if (patch.metaUpdatedAt) g.metaUpdatedAt = patch.metaUpdatedAt;
    }
    fileApplied++;
  }

  console.log(`  ${pf}: applied ${fileApplied} / ${patches.length} entries`);
  totalApplied += fileApplied;

  // Remove patch file after applying
  fs.unlinkSync(fullPath);
}

fs.writeFileSync(DB_PATH, JSON.stringify({ games }, null, 2));
console.log(`\n✅ Done. Applied ${totalApplied} patches. DB has ${games.length} games.`);
