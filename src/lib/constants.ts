export type FollowUp = 'none' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export const FOLLOW_UPS: { key: FollowUp; label: string; days: number }[] = [
  { key: 'none', label: 'Never', days: 0 },
  { key: 'weekly', label: 'Weekly', days: 7 },
  { key: 'monthly', label: 'Monthly', days: 30 },
  { key: 'quarterly', label: 'Quarterly', days: 90 },
  { key: 'yearly', label: 'Yearly', days: 365 },
];

export type Circle = 'personal' | 'professional' | 'both';

export const CIRCLES: { key: Circle; label: string; color: string }[] = [
  { key: 'personal', label: 'Personal', color: '#e2445c' },
  { key: 'professional', label: 'Professional', color: '#0073ea' },
  { key: 'both', label: 'Both', color: '#784bd1' },
];
export const circleInfo = (key: string | null | undefined) => CIRCLES.find((c) => c.key === key);

export const CLOSENESS_LABELS =['Unset', 'Acquaintance', 'Casual', 'Friend', 'Good friend', 'Inner circle'];

export type Stage = 'lead' | 'contacted' | 'meeting' | 'proposal' | 'negotiation' | 'won' | 'lost';

/** Pipeline stages, in lifecycle order. Colors are the board's status-pill colors. */
export const STAGES: { key: Stage; label: string; color: string }[] = [
  { key: 'lead', label: 'New lead', color: '#579bfc' },
  { key: 'contacted', label: 'Contacted', color: '#a25ddc' },
  { key: 'meeting', label: 'Meeting set', color: '#fdab3d' },
  { key: 'proposal', label: 'Proposal sent', color: '#ff7575' },
  { key: 'negotiation', label: 'Negotiating', color: '#ffcb00' },
  { key: 'won', label: 'Won', color: '#00c875' },
  { key: 'lost', label: 'Lost', color: '#c4c4c4' },
];

export type Priority = 'low' | 'medium' | 'high' | 'critical';

export const PRIORITIES: { key: Priority; label: string; color: string }[] = [
  { key: 'low', label: 'Low', color: '#579bfc' },
  { key: 'medium', label: 'Medium', color: '#5559df' },
  { key: 'high', label: 'High', color: '#401694' },
  { key: 'critical', label: 'Critical ⚠', color: '#333333' },
];

export const SOURCE_LABELS: Record<string, string> = {
  phone: 'Phone contacts',
  google: 'Google / Gmail',
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  facebook: 'Facebook',
  discord: 'Discord',
  manual: 'Added manually',
};

export const stageInfo = (key: string | null | undefined) => STAGES.find((s) => s.key === key);
export const priorityInfo = (key: string | null | undefined) => PRIORITIES.find((p) => p.key === key);
