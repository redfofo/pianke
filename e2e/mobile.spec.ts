import { expect, test } from './fixtures';

test('phone layout: bottom tabs, source chips and continuous scrolling', async ({ page, api }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '主导航（底部）' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeHidden();
  await expect(page.getByRole('navigation', { name: '切换来源' })).toBeVisible();
  await expect(page.locator('.cover-grid .media-card')).toHaveCount(24);
  await expect(page.getByRole('navigation', { name: '分页' })).toHaveCount(0);

  await page.locator('.load-more').scrollIntoViewIfNeeded();
  await expect(page.locator('.cover-grid .media-card')).toHaveCount(48);
  expect(api.browse.slice(0, 2)).toEqual(['alpha:hot:1', 'alpha:hot:2']);

  await page.getByRole('navigation', { name: '切换来源' }).getByRole('link', { name: '乙来源' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '乙来源' })).toBeVisible();

  await page.getByRole('navigation', { name: '主导航（底部）' }).getByRole('link', { name: '设置' }).click();
});
