import { mkdir, readdir, readFile, writeFile, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright-core';

const storeUrl = 'https://store.galaxy-of-heroes.starwars.ea.com/';
const freeSection = '[test-id="free-gifts"]';
const cardSelector = '[test-id^="oid-"]';
const detailsSelector = 'div.fixed.inset-0[class~="backdrop-blur-[2px]"]:visible';
const priceSelector = '.price-text-shadow:visible';
const receiptSelector = '[test-id="after-purchase-modal"]:visible';
const freeLabel = /^(free|免费|免費)$/iu;
const claimLabel = /^(claim|领取|領取)$/iu;
const signInLabel = /^(log in|login|sign in|登录|登入|登入帳號)$/iu;
const accountPattern = /^[a-z0-9][a-z0-9-]{0,39}$/;
const offerPattern = /^oid-[a-z0-9][a-z0-9_.:-]{0,159}$/i;

function checkOrigin(page, origin) {
  if (new URL(page.url()).origin !== origin) {
    throw new Error('The browser left the store. Open the account profile to sign in.');
  }
}

async function isFree(container) {
  const price = container.locator(priceSelector);
  if (await price.count() !== 1) return false;
  const freeToken = price.locator(':scope > span.uppercase:visible');
  return await freeToken.count() === 1 &&
    freeLabel.test((await price.innerText()).trim()) &&
    freeLabel.test((await freeToken.innerText()).trim());
}

async function getFreeCards(section) {
  const cards = await section.locator(cardSelector + ':visible').all();
  const identities = new Set();
  const duplicates = new Set();
  for (const card of cards) {
    const id = await card.getAttribute('test-id');
    if (!offerPattern.test(id ?? '')) continue;
    if (identities.has(id)) duplicates.add(id);
    identities.add(id);
  }

  const eligible = [];
  for (const id of identities) {
    // Use an identity locator because card order can change after a rerender.
    const card = section.locator(`[test-id="${id}"]:visible`);
    if (duplicates.has(id) || await card.count() !== 1 || !await card.evaluate(element =>
      element.classList.contains('cursor-pointer') &&
      !element.classList.contains('cursor-not-allowed') &&
      element.getAttribute('aria-disabled') !== 'true'
    ) || !await isFree(card)) continue;

    // Preserve exact text from the selected card for matching the opened details.
    const titles = (await card.evaluate(element => {
      const parts = [element, ...element.querySelectorAll('h1,h2,h3,div,span')];
      return parts.filter(part => part.getClientRects().length && !part.closest('.price-text-shadow'))
        .flatMap(part => [...part.childNodes].filter(node => node.nodeType === Node.TEXT_NODE))
        .map(node => node.textContent.trim());
    })).filter(line => line.length > 3 && !freeLabel.test(line));
    if (titles.length) eligible.push({ id, card, titles });
  }
  return eligible;
}

export async function runStore(page, { claim = false, reserve, confirm, url = storeUrl } = {}) {
  const origin = new URL(url).origin;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  const section = page.locator(freeSection);
  const signIn = page.getByText(signInLabel, { exact: true }).first();
  try {
    await section.or(signIn).first().waitFor({ state: 'visible', timeout: 25_000 });
  } catch {
    checkOrigin(page, origin);
    throw new Error('The store did not show the free gifts section or a sign-in prompt.');
  }
  checkOrigin(page, origin);
  if (!await section.isVisible()) return { status: 'login-required', items: [] };

  const candidates = await getFreeCards(section);
  if (!claim) return { status: 'checked', items: candidates.map(({ id }) => ({ id })) };

  const items = [];
  for (const { id } of candidates) {
    checkOrigin(page, origin);
    const offer = (await getFreeCards(section)).find(row => row.id === id);
    if (!offer) continue;
    if (await page.locator(detailsSelector).count() !== 0 || await page.locator(receiptSelector).count() !== 0) {
      return { status: 'review-required', items };
    }

    await offer.card.click({ timeout: 8_000 });
    const modal = page.locator(detailsSelector);
    const claimButton = modal.getByRole('button', { name: claimLabel, exact: true });
    try {
      await claimButton.waitFor({ state: 'visible', timeout: 8_000 });
    } catch {
      return { status: 'review-required', items: [...items, { id, status: 'details-unverified' }] };
    }
    const modalLines = new Set((await modal.count() === 1 ? await modal.innerText() : '')
      .split('\n').map(line => line.trim().toUpperCase()));
    const sameOffer = offer.titles.some(line => modalLines.has(line.toUpperCase()));
    checkOrigin(page, origin);
    if (!sameOffer || !await isFree(modal) || !await claimButton.isEnabled()) {
      return { status: 'review-required', items: [...items, { id, status: 'details-unverified' }] };
    }

    if (reserve && !await reserve(id)) {
      return { status: 'review-required', items: [...items, { id, status: 'prior-outcome-unknown' }] };
    }

    try {
      await claimButton.click({ timeout: 8_000 });
      const receiptTitle = page.locator(receiptSelector).getByRole('heading', { level: 1 });
      await receiptTitle.waitFor({ state: 'visible', timeout: 15_000 });
      checkOrigin(page, origin);
      const receiptName = (await receiptTitle.innerText()).trim().toUpperCase();
      if (!offer.titles.some(title => title.toUpperCase() === receiptName)) {
        throw new Error('The receipt does not identify the selected offer.');
      }
    } catch {
      return { status: 'review-required', items: [...items, { id, status: 'outcome-unknown' }] };
    }

    await confirm?.(id);
    items.push({ id, status: 'confirmed' });
    // Refresh eligibility after confirming the preceding offer.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await section.waitFor({ state: 'visible', timeout: 25_000 });
  }
  return { status: items.length ? 'claimed' : 'no-free-offers', items };
}

async function profileDirectory(root, name, create = false) {
  if (!accountPattern.test(name ?? '') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name)) {
    throw new Error('Use an account alias of 1–40 lowercase letters, digits or hyphens.');
  }
  const directory = path.join(root, name);
  if (create) await mkdir(directory, { recursive: true });
  const info = await lstat(directory).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(`Profile "${name}" is missing. Run bluemilk webstore login ${name}.`);
  });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid profile directory.');
  return directory;
}

