import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { MediaCard } from './MediaCard';
import { useLibrary } from '../stores';

const item = {
  id: '1',
  sourceId: 'hongguo',
  link: '/drama/1',
  title: '逆袭人生',
  posterUrl: 'https://img.example/1.jpg',
};

afterEach(cleanup);
beforeEach(() => {
  useLibrary.setState({ favorites: [], recent: [] });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_path: string, init?: RequestInit) =>
      Response.json(init?.method === 'POST' ? { favorite: true } : { favorites: [], recent: [] }),
    ),
  );
});

const renderCard = (props: Partial<Parameters<typeof MediaCard>[0]> = {}) =>
  render(
    <MemoryRouter>
      <MediaCard item={item} {...props} />
    </MemoryRouter>,
  );

describe('MediaCard', () => {
  it('links to the watch page with the requested episode', () => {
    renderCard({ episodeId: 'e3' });
    expect(screen.getByRole('link').getAttribute('href')).toBe('/watch/hongguo?link=%2Fdrama%2F1&episode=e3');
  });

  it('falls back to a text cover when the poster fails', () => {
    const { container } = renderCard();
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('.cover-fallback')?.textContent).toContain('暂无封面');
  });

  it('toggles the favorite state', async () => {
    void useLibrary.getState().start();
    const { container } = renderCard({ note: '第 1 集' });
    expect(container.querySelector('.card-footer p')?.textContent).toBe('第 1 集');
    const button = screen.getByRole('button', { pressed: false });
    expect(button.getAttribute('aria-label')).toBe('收藏逆袭人生');
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true'));
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('取消收藏逆袭人生');
  });
});
