import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AI_DISCLAIMER, NOTIFICATION_COPY, formatKrw, renderCopy } from '../../src/lib/copy.ko.js';

describe('copy.ko', () => {
  it('fixtures/copy.ko.json mirrors the runtime templates', () => {
    const json = JSON.parse(readFileSync(new URL('../../fixtures/copy.ko.json', import.meta.url), 'utf8')) as {
      notifications: Record<string, { title: string; body: string }>;
      labels: { aiDisclaimer: string };
    };
    expect(json.notifications).toEqual(NOTIFICATION_COPY);
    expect(json.labels.aiDisclaimer).toBe(AI_DISCLAIMER);
  });

  it('renders without leaking unknown placeholders and formats KRW', () => {
    expect(renderCopy('REWARD_SCHEDULED', { place: 'A주차장', amount: formatKrw(80_000) }).body).toBe('A주차장 사고 제보 보상 80,000원이 지급 예정 상태가 되었습니다. (데모)');
    expect(renderCopy('NO_CANDIDATE', {}).body).not.toContain('{');
  });
});
