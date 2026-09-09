# Lumina 데모 Mock 데이터·데이터셋·영상 자산 명세

작성일: 2026-09-09  
기준 문서: `MVP_scope.txt`, `MVP_PARKING_INCIDENT_EVIDENCE.md`, `BE_SPEC.md`, `FE_SPEC.md`  
목적: 데모에 필요한 **계정, seed 데이터, 사진, 블랙박스 영상, AI fixture, 알림 문구**를 한 곳에 정의해 BE·FE·발표자가 같은 값을 쓰게 한다.

모든 fixture 파일은 BE 저장소 `server/fixtures/`에 두고, FE는 mock API 모드에서 같은 JSON을 그대로 소비한다.

---

## 1. 무엇이 실제이고 무엇이 Mock인가

| 자산 | 성격 | 만드는 방법 |
|---|---|---|
| X·Y 데모 계정 | 실제 Supabase Auth 계정 | seed 스크립트가 Admin API로 생성 |
| 장소 `A주차장` | seed | SQL |
| Y 방문 이력 `13:58~14:12` | Mock(seed) | SQL. 실제 GPS 수집 없음 |
| X 피해 차량 사진 2장 | 실제 업로드용 이미지 자산 | 직접 촬영 또는 제작(§4) |
| Y 블랙박스 영상 약 20초 | Mock 영상, 실제 업로드·실제 분석 | 직접 촬영/편집(§5) |
| TwelveLabs 사전 분석 결과 | 실제 API로 얻은 결과를 저장 | 발표 전 실측(§6) |
| 보험사 채택·예치·보상 | Mock 상태 | 서버 상태값만 |
| 알림 문구 | 실제 생성 | 서버 템플릿(§7) |

---

## 2. 데모 계정

| 역할 | 표시 이름 | 이메일(예시) | role | 비고 |
|---|---|---|---|---|
| X 요청자 | 김피해 | `demo.requester@lumina.local` | `REQUESTER` | 사고 요청 등록, 발표자가 채택 버튼도 누름(DEMO_MODE) |
| Y 제보자 | 박목격 | `demo.witness@lumina.local` | `WITNESS` | 방문 이력 seed 보유, 영상 업로드 |
| 운영자(선택) | 운영자 | `demo.operator@lumina.local` | `OPERATOR` | 채택 API용. 데모 필수 아님 |

- 비밀번호는 `.env`의 `DEMO_ACCOUNT_PASSWORD`(BE seed)와 `NEXT_PUBLIC_DEMO_ACCOUNT_PASSWORD`(FE 전환 버튼)에 같은 값으로 둔다. 저장소에 실제 값을 커밋하지 않는다.
- Supabase Auth에서 이메일 확인(Confirm email)을 꺼두거나 seed에서 `email_confirm: true`로 생성한다.
- `fixtures/demo-accounts.json`

```json
{
  "requester": { "email": "demo.requester@lumina.local", "displayName": "김피해", "role": "REQUESTER", "notificationConsent": true },
  "witness":   { "email": "demo.witness@lumina.local",   "displayName": "박목격", "role": "WITNESS",   "notificationConsent": true, "payoutReady": true },
  "operator":  { "email": "demo.operator@lumina.local",  "displayName": "운영자", "role": "OPERATOR",  "notificationConsent": false }
}
```

---

## 3. DB seed (`supabase/seed/demo.sql` 또는 `scripts/seed-demo.ts`)

### 3.1 장소

| id(고정 UUID) | name | kind | address | lat | lng |
|---|---|---|---|---|---|
| `11111111-1111-4111-8111-111111111111` | A주차장 | `PARKING_LOT` | 서울특별시 강남구 테헤란로 000 지하 2층 | 37.5010 | 127.0396 |
| `11111111-1111-4111-8111-222222222222` | B아파트 지하주차장 | `APARTMENT` | 서울특별시 송파구 올림픽로 000 | 37.5145 | 127.1059 |

B는 "다른 장소 선택 시 알림 0건" 실패 흐름 확인용이다.

### 3.2 Y 방문 이력

