import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { StorageAdapter } from '../../adapters/storage/index.js';
import type { Env } from '../../config/env.js';
import { audit } from '../../lib/audit.js';
import type { Db, Queryable } from '../../lib/db.js';
import { ApiError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { created, ok } from '../../lib/response.js';
import { currentUser, requireRole, type AuthedUser } from '../../middleware/auth.js';
import { runMatching } from '../matching/index.js';
import { findPlace, upsertPlace } from '../places/index.js';
import { createDeposit, findSettlementByIncident, toSettlementDto } from '../settlement/repo.js';
import { attachStagedPhotos, createPhotoUploadUrl, removeIncidentPhotos } from './photos.service.js';
import {
  findIncident,
  insertIncident,
  insertIncidentPhoto,
  listIncidentsByRequester,
  listMapIncidents,
  listPhotos,
  type IncidentPhotoRow,
  type IncidentWithPlace,
} from './repo.js';

export interface IncidentsDeps {
  env: Env;
  db: Db;
  storage: StorageAdapter;
  logger?: Logger;
  /** Filled in by the submissions module: per-incident evidence summary for DTOs. */
  submissionSummary?: (q: Queryable, incidentId: string, viewerId: string) => Promise<SubmissionSummary>;
}

export interface SubmissionSummary {
  total: number;
  ready: number;
  mySubmissionId: string | null;
}

const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

const createSchema = z
  .object({
    placeId: z.string().uuid().optional(),
    location: z.object({
      name: z.string().trim().min(1).max(200),
      address: z.string().trim().min(1).max(500),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    }).strict().optional(),
    type: z.enum(['HIT_AND_RUN', 'CONTACT', 'DAMAGE', 'OTHER']),
    occurredFrom: z.string().datetime({ offset: true }),
    occurredTo: z.string().datetime({ offset: true }),
    vehicle: z.object({
      color: z.string().trim().min(1).max(50),
      model: z.string().trim().min(1).max(100),
      damageArea: z.string().trim().min(1).max(100),
    }),
    description: z.string().trim().min(1).max(1000),
    photoObjectPaths: z.array(z.string().min(1).max(300)).max(10).default([]),
    consent: z.object({ evidenceUse: z.literal(true), privacy: z.literal(true) }),
  })
  .strict().refine((body) => body.placeId || body.location, { path: ['location'], message: 'Select an incident location' });

const mapQuerySchema = z.object({
  south: z.coerce.number().min(-90).max(90).optional(),
  north: z.coerce.number().min(-90).max(90).optional(),
  west: z.coerce.number().min(-180).max(180).optional(),
  east: z.coerce.number().min(-180).max(180).optional(),
}).strict().refine((b) => {
  const values = [b.south, b.north, b.west, b.east];
  return values.every((v) => v === undefined) || (values.every((v) => v !== undefined) && b.south! <= b.north! && b.west! <= b.east!);
}, { message: 'Provide all four ordered map bounds' });

const uploadUrlSchema = z.object({ mime: z.string().min(1).max(100), bytes: z.number().int().positive() }).strict();

function placeDto(i: IncidentWithPlace) {
  return { id: i.place_id, name: i.place_name, kind: i.place_kind, address: i.place_address, lat: i.place_lat, lng: i.place_lng };
}

export async function ownerIncidentDto(deps: IncidentsDeps, q: Queryable, i: IncidentWithPlace, viewer: AuthedUser, opts: { withPhotos: boolean }) {
  const photos = opts.withPhotos ? await signPhotos(deps, q, viewer.id, i.id, await listPhotos(q, i.id)) : undefined;
  const settlement = await findSettlementByIncident(q, i.id);
  const summary = deps.submissionSummary ? await deps.submissionSummary(q, i.id, viewer.id) : { total: 0, ready: 0, mySubmissionId: null };
  return {
    id: i.id,
    status: i.status,
    reviewMode: i.review_mode,
    type: i.type,
    place: placeDto(i),
    occurredFrom: i.occurred_from.toISOString(),
    occurredTo: i.occurred_to.toISOString(),
    vehicle: { color: i.vehicle_color, model: i.vehicle_model, damageArea: i.damage_area },
    description: i.description,
    ...(photos ? { photos } : {}),
    matchedWitnessCount: i.matched_witness_count,
    submissions: { total: summary.total, ready: summary.ready },
    settlement: settlement ? toSettlementDto(settlement) : null,
    publishedAt: i.published_at ? i.published_at.toISOString() : null,
    createdAt: i.created_at.toISOString(),
    updatedAt: i.updated_at.toISOString(),
  };
}

/** Y-facing DTO: no requester identity/contact, summarised description, reward preview. */
export async function witnessIncidentDto(deps: IncidentsDeps, q: Queryable, i: IncidentWithPlace, viewer: AuthedUser) {
  const photos = await signPhotos(deps, q, viewer.id, i.id, await listPhotos(q, i.id));
  const settlement = await findSettlementByIncident(q, i.id);
  const summary = deps.submissionSummary ? await deps.submissionSummary(q, i.id, viewer.id) : { total: 0, ready: 0, mySubmissionId: null };
  const description = i.description.length > 200 ? `${i.description.slice(0, 200)}…` : i.description;
  return {
    id: i.id,
    status: i.status,
    type: i.type,
    place: placeDto(i),
    occurredFrom: i.occurred_from.toISOString(),
    occurredTo: i.occurred_to.toISOString(),
    vehicle: { color: i.vehicle_color, model: i.vehicle_model, damageArea: i.damage_area },
    descriptionSummary: description,
    photos: photos.map((p) => ({ position: p.position, url: p.url, width: p.width, height: p.height })),
    rewardPreview: { amount: settlement?.witness_reward ?? deps.env.DEMO_DEPOSIT_AMOUNT - deps.env.DEMO_PLATFORM_FEE, mock: true as const },
    mySubmissionId: summary.mySubmissionId,
    masked: true as const,
    createdAt: i.created_at.toISOString(),
  };
}

/**
 * Signs photo URLs for a DTO. Signing is best-effort: a Storage outage yields `url: null`
 * for that photo instead of failing the whole read (or, on create, failing after commit).
 */
async function signPhotos(deps: IncidentsDeps, q: Queryable, viewerId: string, incidentId: string, photos: IncidentPhotoRow[]) {
  if (!photos.length) return [];
  const signed = await Promise.all(
    photos.map(async (p) => ({
      id: p.id,
      position: p.position,
      mime: p.mime,
      width: p.width,
      height: p.height,
      url: await deps.storage.createSignedUrl(deps.env.SUPABASE_BUCKET_PHOTOS, p.object_path, deps.env.PHOTO_SIGNED_URL_TTL_SEC).catch((err: unknown) => {
        deps.logger?.warn({ err, incidentId, photoId: p.id }, 'photo signed URL failed');
        return null;
      }),
    })),
  );
  const signedCount = signed.filter((p) => p.url !== null).length;
  if (signedCount > 0) {
    await audit(q, {
      actorId: viewerId,
      action: 'photo.signed_url',
      targetType: 'incident',
      targetId: incidentId,
      metadata: { count: signedCount, ttlSec: deps.env.PHOTO_SIGNED_URL_TTL_SEC },
    }).catch((err: unknown) => deps.logger?.warn({ err, incidentId }, 'photo.signed_url audit failed'));
  }
  return signed;
}

export type IncidentAccess = 'OWNER' | 'VIEWER' | 'NONE';

/** Every authenticated user can read published reports; owner-only resources stay private. */
export async function resolveIncidentAccess(q: Queryable, incident: IncidentWithPlace, viewer: AuthedUser): Promise<IncidentAccess> {
  if (incident.requester_id === viewer.id || viewer.role === 'OPERATOR') return 'OWNER';
  if (incident.published_at && incident.status !== 'DRAFT') return 'VIEWER';
  return 'NONE';
}

export async function loadIncidentForViewer(q: Queryable, id: string, viewer: AuthedUser): Promise<{ incident: IncidentWithPlace; access: Exclude<IncidentAccess, 'NONE'> }> {
  const incident = await findIncident(q, id);
  if (!incident) throw ApiError.notFound('Incident not found');
  const access = await resolveIncidentAccess(q, incident, viewer);
  if (access === 'NONE') throw ApiError.notFound('Incident not found');
  return { incident, access };
}

export function incidentsRouter(deps: IncidentsDeps): Router {
  const r = Router();
  const { db, env } = deps;
  const requesterOnly = requireRole('REQUESTER');

  r.post('/uploads/photo-url', requesterOnly, async (req, res, next) => {
    try {
      const user = currentUser(req);
      const body = uploadUrlSchema.parse(req.body);
      const out = await createPhotoUploadUrl(deps, user.id, body.mime, body.bytes);
      await audit(db, { actorId: user.id, action: 'photo.upload_url', targetType: 'staging', targetId: out.objectPath, metadata: { mime: body.mime, bytes: body.bytes } });
      created(res, out);
    } catch (err) {
      next(err);
    }
  });

  r.post('/incidents', requesterOnly, async (req, res, next) => {
    let writtenPhotoPaths: string[] = [];
    try {
      const user = currentUser(req);
      const body = createSchema.parse(req.body);
      const occurredFrom = new Date(body.occurredFrom);
      const occurredTo = new Date(body.occurredTo);
      const fieldErrors: Record<string, string> = {};
      if (!(occurredFrom < occurredTo)) fieldErrors.occurredTo = 'must be after occurredFrom';
      else if (occurredTo.getTime() - occurredFrom.getTime() > MAX_WINDOW_MS) fieldErrors.occurredTo = 'window must be 24 hours or less';
      if (body.photoObjectPaths.length > env.MAX_PHOTO_COUNT) fieldErrors.photoObjectPaths = `at most ${env.MAX_PHOTO_COUNT}`;
      if (Object.keys(fieldErrors).length) throw ApiError.validation('Invalid incident', fieldErrors);

      const existingPlace = body.placeId ? await findPlace(db, body.placeId) : null;
      if (body.placeId && !existingPlace) throw ApiError.validation('Unknown place', { placeId: 'not_found' });
      const location = body.location ?? existingPlace!;
      const place = existingPlace ?? { id: randomUUID(), kind: 'BUILDING' as const, ...body.location! };

      const incidentId = randomUUID();
      const photos = await attachStagedPhotos(deps, user.id, incidentId, body.photoObjectPaths);
      writtenPhotoPaths = photos.map((p) => p.objectPath);

      const result = await db.transaction(async (tx) => {
        if (!existingPlace) await upsertPlace(tx, place);
        const incident = await insertIncident(tx, {
          id: incidentId,
          requesterId: user.id,
          placeId: place.id,
          type: body.type,
          occurredFrom,
          occurredTo,
          vehicleColor: body.vehicle.color,
          vehicleModel: body.vehicle.model,
          damageArea: body.vehicle.damageArea,
          description: body.description,
          location,
        });
        for (const p of photos) await insertIncidentPhoto(tx, { incidentId, ...p });
        await createDeposit(tx, env, incidentId);
        const matching = await runMatching(tx, env, {
          incidentId,
          requesterId: user.id,
          placeId: place.id,
          placeName: place.name,
          occurredFrom,
          occurredTo,
        });
        await audit(tx, {
          actorId: user.id,
          action: 'incident.create',
          targetType: 'incident',
          targetId: incidentId,
          metadata: { photos: photos.length, matchedWitnessCount: matching.matchedWitnessCount },
        });
        return { incident, matching };
      });
      writtenPhotoPaths = [];

      // Committed. Anything after this point must not turn into an error response, or the
      // client would retry and create a duplicate incident + deposit.
      const matching = { matchedWitnessCount: result.matching.matchedWitnessCount, notifiedAt: result.matching.notifiedAt };
      try {
        const full = await findIncident(db, result.incident.id);
        if (!full) throw new Error('incident vanished after insert');
        const dto = await ownerIncidentDto(deps, db, full, user, { withPhotos: true });
        created(res, { ...dto, matching });
      } catch (err) {
        deps.logger?.error({ err, incidentId: result.incident.id }, 'incident created but response DTO failed; returning minimal body');
        created(res, { id: result.incident.id, status: result.incident.status, matching, partial: true });
      }
    } catch (err) {
      if (writtenPhotoPaths.length) await removeIncidentPhotos(deps, writtenPhotoPaths);
      next(err);
    }
  });

  r.get('/me/incidents', requesterOnly, async (req, res, next) => {
    try {
      const user = currentUser(req);
      const rows = await listIncidentsByRequester(db, user.id);
      const items = [];
      for (const row of rows) items.push(await ownerIncidentDto(deps, db, row, user, { withPhotos: false }));
      ok(res, items);
    } catch (err) {
      next(err);
    }
  });

  r.get('/incidents/map', async (req, res, next) => {
    try {
      const b = mapQuerySchema.parse(req.query);
      const rows = await listMapIncidents(db, b.south === undefined ? undefined : { south: b.south, north: b.north!, west: b.west!, east: b.east! });
      ok(res, {
        items: rows.slice(0, 200).map((i) => ({ id: i.id, type: i.type, status: i.status, place: placeDto(i),
          occurredFrom: i.occurred_from.toISOString(), occurredTo: i.occurred_to.toISOString() })),
        hasMore: rows.length > 200,
      });
    } catch (err) { next(err); }
  });

  r.get('/incidents/:id', async (req, res, next) => {
    try {
      const user = currentUser(req);
      const id = z.string().uuid().parse(req.params.id);
      const { incident, access } = await loadIncidentForViewer(db, id, user);
      if (access === 'OWNER') ok(res, await ownerIncidentDto(deps, db, incident, user, { withPhotos: true }));
      else ok(res, await witnessIncidentDto(deps, db, incident, user));
    } catch (err) {
      next(err);
    }
  });

  return r;
}
