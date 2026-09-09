import { formatTimeKo } from '../../lib/copy.ko.js';

export const PROMPT_VERSION_V1 = 'v1';

export interface PromptIncident {
  placeName: string;
  occurredFrom: Date;
  occurredTo: Date;
  vehicleColor: string;
  vehicleModel: string;
  damageArea: string;
  description: string;
}

export const VICTIM_PHOTO_PLACEHOLDER = (index: number): string => `<@victim-photo-${index}>`;

/** Builds the v1 analysis prompt (BE_SPEC F6). `photoCount` placeholders are emitted for prompt_v2 media sources. */
export function buildPromptV1(incident: PromptIncident, photoCount: number, timeZone = 'Asia/Seoul'): string {
  const from = formatTimeKo(incident.occurredFrom, timeZone);
  const to = formatTimeKo(incident.occurredTo, timeZone);
  const lines = [
    '당신은 주차장 블랙박스 영상을 검토하는 보조 분석가입니다. 아래 사고 요청 정보를 바탕으로 영상에서 사고 후보 장면을 찾으세요.',
    '',
    '[사고 요청]',
    `- 장소: ${incident.placeName}`,
    `- 사고 추정 시간대: ${from}~${to} (현지 시각)`,
    `- 피해 차량: ${incident.vehicleColor} ${incident.vehicleModel}`,
    `- 신고된 파손 부위: ${incident.damageArea}`,
    `- 설명: ${incident.description}`,
  ];
  if (photoCount > 0) {
    const refs = Array.from({ length: photoCount }, (_, i) => VICTIM_PHOTO_PLACEHOLDER(i + 1)).join(' ');
    lines.push(`- 피해 차량 참고 사진: ${refs}`);
  }
  lines.push(
    '',
    '[지시]',
    '1. 영상에서 피해 차량으로 보이는 차량이 있는지, 다른 차량과 접촉·충돌·급정지·비정상 접근이 있는지 찾으세요.',
    '2. 가장 가능성이 높은 장면 하나의 시작 시각(초)을 incidentTimestampSeconds로 보고하세요. 사고 후보 장면이 없으면 incidentDetected=false로 두고 incidentTimestampSeconds는 0으로 두세요.',
    '3. victimVehicle, otherVehicle은 색상과 차종 위주로 간단히 묘사하세요. 번호판은 읽지 마세요.',
    '4. relevance는 사고 요청과 장면의 일치 정도이며 HIGH/MEDIUM/LOW 중 하나입니다.',
    '5. evidence에는 요청 정보와 일치하는 근거를 한국어로 2~4개 적으세요. 관찰한 사실만 적고 가해자·과실을 단정하지 마세요.',
    '6. 반드시 지정된 JSON 스키마로만 답하세요.',
  );
  return lines.join('\n');
}
