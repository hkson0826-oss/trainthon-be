import { many, one, type Queryable } from '../../lib/db.js';

export type IncidentType = 'HIT_AND_RUN' | 'CONTACT' | 'DAMAGE' | 'OTHER';
export type IncidentStatus = 'DRAFT' | 'OPEN' | 'COLLECTING' | 'REVIEWING' | 'ADOPTED' | 'CLOSED_NO_EVIDENCE' | 'CANCELLED';

export interface IncidentRow {
  id: string;
  requester_id: string;
  place_id: string;
  type: IncidentType;
  occurred_from: Date;
  occurred_to: Date;
  vehicle_color: string;
  vehicle_model: string;
  damage_area: string;
  description: string;
  status: IncidentStatus;
  review_mode: string;
  matched_witness_count: number;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface IncidentWithPlace extends IncidentRow {
  place_name: string;
  place_kind: string;
  place_address: string;
  place_lat: number | null;
  place_lng: number | null;
}

export interface IncidentPhotoRow {
  id: string;
  incident_id: string;
  object_path: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  position: number;
}

const SELECT_WITH_PLACE = `
  select i.*, p.name as place_name, p.kind as place_kind, p.address as place_address, p.lat as place_lat, p.lng as place_lng
    from incidents i join places p on p.id = i.place_id`;

export async function insertIncident(
  q: Queryable,
  i: {
    id: string;
    requesterId: string;
    placeId: string;
    type: IncidentType;
    occurredFrom: Date;
    occurredTo: Date;
    vehicleColor: string;
    vehicleModel: string;
    damageArea: string;
    description: string;
  },
): Promise<IncidentRow> {
  const row = await one<IncidentRow>(
    q,
    `insert into incidents (id, requester_id, place_id, type, occurred_from, occurred_to, vehicle_color, vehicle_model, damage_area, description, status, published_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'OPEN', now()) returning *`,
    [i.id, i.requesterId, i.placeId, i.type, i.occurredFrom, i.occurredTo, i.vehicleColor, i.vehicleModel, i.damageArea, i.description],
  );
  if (!row) throw new Error('insertIncident returned no row');
  return row;
}

export async function insertIncidentPhoto(
  q: Queryable,
  p: { incidentId: string; objectPath: string; mime: string; bytes: number; width: number | null; height: number | null; sha256: string; position: number },
): Promise<void> {
  await q.query(
    `insert into incident_photos (incident_id, object_path, mime, bytes, width, height, sha256, position) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [p.incidentId, p.objectPath, p.mime, p.bytes, p.width, p.height, p.sha256, p.position],
  );
}

export async function findIncident(q: Queryable, id: string): Promise<IncidentWithPlace | null> {
  return one<IncidentWithPlace>(q, `${SELECT_WITH_PLACE} where i.id = $1`, [id]);
}

export async function listIncidentsByRequester(q: Queryable, requesterId: string): Promise<IncidentWithPlace[]> {
  return many<IncidentWithPlace>(q, `${SELECT_WITH_PLACE} where i.requester_id = $1 order by i.created_at desc limit 100`, [requesterId]);
}

export async function listPhotos(q: Queryable, incidentId: string): Promise<IncidentPhotoRow[]> {
  return many<IncidentPhotoRow>(q, 'select * from incident_photos where incident_id = $1 order by position', [incidentId]);
}

export async function updateIncidentStatus(q: Queryable, id: string, from: IncidentStatus[], to: IncidentStatus): Promise<boolean> {
  const r = await q.query(`update incidents set status = $2, updated_at = now() where id = $1 and status = any($3::text[]) returning id`, [id, to, from]);
  return r.rows.length > 0;
}
