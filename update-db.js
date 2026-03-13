const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'local-game-db.json');
const COOKIES_PATH = path.join(__dirname, 'cookies.json');
const DELAY_MS = 4000;

// CLI args: --offset N --limit N
const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(name); return i !== -1 ? parseInt(args[i + 1]) : null; };
const OFFSET = getArg('--offset') ?? 0;
const LIMIT  = getArg('--limit')  ?? 1500;
const PATCH_PATH = path.join(__dirname, `db-patch-${OFFSET}.json`);

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function isManualEntry(url) { return url && url.startsWith('manual://'); }

function parseStatus(prefixLabel, pageTitle) {
  const t = ((prefixLabel || '') + ' ' + (pageTitle || '')).toLowerCase();
  if (t.includes('completed')) return 'completed';
  if (t.includes('abandoned')) return 'abandoned';
  if (t.includes('on hold') || t.includes('on-hold')) return 'on_hold';
  return 'active';
}

async function scrapeGame(page, f95Url) {
  await page.goto(f95Url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (page.url().includes('/login')) throw new Error('NOT_LOGGED_IN');

  const isDeleted = await page.evaluate(() => {
    const title = document.title.toLowerCase();
    if (title.includes('oops') || title.includes('error') || title.includes('page not found')) return true;
    if (!document.querySelector('h1.p-title-value')) return true;
    const msg = document.body?.innerText?.toLowerCase() || '';
    if (msg.includes('requested thread') && msg.includes('no longer available')) return true;
    return false;
  });
  if (isDeleted) return null;

  await delay(2000);

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

    function extractDateByLabel(label) {
      const regex = new RegExp(label.replace(/\s/g, '\\s*') + '\\s*[:\\-]?\\s*(\\d{4}-\\d{2}-\\d{2})', 'i');
      const m = document.body.innerText.match(regex);
      if (m) return m[1];
      const bolds = Array.from(document.querySelectorAll('b'));
      for (const b of bolds) {
        if (b.textContent?.trim().toLowerCase() === label.toLowerCase()) {
          let node = b.nextSibling;
          while (node && node.nodeType !== Node.TEXT_NODE) node = node.nextSibling;
          const raw = node?.textContent?.replace(/[:\s]+/, '').trim();
          if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
        }
      }
      return null;
    }
    const threadUpdated = extractDateByLabel('Thread Updated');
    const releaseDate0 = extractDateByLabel('Release Date');
    let releaseDate = null;
    if (threadUpdated && releaseDate0) {
      releaseDate = threadUpdated >= releaseDate0 ? threadUpdated : releaseDate0;
    } else {
      releaseDate = threadUpdated || releaseDate0;
    }

    const prefixLabel = document.querySelector('h1.p-title-value .label, .p-title .label')
      ?.textContent?.trim() || '';
    const pageTitle = document.title || '';

    return { version, releaseDate, prefixLabel, pageTitle };
  });
}

async function main() {
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  const db = JSON.parse(raw);
  const games = Array.isArray(db) ? db : db.games || [];

  const sevenDaysAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  // Filter first, then slice by offset/limit
  const candidates = games
    .filter(g => {
      if (!g.f95Url || isManualEntry(g.f95Url)) return false;
      if (g.status === 'completed') return false;
      if (g.status === 'abandoned') return false;
      return !g.metaUpdatedAt || g.metaUpdatedAt < sevenDaysAgo;
    })
    .sort((a, b) => (a.metaUpdatedAt || '') < (b.metaUpdatedAt || '') ? -1 : 1);

  const toUpdate = candidates.slice(OFFSET, OFFSET + LIMIT);

  console.log(`Total eligible: ${candidates.length} | Chunk: offset=${OFFSET} limit=${LIMIT} → ${toUpdate.length} games`);
  if (toUpdate.length === 0) {
    console.log('Nothing to do for this chunk.');
    return;
  }

  let cookies;
  if (process.env.F95ZONE_COOKIES) {
    cookies = JSON.parse(process.env.F95ZONE_COOKIES);
  } else if (fs.existsSync(COOKIES_PATH)) {
    cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
  } else {
    console.error('No cookies found (set F95_COOKIES env var or cookies.json)');
    process.exit(1);
  }
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setCookie(...cookies);
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

  const gameMap = Object.fromEntries(games.map((g, i) => [g.f95Url, i]));
  const patches = []; // only changed/checked entries

  for (const game of toUpdate) {
    console.log(`\nChecking: ${game.title}`);
    try {
      const result = await scrapeGame(page, game.f95Url);
      const idx = gameMap[game.f95Url];

      if (result === null) {
        console.log(`  ⚠️ Thread deleted or unavailable`);
        patches.push({ f95Url: game.f95Url, deleted: true, metaUpdatedAt: new Date().toISOString() });
        continue;
      }

      let newStatus = parseStatus(result.prefixLabel, result.pageTitle);
      if (newStatus === 'active' && (result.releaseDate || game.releaseDate)) {
        const rd = result.releaseDate || game.releaseDate;
        const days = (Date.now() - new Date(rd).getTime()) / (1000 * 60 * 60 * 24);
        if (days > 120) newStatus = 'abandoned';
      }

      patches.push({
        f95Url: game.f95Url,
        version: result.version || game.version,
        releaseDate: result.releaseDate || game.releaseDate,
        status: newStatus,
        metaUpdatedAt: new Date().toISOString(),
      });

      const changed = (result.version && result.version !== game.version) ||
        (result.releaseDate && result.releaseDate !== game.releaseDate) ||
        newStatus !== (game.status || 'active');
      console.log(`  status=${newStatus} version=${result.version || '?'} date=${result.releaseDate || '?'}${changed ? ' ✏️' : ''}`);

      await delay(DELAY_MS);
    } catch (e) {
      if (e.message === 'NOT_LOGGED_IN') {
        console.error('❌ Not logged in — aborting');
        await browser.close();
        process.exit(1);
      }
      console.error(`  ❌ Error: ${e.message}`);
      await delay(3000);
    }
  }

  await browser.close();

  fs.writeFileSync(PATCH_PATH, JSON.stringify(patches, null, 2));
  console.log(`\n✅ Chunk done. Wrote ${patches.length} entries to ${path.basename(PATCH_PATH)}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
