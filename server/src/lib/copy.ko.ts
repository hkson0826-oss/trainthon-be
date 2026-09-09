/**
 * Korean copy for notifications (mirrors MOCK_DATA_AND_ASSETS.md §7).
 * Templates never include names, contacts or plate numbers.
 */

export type NotificationType = 'WITNESS_REQUEST' | 'CANDIDATE_FOUND' | 'NO_CANDIDATE' | 'ADOPTION_UPDATED' | 'REWARD_SCHEDULED';

export const NOTIFICATION_COPY: Record<NotificationType, { title: string; body: string }> = {
  WITNESS_REQUEST: {
    title: '목격 영상 확인 요청',
    body: '{date} {from}~{to} {place}에서 사고가 있었습니다. 당시 블랙박스 영상이 있다면 확인해 주세요.',
  },
  CANDIDATE_FOUND: {
    title: '사고 후보 영상 발견',
    body: '{place} 사고에 대한 후보 영상이 발견되었습니다. {timestampLabel} 지점을 확인해 보세요.',
  },
  NO_CANDIDATE: {
    title: '관련 장면 없음',
    body: '{place} 사고에 제보된 영상에서 관련 장면을 찾지 못했습니다. 다른 제보를 기다리고 있습니다.',
  },
  ADOPTION_UPDATED: {
    title: '증거 채택 결과',
    body: "제출한 영상이 보험사 검토에서 '{decisionLabel}' 처리되었습니다. (데모)",
  },
  REWARD_SCHEDULED: {
    title: '보상 지급 예정',
    body: '{place} 사고 제보 보상 {amount}원이 지급 예정 상태가 되었습니다. (데모)',
  },
};

export const AI_DISCLAIMER = 'AI 결과는 사고 사실·가해 차량·과실을 확정하지 않습니다. 원본 영상과 함께 사람이 확인해야 합니다.';

export function renderCopy(type: NotificationType, vars: Record<string, string | number>): { title: string; body: string } {
  const tpl = NOTIFICATION_COPY[type];
  const body = tpl.body.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
  return { title: tpl.title, body };
}

export function formatKrw(amount: number): string {
  return amount.toLocaleString('ko-KR');
}

export function formatDateKo(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('ko-KR', { timeZone, month: 'numeric', day: 'numeric' }).formatToParts(d);
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  return `${month}월 ${day}일`;
}

export function formatTimeKo(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('ko-KR', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

export function formatTimestampLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
