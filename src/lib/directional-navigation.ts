// Widgets that handle arrow keys themselves: the player, Radix menus and radio groups, the panel
// separator, and dnd-kit sortable handles (which move the picked-up item).
const OWNS_ARROW_KEYS =
  '.video-stage, [role="listbox"], [role="menu"], [role="radiogroup"], [role="radio"], [role="slider"], [role="separator"], [aria-roledescription="sortable"]';

/** Arrow keys move focus to the nearest focusable element in that direction (TV remotes, keyboards). */
export function handleDirectionalNavigation(event: KeyboardEvent) {
  if (event.defaultPrevented || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  const target = event.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && (target.isContentEditable || target.closest(OWNS_ARROW_KEYS)))
  )
    return;
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]'),
  ).filter((element) => element.offsetParent !== null && element.getAttribute('aria-hidden') !== 'true');
  if (!candidates.length) return;
  const current =
    document.activeElement instanceof HTMLElement && candidates.includes(document.activeElement)
      ? document.activeElement
      : undefined;
  if (!current) {
    candidates[0]!.focus();
    event.preventDefault();
    return;
  }
  const origin = current.getBoundingClientRect();
  const originX = origin.left + origin.width / 2;
  const originY = origin.top + origin.height / 2;
  let best: HTMLElement | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate === current) continue;
    const rectangle = candidate.getBoundingClientRect();
    const x = rectangle.left + rectangle.width / 2 - originX;
    const y = rectangle.top + rectangle.height / 2 - originY;
    const primary = event.key === 'ArrowLeft' ? -x : event.key === 'ArrowRight' ? x : event.key === 'ArrowUp' ? -y : y;
    if (primary <= 4) continue;
    const secondary = event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? Math.abs(y) : Math.abs(x);
    const score = primary + secondary * 2.5;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  if (best) {
    best.focus();
    best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    event.preventDefault();
  }
}
