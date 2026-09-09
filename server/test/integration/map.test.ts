import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestContext, PLACE_A, TOKENS, type TestContext } from '../helpers/testApp.js';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestContext(); });
afterAll(async () => { await ctx.close(); });
const location = { name: '지도 검증 장소', address: '서울시 중구 테스트 위치', lat: 37.5665, lng: 126.978 };
function body(extra = {}) { return { location, type: 'CONTACT', occurredFrom: '2026-09-10T01:00:00Z', occurredTo: '2026-09-10T01:10:00Z',
  vehicle: { color: '흰색', model: '세단', damageArea: '범퍼' }, description: '지도 위치 저장 검증', photoObjectPaths: [], consent: { evidenceUse: true, privacy: true }, ...extra }; }

describe('authenticated incident map', () => {
  let id: string;
  it('requires login for map, detail and creation', async () => {
    expect((await request(ctx.app).get('/api/v1/incidents/map')).status).toBe(401);
    expect((await request(ctx.app).post('/api/v1/incidents').send(body())).status).toBe(401);
  });
  it('stores custom location atomically and returns the same coordinates on subsequent reads', async () => {
    const r = await request(ctx.app).post('/api/v1/incidents').set(bearer(TOKENS.requester)).send(body());
    expect(r.status).toBe(201);
    id = r.body.data.id;
    expect(r.body.data.place).toMatchObject(location);
    const stored = await ctx.db.query('select location_lat, location_lng, location_address from incidents where id = $1', [id]);
    expect(stored.rows[0]).toMatchObject({ location_lat: location.lat, location_lng: location.lng, location_address: location.address });
    const r2 = await request(ctx.app).get(`/api/v1/incidents/${id}`).set(bearer(TOKENS.stranger));
    expect(r2.status).toBe(200);
    expect(r2.body.data.place).toMatchObject(location);
    expect(r2.body.data).not.toHaveProperty('settlement');
    expect((await request(ctx.app).get(`/api/v1/incidents/${id}`)).status).toBe(401);
  });
  it('lists the report for every role without returning owner or evidence data', async () => {
    for (const token of Object.values(TOKENS)) {
      const r = await request(ctx.app).get('/api/v1/incidents/map').set(bearer(token));
      expect(r.status).toBe(200);
      expect(r.body.data.items.find((i: { id: string }) => i.id === id)).toMatchObject({ id, place: location });
      expect(r.body.data.items[0]).not.toHaveProperty('requesterId');
      expect(r.body.data.items[0]).not.toHaveProperty('photos');
    }
    for (const resource of ['candidates', 'settlement']) {
      expect((await request(ctx.app).get(`/api/v1/incidents/${id}/${resource}`).set(bearer(TOKENS.stranger))).status).toBe(404);
    }
  });
  it('filters the viewport and validates complete ordered bounds', async () => {
    const inside = await request(ctx.app).get('/api/v1/incidents/map?south=37&north=38&west=126&east=128').set(bearer(TOKENS.witness));
    expect(inside.body.data.items).toHaveLength(1);
    const outside = await request(ctx.app).get('/api/v1/incidents/map?south=0&north=1&west=0&east=1').set(bearer(TOKENS.witness));
    expect(outside.body.data.items).toHaveLength(0);
    for (const query of ['south=37', 'south=38&north=37&west=126&east=128', 'south=-91&north=38&west=126&east=128']) {
      expect((await request(ctx.app).get(`/api/v1/incidents/map?${query}`).set(bearer(TOKENS.witness))).status).toBe(400);
    }
  });
  it('rejects invalid location values before writing a place or report', async () => {
    for (const patch of [{ lat: 91 }, { lng: -181 }, { name: '' }, { address: '' }, { lat: '37.5' }]) {
      expect((await request(ctx.app).post('/api/v1/incidents').set(bearer(TOKENS.requester)).send(body({ location: { ...location, ...patch } }))).status).toBe(400);
    }
  });
  it('snapshots existing place coordinates and keeps drafts out of shared reads', async () => {
    const r = await request(ctx.app).post('/api/v1/incidents').set(bearer(TOKENS.requester)).send(body({ placeId: PLACE_A, location: undefined }));
    expect(r.status).toBe(201);
    await ctx.db.query('update places set lat = 1, lng = 2 where id = $1', [PLACE_A]);
    const read = await request(ctx.app).get(`/api/v1/incidents/${r.body.data.id}`).set(bearer(TOKENS.witness));
    expect(read.body.data.place.lat).toBe(37.501);
    await ctx.db.query("update incidents set status = 'DRAFT' where id = $1", [id]);
    expect((await request(ctx.app).get(`/api/v1/incidents/${id}`).set(bearer(TOKENS.stranger))).status).toBe(404);
    const list = await request(ctx.app).get('/api/v1/incidents/map').set(bearer(TOKENS.stranger));
    expect(list.body.data.items.some((i: { id: string }) => i.id === id)).toBe(false);
  });
});