| user | place | entered_at (KST) | exited_at (KST) | source |
|---|---|---|---|---|
| Y | A주차장 | `{DEMO_DATE} 13:58` | `{DEMO_DATE} 14:12` | `SEED` |

- `{DEMO_DATE}`는 seed 실행 시 `DEMO_DATE` env(기본: 실행 당일, `Asia/Seoul`)로 치환한다. 발표 당일 아침에 seed를 다시 실행하면 X가 "오늘 14:00~14:10"을 입력해도 겹친다.
- 저장은 UTC(`timestamptz`)로 한다. 예: KST 13:58 → `04:58Z`.
- `retain_until = entered_at + 30 days`.

### 3.3 seed 실행 규칙

- `npm run seed:demo` — 명시 실행만. 서버 시작 시 자동 실행 금지.
- 멱등: 계정은 있으면 skip, `places`·`visits`는 고정 UUID로 upsert.
- `npm run seed:demo -- --reset` 또는 `POST /demo/reset`: 데모 계정의 incidents/submissions/analyses/notifications/insurer_reviews/settlements 삭제 + Storage 데모 객체 삭제 + visits 재삽입. `places`는 유지.

---

## 4. X 피해 차량 사진 (2장)

파일 위치: `server/fixtures/media/victim-photos/`

| 파일 | 내용 | 규격 |
|---|---|---|
| `victim-01-rear-right.jpg` | 흰색 세단 우측 후면 범퍼의 긁힘·찍힘이 보이도록 45도 뒤에서 촬영 | JPEG, 1600×1200 이내, ≤ 3MB |
| `victim-02-side.jpg` | 같은 차량의 우측 측면 전체(색상·차종이 보이게) | JPEG, 1600×1200 이내, ≤ 3MB |

제작 지침

- 영상(§5)에 등장하는 **같은 흰색 세단**을 촬영한다. AI가 참고 이미지(`prompt_v2.media_sources`)와 영상 속 차량을 대조하기 때문이다.
- 번호판은 촬영 시 가리거나 후처리로 블러 처리한다(데모 화면에 그대로 노출됨).
- EXIF(GPS 포함)는 서버가 제거하지만, 자산 파일 자체도 `exiftool -all= file.jpg`로 미리 제거한다.
- 실차 촬영이 어려우면 동일 차량의 다른 각도 사진 대신 **영상에서 추출한 프레임**(`ffmpeg -ss 00:00:03 -i clip.mp4 -frames:v 1 victim-02-side.jpg`)을 써도 된다. 단 1장은 파손 부위가 보이는 실제 사진이어야 한다.

---

## 5. Y 블랙박스 Mock 영상 (기준 영상 1개 + 예비 2개)

파일 위치: `server/fixtures/media/dashcam/`

### 5.1 기술 규격 (TwelveLabs Analyze 입력 조건 + 모바일 업로드 조건)

| 항목 | 값 |
|---|---|
| 컨테이너/코덱 | MP4(H.264 High, AAC 또는 무음) — iOS Safari 재생·업로드 호환 |
| 길이 | **18~22초** (최소 4초, 최대 1시간 조건 충족) |
| 해상도 | 1280×720 또는 1920×1080 (360×360 이상, 5184×2160 이하) |
| 프레임 | 30fps, 고정 |
| 비트레이트 | 4~8Mbps → 파일 10~20MB (base64 fallback 상한 30MB 이하 유지) |
| 화면비 | 16:9 (1:1~1:2.4 범위) |
| 오디오 | 무음 또는 배경음. 음성 대화 없음 |
| 오버레이 | 블랙박스처럼 우하단 날짜·시각 자막(`2026-09-09 14:03:12`) — 사고 시각과 맞추면 설득력이 올라간다 |
| 메타데이터 | `creation_time`을 사고 시각대로 설정 가능(선택) |

### 5.2 연출 시나리오 (기준 영상 `dashcam-a-parking-01.mp4`)

X 요청과 정확히 대응해야 한다: **흰색 세단(피해) / 검은색 SUV(상대) / 우측 후면 접촉 / 후진 중 접촉**.

