import type { Circle } from './constants';

const SOCIAL = new Set(['instagram', 'facebook', 'discord']);

/**
 * Best guess at personal vs professional when you haven't set it:
 * LinkedIn or the pipeline means professional, Instagram/Facebook/Discord means personal.
 * Phone and Gmail contacts could be either, so they don't count.
 */
export function inferCircle(sources: string[], inPipeline: boolean): Circle | null {
  const pro = inPipeline || sources.includes('linkedin');
  const personal = sources.some((s) => SOCIAL.has(s));
  return pro && personal ? 'both' : pro ? 'professional' : personal ? 'personal' : null;
}
