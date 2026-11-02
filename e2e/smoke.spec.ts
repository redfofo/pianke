import { expect, test } from './fixtures';

test('browse, open a drama, return to the cached list at the same scroll position', async ({ page, api }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: '甲来源' })).toBeVisible();
  await expect(page.locator('.cover-grid .media-card')).toHaveCount(24);
  expect(api.browse).toEqual(['alpha:hot:1']);

  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByRole('heading', { level: 3, name: '剧2-0', exact: true })).toBeVisible();
  await expect(page.getByText('第 2 / 3 页')).toBeVisible();

  await page.mouse.wheel(0, 900);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(300);
  const scrolled = await page.evaluate(() => scrollY);
  await page.getByRole('heading', { level: 3, name: '剧2-20', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: /详情/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '第1集' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.art-video-player')).toBeVisible();

  await page.goBack();
  await expect(page.getByRole('heading', { level: 3, name: '剧2-20', exact: true })).toBeVisible();
  // Served from the query cache: no extra request, and the scroll position is restored.
  expect(api.browse).toEqual(['alpha:hot:1', 'alpha:hot:2']);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(scrolled - 50);
});

test('switching episodes keeps the detail cached and updates the URL', async ({ page, api }) => {
  await page.goto('/watch/alpha?link=%2Fdrama%2Fx');
  await expect(page.getByRole('button', { name: '第1集' })).toHaveAttribute('aria-pressed', 'true');
  // React StrictMode mounts twice in development, which may cancel and repeat the first request.
  const initial = api.detail.length;
  expect(new Set(api.detail)).toEqual(new Set(['/drama/x']));
  await page.getByRole('button', { name: '第3集' }).click();
  await expect(page).toHaveURL(/episode=ep3/);
  await expect(page.getByRole('button', { name: '第3集' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '下一集' }).click();
  await expect(page).toHaveURL(/episode=ep4/);
  await expect(page.getByRole('button', { name: '第4集' })).toHaveAttribute('aria-pressed', 'true');
  expect(api.detail).toHaveLength(initial);
});

test('automatic next episode keeps the player in fullscreen', async ({ page }) => {
  await page.goto('/watch/alpha?link=%2Fdrama%2Fx');
  const player = page.locator('.art-video-player');
  await expect(player).toBeVisible();

  await page.locator('.art-control-fullscreenWeb').click();
  await expect(player).toHaveClass(/art-fullscreen-web/);

  await page.locator('video').dispatchEvent('ended');
  await expect(page).toHaveURL(/episode=ep2/);
  await expect(page.locator('video')).toHaveAttribute('aria-label', /第2集$/);
  await expect(player).toHaveClass(/art-fullscreen-web/);
  await expect(player).toBeVisible();
});

test('cross-source search groups results by source', async ({ page, api }) => {
  await page.goto('/search?q=逆袭');
  await expect(page.getByRole('heading', { level: 2, name: '甲来源' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: '乙来源' })).toBeVisible();
  await expect(page.getByText('共找到 48 个结果')).toBeVisible();
  expect(api.search.sort()).toEqual(['alpha:逆袭', 'beta:逆袭']);
});

test('dark theme can be chosen in settings and survives a reload', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('radio', { name: '深色' }).check({ force: true });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('radio', { name: '浅色' }).check({ force: true });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
});

test('remembers the last source as the default', async ({ page }) => {
  await page.goto('/?source=beta');
  await expect(page.getByRole('heading', { level: 1, name: '乙来源' })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: '乙来源' })).toBeVisible();
});

test('sources can be reordered from the keyboard and the order is used everywhere', async ({ page }) => {
  await page.goto('/settings');
  const rail = page.getByRole('navigation', { name: '内容来源' });
  await expect(rail.getByRole('link')).toHaveText([/甲来源/, /乙来源/]);

  const handle = page.getByRole('button', { name: '调整乙来源的顺序' });
  await handle.focus();
  await page.keyboard.press('Space');
  await expect(handle).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('status').filter({ hasText: '移到第 1 位' })).toBeAttached();
  await page.keyboard.press('Space');
  await expect(rail.getByRole('link')).toHaveText([/乙来源/, /甲来源/]);

  await page.reload();
  await expect(rail.getByRole('link')).toHaveText([/乙来源/, /甲来源/]);
});

test('the episode panel can be resized on wide screens', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/watch/alpha?link=%2Fdrama%2Fx');
  const panel = page.getByRole('complementary', { name: '剧集选择' });
  await expect(panel).toBeVisible();
  const before = (await panel.boundingBox())!.width;
  const separator = page.getByRole('separator', { name: '调整选集面板宽度' });
  await separator.focus();
  for (let step = 0; step < 5; step++) await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before + 20);

  // Narrow screens stack the list below the player instead.
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(separator).toHaveCount(0);
  await expect(panel).toBeVisible();
});