| 구간 | 장면 |
|---|---|
| 00:00~00:04 | 지하주차장, 정지 화면. 카메라(=Y 차량 블랙박스)는 흰색 세단을 대각선 뒤쪽에서 바라본다. 흰색 세단 우측 후면이 프레임 안에 있다 |
| 00:04~00:10 | 검은색 SUV가 우측에서 진입해 흰색 세단 옆 빈 칸으로 후진을 시작한다 |
| **00:11~00:13** | **SUV 후미가 흰색 세단 우측 후면에 닿는다(살짝 흔들림·브레이크등 점등).** 목표 타임스탬프 **12초** |
| 00:13~00:17 | SUV가 잠시 멈춘 뒤 전진해 자리를 이탈한다(뺑소니 연출) |
| 00:17~00:20 | 흰색 세단만 남은 정지 화면 |

촬영 방법(택 1)

1. **실차 촬영(권장)**: 실제 주차장에서 두 대의 차량으로 접촉 직전까지 접근(실제 접촉은 하지 않고 5cm 앞에서 정지 + 브레이크등). 카메라는 대시보드 높이에 고정. 모델은 "접촉한 것으로 보이는 장면"으로 묘사하므로 충분하다.
2. **미니어처/모형**: 1:18 다이캐스트(흰 세단·검은 SUV)와 주차장 배경 인쇄물. 카메라는 낮게 고정. AI가 장난감으로 인식할 수 있으므로 예비 영상으로만 둔다.
3. **스톡 영상 편집**: 라이선스 확인된 주차장 접촉 사고 클립을 20초로 자르고 자막 오버레이. 차량 색상·차종이 요청과 맞는 클립만 사용.

### 5.3 예비 영상

| 파일 | 목적 |
|---|---|
| `dashcam-a-parking-02.mp4` | 같은 장면을 다른 각도(정면 대각)에서 촬영. 기준 영상이 불안정할 때 대체 |
| `dashcam-a-parking-none.mp4` | 사고 없이 SUV가 정상 주차만 하는 20초 영상. **`incidentDetected=false` 실패 흐름** 시연·테스트용 |
| `dashcam-too-short.mp4` | 3초 영상. 422 `VIDEO_UNANALYZABLE` 확인용 |

### 5.4 편집·검증 명령

```bash
# 20초로 자르고 720p/30fps/H.264로 재인코딩, 자막 오버레이
ffmpeg -ss 00:00:05 -i raw.mp4 -t 20 \
  -vf "scale=1280:720,fps=30,drawtext=fontfile=/path/NotoSansKR-Regular.otf:text='%{pts\:localtime\:1788930180\:%Y-%m-%d %H\\\:%M\\\:%S}':x=w-tw-24:y=h-th-24:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.5" \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -b:v 6M -maxrate 8M -bufsize 12M \
  -c:a aac -b:a 96k -movflags +faststart \
  dashcam-a-parking-01.mp4

# 1788930180 = 2026-09-09 14:03:00 KST(UTC 05:03:00). 자막 시각은 촬영 머신의 TZ(Asia/Seoul) 기준으로 표시됨
# 조건 확인 (duration ≥ 4, 해상도, start_time)
ffprobe -v error -show_entries format=duration,start_time:stream=width,height,r_frame_rate,codec_name -of default=noprint_wrappers=1 dashcam-a-parking-01.mp4

# 무결성 값 (fixture의 videoSha256에 기록)
sha256sum dashcam-a-parking-01.mp4
```

- `start_time`이 0이 아니면 TwelveLabs `start_time/end_time` 계산에 영향을 주므로 `-movflags +faststart`와 재인코딩으로 0에 맞춘다.
- iPhone에 미리 넣는 방법: AirDrop 또는 iCloud Drive → 사진 보관함/파일 앱. 사진 보관함에 저장 시 iOS가 재인코딩하지 않는지(HEVC 변환 여부) 확인하고, 변환되면 **iPhone에 있는 파일의 sha256**을 fixture에 기록한다(PRERECORDED 매칭 키이기 때문).

### 5.5 발표 전 검증 절차 (MVP_scope §9)

