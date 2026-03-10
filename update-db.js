const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'local-game-db.json');
const COOKIES_PATH = path.join(__dirname, 'cookies.json');
const MAX_GAMES_PER_RUN = 150;
const DELAY_MS = 8000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeF95Url(url) {
  if (!url) return '';
  return url.replace(/\/+$/, '').toLowerCase().trim();
}

async function scrapeGame(page, f95Url) {
  await page.goto(f95Url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  if (page.url().includes('/login')) throw new Error('NOT_LOGGED_IN');

  const pageTitle = await page.title();
  if (pageTitle.toLowerCase().includes('oops') || pageTitle.toLowerCase().includes('error')) {
    return null;
  }

  await delay(5000);

  return await page.evaluate(() => {
    let version = null;
    const versionBold = Array.from(document.querySelectorAll('.bbWrapper b'))
      .find(b => b.textContent?.trim().toLowerCase() === 'version');
    if (versionBold) {
      let node = versionBold.nextSibling;
      while (node) {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent?.replace(/^[\s:]+/, '').trim();
          if (text) { version = text; break; }
        }
        node = node.nextSibling;
      }
    }

    let releaseDate = null;
    const match = document.body.innerText.match(/Release\s*Date\s*[:\-]?\s*(\d{4}-\d{2}-\d{2})/i);
    if (match) releaseDate = match[1];

    return { version, releaseDate };
  });
}

async function main() {
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  const db = JSON.parse(raw);
  const games = Array.isArray(db) ? db : db.games || [];

  console.log(`Total games in DB: ${games.length}`);

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const toUpdate = games
    .filter(g => g.f95Url && (!g.metaUpdatedAt || g.metaUpdatedAt < sevenDaysAgo))
    .sort((a, b) => (a.metaUpdatedAt || '') < (b.metaUpdatedAt || '') ? -1 : 1)
    .slice(0, MAX_GAMES_PER_RUN);

  console.log(`Games to update this run: ${toUpdate.length}`);
  if (toUpdate.length === 0) {
    console.log('All games are fresh. Nothing to do.');
    return;
  }

  const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await page.setCookie(...cookies);
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

  let updatedCount = 0;
  const gameMap = Object.fromEntries(games.map((g, i) => [normalizeF95Url(g.f95Url), i]));

  for (const game of toUpdate) {
    console.log(`\nChecking: ${game.title}`);
    try {
      const result = await scrapeGame(page, game.f95Url);
      const idx = gameMap[normalizeF95Url(game.f95Url)];

      if (!result) {
        console.log('  ⚠️ Thread deleted or unavailable — marking as checked');
        games[idx].metaUpdatedAt = new Date().toISOString();
        continue;
      }

      let changed = false;
      if (result.version && result.version !== games[idx].version) {
        console.log(`  Version: ${games[idx].version} → ${result.version}`);
        games[idx].version = result.version;
        changed = true;
      }
      if (result.releaseDate && result.releaseDate !== games[idx].releaseDate) {
        console.log(`  Release date: ${games[idx].releaseDate} → ${result.releaseDate}`);
        games[idx].releaseDate = result.releaseDate;
        changed = true;
      }

      games[idx].metaUpdatedAt = new Date().toISOString();
      if (changed) updatedCount++;
      else console.log('  No changes');

      await delay(DELAY_MS);
    } catch (e) {
      if (e.message === 'NOT_LOGGED_IN') {
        console.error('❌ Not logged in to F95Zone — aborting');
        await browser.close();
        process.exit(1);
      }
      console.error(`  ❌ Error: ${e.message}`);
      await delay(3000);
    }
  }

  await browser.close();

  const output = Array.isArray(db) ? games : { ...db, games };
  fs.writeFileSync(DB_PATH, JSON.stringify(output, null, 2));
  console.log(`\n✅ Done. Updated ${updatedCount} games, checked ${toUpdate.length} total.`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