function outcomeJournal(directory) {
  const pending = path.join(directory, 'pending-claim.json');
  return {
    async reserve(id) {
      // Keep uncertain submissions across restarts. A separate offer can be
      // attempted only once the previous outcome has been reviewed.
      try {
        await writeFile(pending, JSON.stringify({ id, attemptedAt: new Date().toISOString() }), { flag: 'wx', flush: true });
        return true;
      } catch (error) {
        if (error.code === 'EEXIST') return false;
        throw error;
      }
    },
    async confirm() { await unlink(pending); },
    async review() {
      return JSON.parse(await readFile(pending, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return 'null';
        throw error;
      }));
    },
  };
}

const usage = 'bluemilk webstore login <profile> | list | inspect <profile|--all> | claim <profile|--all> | review <profile> | resolve <profile>';

export async function main(args) {
  const [command, name, ...extra] = args;
  if (!command || command === '--help') {
    console.log(usage);
    return 0;
  }
  if (extra.length || !['login', 'list', 'inspect', 'claim', 'review', 'resolve'].includes(command) ||
      (command === 'list' ? name !== undefined : name === undefined)) {
    throw new Error(usage);
  }
  const localData = process.env.LOCALAPPDATA;
  if (!localData) throw new Error('A Windows user profile is required.');
  const root = path.join(localData, 'BlueMilk Editor', 'webstore', 'profiles');
  await mkdir(root, { recursive: true });
  const aliases = async () => (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && accountPattern.test(entry.name)).map(entry => entry.name).sort();

  if (command === 'list') {
    console.log(JSON.stringify(await aliases()));
    return 0;
  }

  if (command === 'review' || command === 'resolve') {
    const directory = await profileDirectory(root, name);
    const journal = outcomeJournal(directory);
    const pending = await journal.review();
    if (command === 'resolve' && pending) await journal.confirm();
    console.log(JSON.stringify({ profile: name, pending, resolved: command === 'resolve' && pending !== null }));
    return 0;
  }

  const profiles = name === '--all' && ['claim', 'inspect'].includes(command) ? await aliases() : [name];
  if (!profiles.length) throw new Error('No configured profiles. Run bluemilk webstore login <profile>.');
  let exitCode = 0;
  for (const profile of profiles) {
    let context;
    try {
      const directory = await profileDirectory(root, profile, command === 'login');
      const journal = outcomeJournal(directory);
      if (command === 'claim' && await journal.review()) {
        console.log(JSON.stringify({ profile, status: 'review-required', items: [] }));
        exitCode = 1;
        continue;
      }
      const browserDirectory = path.join(directory, 'edge');
      const info = await lstat(browserDirectory).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (info && (!info.isDirectory() || info.isSymbolicLink())) {
        throw new Error('Invalid Edge profile directory.');
      }
      context = await chromium.launchPersistentContext(browserDirectory, {
        channel: 'msedge',
        headless: command !== 'login',
        locale: 'en-US',
        viewport: { width: 1440, height: 1000 },
      });
      const page = context.pages()[0] ?? await context.newPage();
      if (command === 'login') {
        const closed = once(context, 'close');
        await page.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        console.log('Sign in on the official store page, then close its browser window.');
        await closed;
        context = undefined;
        continue;
      }
      const result = await runStore(page, { claim: command === 'claim', ...journal });
      console.log(JSON.stringify({ profile, ...result }));
      if (['review-required', 'login-required'].includes(result.status)) exitCode = 1;
    } catch {
      // Browser errors may include redirect URLs or page text. Return a fixed message.
      console.log(JSON.stringify({ profile, status: 'failed',
        message: 'Could not open or verify the store. Check that the profile exists and its Edge window is closed.' }));
      exitCode = 1;
    } finally {
      await context?.close().catch(() => {});
    }
  }
  return exitCode;
}