1. 후보 영상 2~3개를 실제 TwelveLabs API로 각 2회 분석한다.
2. `incidentDetected=true`, `incidentTimestampSeconds`가 11~13초 안에서 안정적으로 나오는 영상을 **기준 영상**으로 확정한다.
3. 기준 영상의 결과를 §6 fixture로 저장한다.
4. 발표 당일 리허설에서 실제 호출 1회를 더 수행해 키·쿼터(무료 600분)·네트워크를 확인한다.

---

## 6. TwelveLabs fixture

### 6.1 응답 스키마 `fixtures/twelvelabs-schema.v1.json`

`BE_SPEC.md` F6의 JSON 스키마를 그대로 저장한다. 실제 호출에서 400이 나오면 수정한 최종 스키마로 덮어쓰고 `promptVersion`을 올린다.

### 6.2 사전 분석 결과 `fixtures/prerecorded/dashcam-a-parking-01.json`

실제 API 응답을 기반으로 서버 `result` 형식으로 저장한다. 손으로 지어내지 않는다.

```json
{
  "videoFileName": "dashcam-a-parking-01.mp4",
  "videoSha256": "<sha256sum 결과>",
  "provider": "twelvelabs",
  "model": "pegasus1.5",
  "promptVersion": "v1",
  "analyzedAt": "2026-09-0XT00:00:00Z",
  "rawResponse": { "data": "<원문 JSON 문자열>", "finish_reason": "stop", "usage": {} },
  "result": {
    "incidentDetected": true,
    "incidentTimestampSeconds": 12,
    "incidentTimestampLabel": "00:12",
    "victimVehicle": "흰색 세단",
    "otherVehicle": "검은색 SUV",
    "event": "검은색 SUV가 후진하며 흰색 세단 우측 후면에 접촉한 것으로 보이는 장면",
    "relevance": "HIGH",
    "evidence": [
      "피해 차량의 색상과 차종이 사고 요청과 일치",
      "신고된 파손 부위(우측 후면)와 접근 방향이 유사"
    ],
    "videoDurationSec": 20.0,
    "disclaimer": "AI 결과는 사고 사실·가해 차량·과실을 확정하지 않습니다. 원본 영상과 함께 사람이 확인해야 합니다."
  }
}
```

- `dashcam-a-parking-none.json`도 같은 형식으로 저장한다(`incidentDetected=false`, `incidentTimestampSeconds=null`).
- 서버는 공급자 장애 시에만 `videoSha256` 일치로 이 파일을 사용하고 `source="PRERECORDED"`를 붙인다(BE_SPEC F6).

### 6.3 프롬프트 입력 fixture `fixtures/incident-a-parking.json`

X가 폼에 입력할 값이자 테스트·mock API가 쓰는 값이다.

```json
{
  "placeId": "11111111-1111-4111-8111-111111111111",
  "placeName": "A주차장",
  "type": "HIT_AND_RUN",
  "occurredFrom": "{DEMO_DATE}T14:00:00+09:00",
  "occurredTo": "{DEMO_DATE}T14:10:00+09:00",
  "vehicle": { "color": "흰색", "model": "세단(아반떼)", "damageArea": "우측 후면 범퍼" },
  "description": "지하 2층에 주차하고 40분 뒤 돌아왔는데 우측 뒤 범퍼가 긁혀 있고 검은색 페인트가 묻어 있었습니다. 상대 차량은 없었습니다.",
  "photoFiles": ["victim-01-rear-right.jpg", "victim-02-side.jpg"],
  "consent": { "evidenceUse": true, "privacy": true }
}
```

---

## 7. 알림·상태 문구 템플릿 (`fixtures/copy.ko.json`)

| type | title | body |
|---|---|---|
| `WITNESS_REQUEST` | 목격 영상 확인 요청 | `{date} {from}~{to} {place}에서 사고가 있었습니다. 당시 블랙박스 영상이 있다면 확인해 주세요.` |
| `CANDIDATE_FOUND` | 사고 후보 영상 발견 | `{place} 사고에 대한 후보 영상이 발견되었습니다. {timestampLabel} 지점을 확인해 보세요.` |
| `NO_CANDIDATE` | 관련 장면 없음 | `{place} 사고에 제보된 영상에서 관련 장면을 찾지 못했습니다. 다른 제보를 기다리고 있습니다.` |
| `ADOPTION_UPDATED` | 증거 채택 결과 | `제출한 영상이 보험사 검토에서 '{decisionLabel}' 처리되었습니다. (데모)` |
| `REWARD_SCHEDULED` | 보상 지급 예정 | `{place} 사고 제보 보상 {amount}원이 지급 예정 상태가 되었습니다. (데모)` |

