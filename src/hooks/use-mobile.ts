import { useMediaQuery } from '.';

/**
 * Below Tailwind's `md` breakpoint the sidebar becomes a sheet. Phones held sideways are often wider than
 * that but too short for a permanent sidebar, so short touch screens get the sheet as well.
 */
export function useIsMobile() {
  return useMediaQuery('(max-width: 767px), ((pointer: coarse) and (max-height: 500px))');
}
