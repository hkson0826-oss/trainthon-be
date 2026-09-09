# Lumina Server

`BE_SPEC.md`(저장소 루트)를 구현하는 백엔드. Node 20+, TypeScript, Express 5, Supabase(Auth·Postgres·Storage), TwelveLabs.

## 실행

```bash
cd server
npm install
cp ../.env.example .env      # FILL 항목 채우기. server/.env 는 dev/start/migrate/seed 실행 시 자동 로드된다(기존 env 우선)
npm run migrate              # supabase/migrations/*.sql 적용 (서버 시작 시에도 자동 적용)
npm run dev                  # http://localhost:3001/api/v1
```

## 검증

```bash
npm run typecheck
npm test                     # PGlite(인프로세스 Postgres)로 마이그레이션·API를 실제 SQL로 검증. 외부 자격 증명 불필요
npm run build && npm start
```

## 구조

```text
src/
  index.ts              # bootstrap: env 검증 → 마이그레이션 → 서버
  app.ts                # express app 조립 (public / authed 라우터)
  config/env.ts         # zod env 검증. TWELVELABS_API_KEY는 AI_MODE=live일 때만 필수
  lib/{db,errors,response,logger}.ts
  db/migrate.ts         # SQL 마이그레이션 러너 (checksum 추적)
  middleware/{auth,requestId,errorHandler,rateLimit}.ts
  adapters/auth/        # Supabase JWT 검증 / 테스트용 static
  modules/config/       # F0  GET /config /health /ready
  modules/me/           # F1  GET|PATCH /me, profiles
supabase/migrations/    # 0001_core ...
test/                   # vitest + supertest + PGlite
```

구현 진행 상황과 남은 항목은 저장소 루트 `BE_SPEC.md` §8 순서를 따른다.