- 어떤 템플릿에도 X·Y의 이름, 연락처, 차량번호를 넣지 않는다.
- 금액 포맷은 `100,000원`.

---

## 8. 정산 Mock 값

| 항목 | 값 | env |
|---|---|---|
| 예치금 | 100,000원 | `DEMO_DEPOSIT_AMOUNT=100000` |
| 플랫폼 수수료 | 20,000원 | `DEMO_PLATFORM_FEE=20000` |
| 제보자 보상 | 80,000원(계산값) | – |
| 이의 제기 기간 | 72시간 | `DISPUTE_WINDOW_HOURS=72` |

화면에는 항상 `데모: 실제 결제·송금 없음`을 표시한다.

---

## 9. FE mock API 모드용 fixture (`fixtures/mock-api/`)

BE가 준비되기 전 FE 병행 개발용. 서버 DTO와 동일한 형태를 유지하고, BE가 완성되면 `openapi.yaml`과 대조해 갱신한다.

| 파일 | 내용 |
|---|---|
| `me.requester.json`, `me.witness.json` | `/me` 응답 |
| `places.json` | `/places` 응답(§3.1) |
| `incident.created.json` | `POST /incidents` 응답(`matching.matchedWitnessCount=1`, settlement `DEPOSITED`) |
| `incident.detail.requester.json` / `incident.detail.witness.json` | X용 / Y용 마스킹 DTO(`rewardPreview` 포함) |
| `notifications.witness.json` / `notifications.requester.json` | §7 템플릿 적용 결과 |
| `submission.uploading.json` → `submission.uploaded.json` → `submission.ready.json` | 상태 전이 순서대로 |
| `analysis.queued.json`, `analysis.analyzing.json`, `analysis.finalizing.json`, `analysis.ready.live.json`, `analysis.ready.prerecorded.json`, `analysis.failed.json`, `analysis.ready.none.json` | 분석 폴링 단계별 응답. FE는 순서대로 반환해 3단계 인디케이터를 검증 |
| `candidates.json` | `GET /incidents/:id/candidates` |
| `insurer.reviewing.json`, `insurer.adopted.json` | 채택 상태 |
| `settlement.deposited.json`, `settlement.payoutScheduled.json` | 정산 |
| `rewards.witness.json` | `/me/rewards` |

mock 모드에서 영상 재생 URL은 `public/mock/dashcam-a-parking-01.mp4`(FE 저장소 로컬 복사본)를 사용한다.

---

## 10. 자산 체크리스트

- [ ] `demo-accounts.json` + seed 스크립트로 X/Y 계정 생성 확인
- [ ] `A주차장` 장소, Y 방문 이력(`DEMO_DATE` 13:58~14:12) seed 확인
- [ ] 피해 차량 사진 2장(번호판 블러, EXIF 제거, ≤ 3MB)
- [ ] 기준 영상 `dashcam-a-parking-01.mp4`(18~22초, 720p 이상, ≤ 20MB, `start_time=0`) + sha256 기록
- [ ] 예비 영상 3개(`-02`, `-none`, `-too-short`)
- [ ] 기준 영상 실제 TwelveLabs 분석 2회 이상, 타임스탬프 11~13초 재현 확인
- [ ] `prerecorded/*.json`이 실제 응답 기반으로 저장됨(`rawResponse` 포함)
- [ ] iPhone 11에 영상·사진이 사진 보관함/파일 앱에 준비됨, iPhone 파일 sha256 = fixture 값
- [ ] `copy.ko.json` 템플릿에 개인정보 없음
- [ ] FE mock API fixture가 BE `openapi.yaml`과 일치
