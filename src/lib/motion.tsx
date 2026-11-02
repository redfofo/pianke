import type { ReactNode } from 'react';
import { LazyMotion } from 'motion/react';

const loadFeatures = () => import('./motion-features').then((module) => module.default);

/**
 * Animations render with `m.*` components; their features load after first paint. `strict` makes any
 * stray `motion.*` import (which would bundle every feature up front) throw during development.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={loadFeatures} strict>
      {children}
    </LazyMotion>
  );
}
