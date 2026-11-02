import { chromium, type Locator } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// This stage-one probe always uses this project's own profile, never a user's Chrome profile.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = path.join(root, '.profile');
const executablePath = process.env.VCPC_CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
const context = await chromium.launchPersistentContext(profile, {
  ...(executablePath ? { executablePath } : {}),
  headless: process.env.VCPC_HEADED !== '1',
});
const visibleText = async (locator: Locator): Promise<string | null> => {
  if (await locator.count() !== 1 || !(await locator.isVisible())) return null;
  return (await locator.innerText()).trim() || null;
};
const number = (value: string | null): number | null => {
  if (!value || !/^\d[\d,]*$/.test(value)) return null;
  const parsed = Number(value.replaceAll(',', ''));
  return Number.isSafeInteger(parsed) ? parsed : null;
};
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto('https://vcpc.snakes.moe/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('body').waitFor({ state: 'visible', timeout: 15000 });
  const registration = await page.getByPlaceholder('给队伍起个名字').isVisible();
  const teamName = await visibleText(page.locator('.team-card__identity h2'));
  const seasonText = await visibleText(page.locator('#topbar-meta .topbar__chip').nth(0));
  const stage = await visibleText(page.locator('#topbar-meta .topbar__chip').nth(1));
  const seasonMatch = seasonText?.match(/^SEASON\s+(\d+)$/i);
  const rating = number(await visibleText(page.locator('#topbar-meta .topbar__rating b')));
  const tp = number(await visibleText(page.locator('#topbar-meta .topbar__tp b')));
  console.log(JSON.stringify({ observed_at: new Date().toISOString(), url: page.url(), browser_version: context.browser()?.version() ?? null, profile, phase: registration ? 'registration' : teamName ? 'lobby' : 'unknown', identity: { team_name: teamName, season: seasonMatch ? Number(seasonMatch[1]) : null, stage, rating, tp } }, null, 2));
} finally {
  await context.close();
}
