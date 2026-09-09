import { Router } from 'express';
import { z } from 'zod';
import { many, one, type Db, type Queryable } from '../../lib/db.js';
import { ok } from '../../lib/response.js';

export interface PlaceRow {
  id: string;
  name: string;
  kind: 'PARKING_LOT' | 'APARTMENT' | 'BUILDING';
  address: string;
  lat: number | null;
  lng: number | null;
}

export function toPlaceDto(p: PlaceRow) {
  return { id: p.id, name: p.name, kind: p.kind, address: p.address, lat: p.lat, lng: p.lng };
}

export async function findPlace(q: Queryable, id: string): Promise<PlaceRow | null> {
  return one<PlaceRow>(q, 'select id, name, kind, address, lat, lng from places where id = $1', [id]);
}

export async function upsertPlace(q: Queryable, p: PlaceRow): Promise<void> {
  await q.query(
    `insert into places (id, name, kind, address, lat, lng) values ($1, $2, $3, $4, $5, $6)
     on conflict (id) do update set name = excluded.name, kind = excluded.kind, address = excluded.address,
       lat = excluded.lat, lng = excluded.lng, updated_at = now()`,
    [p.id, p.name, p.kind, p.address, p.lat, p.lng],
  );
}

const querySchema = z.object({ query: z.string().trim().max(100).optional() });

export function placesRouter(db: Db): Router {
  const r = Router();
  r.get('/places', async (req, res, next) => {
    try {
      const { query } = querySchema.parse(req.query);
      const rows = query
        ? await many<PlaceRow>(db, 'select id, name, kind, address, lat, lng from places where name ilike $1 or address ilike $1 order by name limit 50', [
            `%${query}%`,
          ])
        : await many<PlaceRow>(db, 'select id, name, kind, address, lat, lng from places order by name limit 50');
      ok(res, rows.map(toPlaceDto));
    } catch (err) {
      next(err);
    }
  });
  return r;
}
