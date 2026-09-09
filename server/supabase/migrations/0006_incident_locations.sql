-- Preserve the location selected at report time, independently of later place edits.
alter table incidents add column location_name text;
alter table incidents add column location_address text;
alter table incidents add column location_lat double precision check (location_lat between -90 and 90);
alter table incidents add column location_lng double precision check (location_lng between -180 and 180);
alter table incidents add constraint incident_location_pair check ((location_lat is null) = (location_lng is null));

update incidents i set location_name = p.name, location_address = p.address,
  location_lat = p.lat, location_lng = p.lng
from places p where p.id = i.place_id and p.lat is not null and p.lng is not null;

create index incidents_map_idx on incidents (location_lat, location_lng) where published_at is not null;
