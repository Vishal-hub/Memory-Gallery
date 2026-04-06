const ANIMAL_ONLY_PEOPLE_SQL = `
  SELECT mf2.person_id
  FROM media_faces mf2
  JOIN media_items m ON m.id = mf2.media_id
  GROUP BY mf2.person_id
  HAVING COUNT(*) = SUM(
    CASE WHEN m.person_class = 'none'
      AND m.ai_tags IS NOT NULL AND m.ai_tags != ''
      AND m.ai_tags NOT LIKE '%person%'
    THEN 1 ELSE 0 END
  )
`;

const ANIMAL_IDENTITY_TAGS = new Set([
  'dog', 'cat', 'bird', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra',
  'giraffe', 'fish', 'rabbit', 'hamster', 'turtle', 'snake', 'lizard', 'frog',
  'mouse', 'parrot', 'duck', 'goose', 'chicken', 'penguin', 'owl', 'deer',
]);

function upsertMediaItems(db, files, runId) {
  const selectByPath = db.prepare('SELECT * FROM media_items WHERE path = ?');
  const upsert = db.prepare(`
    INSERT INTO media_items (path, ext, media_type, size, mtime_ms, resolved_time_ms, resolved_source, latitude, longitude, location_source, place_name, ai_tags, face_count, embedding, thumbnail_path, converted_path, faces_indexed, visual_indexed, person_class, confidence, last_seen_run, is_missing)
    VALUES (@path, @ext, @mediaType, @size, @mtimeMs, @resolvedTimeMs, @resolvedSource, @latitude, @longitude, @locationSource, @placeName, @aiTags, @faceCount, @embedding, @thumbnailPath, @convertedPath, @facesIndexed, @visualIndexed, @personClass, @confidence, @lastSeenRun, 0)
    ON CONFLICT(path) DO UPDATE SET
      ext = excluded.ext,
      media_type = excluded.media_type,
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      resolved_time_ms = excluded.resolved_time_ms,
      resolved_source = excluded.resolved_source,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      location_source = excluded.location_source,
      place_name = excluded.place_name,
      ai_tags = excluded.ai_tags,
      face_count = excluded.face_count,
      embedding = excluded.embedding,
      thumbnail_path = COALESCE(excluded.thumbnail_path, media_items.thumbnail_path),
      converted_path = COALESCE(excluded.converted_path, media_items.converted_path),
      faces_indexed = CASE WHEN mtime_ms != excluded.mtime_ms THEN 0 ELSE faces_indexed END,
      visual_indexed = CASE WHEN mtime_ms != excluded.mtime_ms THEN 0 ELSE visual_indexed END,
      person_class = CASE WHEN mtime_ms != excluded.mtime_ms THEN 'none' ELSE media_items.person_class END,
      confidence = excluded.confidence,
      last_seen_run = excluded.last_seen_run,
      is_missing = 0
  `);
  const markMissing = db.prepare('UPDATE media_items SET is_missing = 1 WHERE last_seen_run < ?');
  const updateLastSeen = db.prepare('UPDATE media_items SET last_seen_run = ?, is_missing = 0 WHERE path = ?');
  return { selectByPath, upsert, markMissing, updateLastSeen };
}

function getActiveMediaItems(db) {
  return db.prepare(`
    SELECT id, path, ext, media_type, resolved_time_ms, resolved_source, latitude, longitude, location_source, place_name, ai_tags, face_count, faces_indexed, confidence
    FROM media_items
    WHERE is_missing = 0
    ORDER BY resolved_time_ms ASC, path ASC
  `).all();
}

function replaceEvents(db, events) {
  const existingEvents = db.prepare(
    'SELECT id, start_time_ms, end_time_ms, item_count, center_lat, center_lon FROM events'
  ).all();
  const existingMap = new Map(existingEvents.map((e) => [e.id, e]));

  const newIds = new Set(events.map((e) => e.id));

  const insertEvent = db.prepare(`
    INSERT INTO events (id, start_time_ms, end_time_ms, item_count, center_lat, center_lon, location_count, place_name, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateEvent = db.prepare(`
    UPDATE events SET start_time_ms = ?, end_time_ms = ?, item_count = ?,
      center_lat = ?, center_lon = ?, location_count = ?, place_name = ?, updated_at_ms = ?
    WHERE id = ?
  `);
  const deleteEvent = db.prepare('DELETE FROM events WHERE id = ?');
  const deleteEventItems = db.prepare('DELETE FROM event_items WHERE event_id = ?');
  const insertEventItem = db.prepare(`
    INSERT INTO event_items (event_id, media_id, sort_index)
    VALUES (?, ?, ?)
  `);

  const tx = db.transaction((eventRows) => {
    for (const [existingId] of existingMap) {
      if (!newIds.has(existingId)) {
        deleteEventItems.run(existingId);
        deleteEvent.run(existingId);
      }
    }

    const now = Date.now();
    for (const event of eventRows) {
      const old = existingMap.get(event.id);
      if (old &&
        old.start_time_ms === event.startTimeMs &&
        old.end_time_ms === event.endTimeMs &&
        old.item_count === event.items.length &&
        old.center_lat === event.centerLat &&
        old.center_lon === event.centerLon) {
        continue;
      }

      if (old) {
        deleteEventItems.run(event.id);
        updateEvent.run(
          event.startTimeMs, event.endTimeMs, event.items.length,
          event.centerLat, event.centerLon, event.locationCount,
          event.placeName || null, now, event.id
        );
      } else {
        insertEvent.run(
          event.id, event.startTimeMs, event.endTimeMs, event.items.length,
          event.centerLat, event.centerLon, event.locationCount,
          event.placeName || null, now
        );
      }

      event.items.forEach((item, idx) => {
        insertEventItem.run(event.id, item.id, idx);
      });
    }
  });
  tx(events);
}

function getEventsForRenderer(db, groupBy = 'date') {
  const eventRows = db.prepare(`
    SELECT id, start_time_ms, end_time_ms, item_count, center_lat, center_lon, location_count, place_name
    FROM events
    ORDER BY start_time_ms ASC, id ASC
  `).all();

  const allItemRows = db.prepare(`
    SELECT
      ei.event_id,
      m.path,
      m.media_type,
      m.resolved_time_ms,
      m.latitude,
      m.longitude,
      m.place_name,
      m.ai_tags,
      m.face_count,
      m.person_class,
      m.thumbnail_path,
      m.converted_path,
      GROUP_CONCAT(p.name, ', ') AS person_names
    FROM event_items ei
    JOIN media_items m ON m.id = ei.media_id
    LEFT JOIN media_faces mf ON mf.media_id = m.id
    LEFT JOIN people p ON p.id = mf.person_id
    WHERE m.is_missing = 0
    GROUP BY ei.event_id, m.id
    ORDER BY ei.event_id, ei.sort_index ASC
  `).all();

  const itemsByEvent = new Map();
  for (const item of allItemRows) {
    let list = itemsByEvent.get(item.event_id);
    if (!list) { list = []; itemsByEvent.set(item.event_id, list); }
    list.push({
      path: item.path,
      thumbnailPath: item.thumbnail_path,
      convertedPath: item.converted_path || null,
      type: item.media_type,
      createdAt: item.resolved_time_ms,
      latitude: item.latitude,
      longitude: item.longitude,
      placeName: item.place_name,
      aiTags: item.ai_tags,
      faceCount: item.face_count,
      personClass: item.person_class || 'none',
      personNames: item.person_names,
    });
  }

  const baseClusters = eventRows.map((event) => ({
    id: event.id,
    items: itemsByEvent.get(event.id) || [],
    startTime: event.start_time_ms,
    endTime: event.end_time_ms,
    centerLat: event.center_lat,
    centerLon: event.center_lon,
    locationCount: event.location_count,
    placeName: event.place_name,
  }));

  const resolveClusterPlaceName = (cluster) => {
    if (cluster.placeName) return cluster.placeName;
    const firstNamedItem = cluster.items.find((item) => item.placeName);
    return firstNamedItem?.placeName || 'Pinned location';
  };

  if (groupBy === 'date') return baseClusters;

  if (groupBy === 'location') {
    return baseClusters
      .filter((cluster) => typeof cluster.centerLat === 'number' && typeof cluster.centerLon === 'number')
      .map((cluster) => ({
        ...cluster,
        placeName: resolveClusterPlaceName(cluster),
      }))
      .sort((a, b) => b.items.length - a.items.length);
  }

  if (groupBy === 'tag') {
    const allItems = db.prepare(`
      SELECT m.*, GROUP_CONCAT(p.name, ', ') AS person_names
      FROM media_items m
      LEFT JOIN media_faces mf ON mf.media_id = m.id
      LEFT JOIN people p ON p.id = mf.person_id
      WHERE m.is_missing = 0 AND m.ai_tags IS NOT NULL AND m.ai_tags != ''
      GROUP BY m.id
    `).all();
    const tagMap = new Map();

    // Group items by tag
    allItems.forEach(item => {
      const tags = (item.ai_tags || '').split(',').map(t => t.trim()).filter(Boolean);
      tags.forEach(tag => {
        if (!tagMap.has(tag)) tagMap.set(tag, []);
        tagMap.get(tag).push(item);
      });
    });

    return Array.from(tagMap.entries()).map(([tag, items]) => {
      items.sort((a, b) => b.resolved_time_ms - a.resolved_time_ms);
      return {
        id: `tag-${tag}`,
        items: items.map(item => ({
          path: item.path,
          thumbnailPath: item.thumbnail_path,
          convertedPath: item.converted_path || null,
          type: item.media_type,
          createdAt: item.resolved_time_ms,
          latitude: item.latitude,
          longitude: item.longitude,
          placeName: item.place_name,
          aiTags: item.ai_tags,
          faceCount: item.face_count,
          personClass: item.person_class || 'none',
          personNames: item.person_names,
        })),
        startTime: items[items.length - 1].resolved_time_ms,
        endTime: items[0].resolved_time_ms,
        centerLat: items[0].latitude,
        centerLon: items[0].longitude,
        locationCount: new Set(items.map(i => i.place_name).filter(Boolean)).size,
        placeName: `Category: ${tag.charAt(0).toUpperCase() + tag.slice(1)}`,
      };
    }).sort((a, b) => b.items.length - a.items.length);
  }

  if (groupBy === 'person') {
    const animalOnlyPeople = db.prepare(ANIMAL_ONLY_PEOPLE_SQL).all().map(r => r.person_id);
    const excludeSet = new Set(animalOnlyPeople);

    const allItems = db.prepare(`
      SELECT m.*, mf.person_id, p2.name as person_name, GROUP_CONCAT(p.name, ', ') AS person_names
      FROM media_items m
      JOIN media_faces mf ON mf.media_id = m.id
      JOIN people p2 ON p2.id = mf.person_id
      LEFT JOIN media_faces mf2 ON mf2.media_id = m.id
      LEFT JOIN people p ON p.id = mf2.person_id
      WHERE m.is_missing = 0
      GROUP BY m.id, mf.person_id
    `).all().filter(item => !excludeSet.has(item.person_id));

    const personMap = new Map();
    allItems.forEach(item => {
      const pId = item.person_id;
      if (!personMap.has(pId)) personMap.set(pId, { name: item.person_name, items: [] });
      personMap.get(pId).items.push(item);
    });

    return Array.from(personMap.entries()).map(([pId, data]) => {
      const items = data.items;
      items.sort((a, b) => b.resolved_time_ms - a.resolved_time_ms);
      return {
        id: `person-${pId}`,
        items: items.map(item => ({
          path: item.path,
          thumbnailPath: item.thumbnail_path,
          convertedPath: item.converted_path || null,
          type: item.media_type,
          createdAt: item.resolved_time_ms,
          latitude: item.latitude,
          longitude: item.longitude,
          placeName: item.place_name,
          aiTags: item.ai_tags,
          faceCount: item.face_count,
          personClass: item.person_class || 'none',
          personNames: item.person_names,
        })),
        startTime: items[items.length - 1].resolved_time_ms,
        endTime: items[0].resolved_time_ms,
        centerLat: items[0].latitude,
        centerLon: items[0].longitude,
        locationCount: new Set(items.map(i => i.place_name).filter(Boolean)).size,
        placeName: `${data.name}`,
      };
    }).sort((a, b) => b.items.length - a.items.length);
  }

  return baseClusters;
}

function mapSummaryClusterRow(row) {
  const coverItem = row.cover_path ? {
    path: row.cover_path,
    thumbnailPath: row.cover_thumbnail_path,
    convertedPath: row.cover_converted_path || null,
    type: row.cover_media_type,
    createdAt: row.cover_resolved_time_ms,
    latitude: row.cover_latitude,
    longitude: row.cover_longitude,
    placeName: row.cover_place_name,
    aiTags: row.cover_ai_tags,
    faceCount: row.cover_face_count,
    personClass: row.cover_person_class || 'none',
    personNames: null,
  } : null;

  return {
    id: row.id,
    items: coverItem ? [coverItem] : [],
    itemCount: row.item_count,
    hasFullItems: false,
    startTime: row.start_time_ms,
    endTime: row.end_time_ms,
    centerLat: row.center_lat,
    centerLon: row.center_lon,
    locationCount: row.location_count,
    placeName: row.place_name,
    coverItem,
  };
}

function mapMediaItemRow(item) {
  return {
    path: item.path,
    thumbnailPath: item.thumbnail_path,
    convertedPath: item.converted_path || null,
    type: item.media_type,
    createdAt: item.resolved_time_ms,
    latitude: item.latitude,
    longitude: item.longitude,
    placeName: item.place_name,
    aiTags: item.ai_tags,
    faceCount: item.face_count,
    personClass: item.person_class || 'none',
    personNames: item.person_names || null,
  };
}

function normalizeTagName(tag) {
  return String(tag || '').trim();
}

function getTagSummaryPage(db, options = {}) {
  const {
    cursor = 0,
    limit = 200,
  } = options;
  const safeCursor = Math.max(0, Number(cursor) || 0);
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));

  const rows = db.prepare(`
    WITH tagged_media AS (
      SELECT
        m.id,
        m.path,
        m.media_type,
        m.resolved_time_ms,
        m.latitude,
        m.longitude,
        m.place_name,
        m.ai_tags,
        m.face_count,
        m.person_class,
        m.thumbnail_path,
        m.converted_path,
        TRIM(j.value) AS tag
      FROM media_items m
      JOIN json_each('["' || REPLACE(REPLACE(IFNULL(m.ai_tags, ''), '",', '","'), ',', '","') || '"]') j
      WHERE m.is_missing = 0
        AND m.ai_tags IS NOT NULL
        AND m.ai_tags != ''
        AND TRIM(j.value) != ''
    ),
    ranked_tagged_media AS (
      SELECT
        *,
        ROW_NUMBER() OVER (PARTITION BY tag ORDER BY resolved_time_ms DESC, path DESC) AS tag_rank
      FROM tagged_media
    )
    SELECT
      tag,
      COUNT(*) AS item_count,
      MIN(resolved_time_ms) AS start_time_ms,
      MAX(resolved_time_ms) AS end_time_ms,
      COUNT(DISTINCT place_name) AS location_count,
      MAX(CASE WHEN tag_rank = 1 THEN path END) AS cover_path,
      MAX(CASE WHEN tag_rank = 1 THEN media_type END) AS cover_media_type,
      MAX(CASE WHEN tag_rank = 1 THEN resolved_time_ms END) AS cover_resolved_time_ms,
      MAX(CASE WHEN tag_rank = 1 THEN latitude END) AS cover_latitude,
      MAX(CASE WHEN tag_rank = 1 THEN longitude END) AS cover_longitude,
      MAX(CASE WHEN tag_rank = 1 THEN place_name END) AS cover_place_name,
      MAX(CASE WHEN tag_rank = 1 THEN ai_tags END) AS cover_ai_tags,
      MAX(CASE WHEN tag_rank = 1 THEN face_count END) AS cover_face_count,
      MAX(CASE WHEN tag_rank = 1 THEN person_class END) AS cover_person_class,
      MAX(CASE WHEN tag_rank = 1 THEN thumbnail_path END) AS cover_thumbnail_path,
      MAX(CASE WHEN tag_rank = 1 THEN converted_path END) AS cover_converted_path
    FROM ranked_tagged_media
    GROUP BY tag
    ORDER BY item_count DESC, end_time_ms DESC, tag ASC
    LIMIT ? OFFSET ?
  `).all(safeLimit + 1, safeCursor);

  const sliced = rows.slice(0, safeLimit).map((row) => ({
    ...mapSummaryClusterRow({
      ...row,
      id: `tag-${row.tag}`,
      place_name: `Category: ${row.tag.charAt(0).toUpperCase() + row.tag.slice(1)}`,
    }),
    title: row.tag,
  }));

  return {
    clusters: sliced,
    nextCursor: safeCursor + sliced.length,
    hasMore: rows.length > safeLimit,
  };
}

function getEventSummaryPage(db, options = {}) {
  const {
    groupBy = 'date',
    cursor = 0,
    limit = 200,
  } = options;
  if (groupBy === 'tag') {
    return getTagSummaryPage(db, options);
  }
  const safeCursor = Math.max(0, Number(cursor) || 0);
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));

  const orderBy = groupBy === 'location'
    ? 'e.item_count DESC, e.start_time_ms ASC, e.id ASC'
    : 'e.start_time_ms ASC, e.id ASC';
  const whereClause = groupBy === 'location'
    ? 'WHERE e.center_lat IS NOT NULL AND e.center_lon IS NOT NULL'
    : '';

  const rows = db.prepare(`
    SELECT
      e.id,
      e.start_time_ms,
      e.end_time_ms,
      e.item_count,
      e.center_lat,
      e.center_lon,
      e.location_count,
      e.place_name,
      m.path AS cover_path,
      m.media_type AS cover_media_type,
      m.resolved_time_ms AS cover_resolved_time_ms,
      m.latitude AS cover_latitude,
      m.longitude AS cover_longitude,
      m.place_name AS cover_place_name,
      m.ai_tags AS cover_ai_tags,
      m.face_count AS cover_face_count,
      m.person_class AS cover_person_class,
      m.thumbnail_path AS cover_thumbnail_path,
      m.converted_path AS cover_converted_path
    FROM events e
    LEFT JOIN event_items ei ON ei.event_id = e.id AND ei.sort_index = 0
    LEFT JOIN media_items m ON m.id = ei.media_id
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(safeLimit + 1, safeCursor);

  const sliced = rows.slice(0, safeLimit).map(mapSummaryClusterRow);
  return {
    clusters: sliced,
    nextCursor: safeCursor + sliced.length,
    hasMore: rows.length > safeLimit,
  };
}

function getClusterItems(db, clusterId) {
  if (!clusterId) return [];

  if (clusterId.startsWith('tag-')) {
    const tag = normalizeTagName(clusterId.slice(4));
    if (!tag) return [];
    return db.prepare(`
      SELECT
        m.path,
        m.media_type,
        m.resolved_time_ms,
        m.latitude,
        m.longitude,
        m.place_name,
        m.ai_tags,
        m.face_count,
        m.person_class,
        m.thumbnail_path,
        m.converted_path,
        GROUP_CONCAT(p.name, ', ') AS person_names
      FROM media_items m
      LEFT JOIN media_faces mf ON mf.media_id = m.id
      LEFT JOIN people p ON p.id = mf.person_id
      JOIN json_each('["' || REPLACE(REPLACE(IFNULL(m.ai_tags, ''), '",', '","'), ',', '","') || '"]') j
      WHERE m.is_missing = 0
        AND TRIM(j.value) = ?
      GROUP BY m.id
      ORDER BY m.resolved_time_ms DESC, m.path DESC
    `).all(tag).map(mapMediaItemRow);
  }

  if (clusterId.startsWith('person-')) {
    const groupBy = 'person';
    const clusters = getEventsForRenderer(db, groupBy);
    const cluster = clusters.find((entry) => entry.id === clusterId);
    return cluster?.items || [];
  }

  return db.prepare(`
    SELECT
      m.path,
      m.media_type,
      m.resolved_time_ms,
      m.latitude,
      m.longitude,
      m.place_name,
      m.ai_tags,
      m.face_count,
      m.person_class,
      m.thumbnail_path,
      m.converted_path,
      GROUP_CONCAT(p.name, ', ') AS person_names
    FROM event_items ei
    JOIN media_items m ON m.id = ei.media_id
    LEFT JOIN media_faces mf ON mf.media_id = m.id
    LEFT JOIN people p ON p.id = mf.person_id
    WHERE ei.event_id = ? AND m.is_missing = 0
    GROUP BY m.id
    ORDER BY ei.sort_index ASC
  `).all(clusterId).map(mapMediaItemRow);
}

function getPersonCluster(db, personId) {
  if (!personId) return null;

  const person = db.prepare(`
    SELECT id, name
    FROM people
    WHERE id = ?
      AND id NOT IN (${ANIMAL_ONLY_PEOPLE_SQL})
  `).get(personId);

  if (!person) return null;

  const items = db.prepare(`
    SELECT
      m.path,
      m.media_type,
      m.resolved_time_ms,
      m.latitude,
      m.longitude,
      m.place_name,
      m.ai_tags,
      m.face_count,
      m.person_class,
      m.thumbnail_path,
      m.converted_path,
      GROUP_CONCAT(p.name, ', ') AS person_names
    FROM media_items m
    JOIN media_faces mf ON mf.media_id = m.id
    LEFT JOIN media_faces mf2 ON mf2.media_id = m.id
    LEFT JOIN people p ON p.id = mf2.person_id
    WHERE mf.person_id = ? AND m.is_missing = 0
    GROUP BY m.id
    ORDER BY m.resolved_time_ms DESC, m.path DESC
  `).all(personId).map((item) => ({
    path: item.path,
    thumbnailPath: item.thumbnail_path,
    convertedPath: item.converted_path || null,
    type: item.media_type,
    createdAt: item.resolved_time_ms,
    latitude: item.latitude,
    longitude: item.longitude,
    placeName: item.place_name,
    aiTags: item.ai_tags,
    faceCount: item.face_count,
    personClass: item.person_class || 'none',
    personNames: item.person_names,
  }));

  if (items.length === 0) return null;

  const newest = items[0];
  const oldest = items[items.length - 1];

  return {
    id: `person-${personId}`,
    title: person.name,
    items,
    itemCount: items.length,
    hasFullItems: true,
    startTime: oldest.createdAt,
    endTime: newest.createdAt,
    centerLat: newest.latitude,
    centerLon: newest.longitude,
    locationCount: new Set(items.map((item) => item.placeName).filter(Boolean)).size,
    placeName: null,
  };
}

function getIndexStats(db) {
  const totals = db.prepare(`
    SELECT
      SUM(CASE WHEN is_missing = 0 THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN is_missing = 1 THEN 1 ELSE 0 END) AS missing_count,
      COUNT(*) AS total_count
    FROM media_items
  `).get();

  const sourceBreakdown = db.prepare(`
    SELECT resolved_source AS source, COUNT(*) AS count
    FROM media_items
    WHERE is_missing = 0
    GROUP BY resolved_source
    ORDER BY count DESC
  `).all();

  const eventCountRow = db.prepare('SELECT COUNT(*) AS count FROM events').get();
  const geotaggedRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM media_items
    WHERE is_missing = 0 AND latitude IS NOT NULL AND longitude IS NOT NULL
  `).get();
  const indexJobCounts = getIndexJobCounts(db);

  return {
    activeMedia: totals?.active_count || 0,
    missingMedia: totals?.missing_count || 0,
    totalMedia: totals?.total_count || 0,
    events: eventCountRow?.count || 0,
    geotaggedMedia: geotaggedRow?.count || 0,
    sourceBreakdown,
    indexJobCounts,
  };
}

function insertFace(db, mediaId, personId, box2d, embedding) {
  return db.prepare(`
    INSERT INTO media_faces (media_id, person_id, box_2d, embedding)
    VALUES (?, ?, ?, ?)
  `).run(mediaId, personId, JSON.stringify(box2d), embedding);
}

function updateMediaEmbedding(db, mediaId, embedding) {
  return db.prepare('UPDATE media_items SET embedding = ? WHERE id = ?').run(embedding, mediaId);
}

function classifyPersonPresence(analysis) {
  if (analysis?.personClass) {
    return {
      personClass: analysis.personClass,
      personConfidence: Number.isFinite(analysis.personConfidence) ? analysis.personConfidence : 0,
    };
  }
  const detections = analysis?.objectDetections;
  if (!Array.isArray(detections)) return { personClass: 'none', personConfidence: 0 };
  const personDetections = detections.filter(d => d.label === 'person' && d.score >= 0.5);
  if (personDetections.length === 0) return { personClass: 'none', personConfidence: 0 };
  const maxScore = Math.max(...personDetections.map(d => d.score));
  const personClass = personDetections.length === 1 ? 'portrait' : 'group';
  return { personClass, personConfidence: maxScore };
}

function updateMediaVisualAnalysis(db, mediaId, analysis, options = {}) {
  const {
    faceIndexComplete = false,
  } = options;
  const { personClass, personConfidence } = classifyPersonPresence(analysis);
  return db.prepare(`
    UPDATE media_items
    SET ai_tags = ?,
        face_count = ?,
        person_class = CASE
          WHEN ? = 'none' AND EXISTS (
            SELECT 1 FROM media_faces mf WHERE mf.media_id = media_items.id
          ) THEN CASE
            WHEN media_items.person_class IS NOT NULL AND media_items.person_class != 'none'
              THEN media_items.person_class
            ELSE 'portrait'
          END
          ELSE ?
        END,
        person_confidence = CASE
          WHEN ? = 'none' AND EXISTS (
            SELECT 1 FROM media_faces mf WHERE mf.media_id = media_items.id
          ) THEN CASE
            WHEN COALESCE(media_items.person_confidence, 0) > 0
              THEN media_items.person_confidence
            ELSE 1
          END
          ELSE ?
        END,
        visual_indexed = 1,
        faces_indexed = CASE WHEN ? THEN 1 ELSE faces_indexed END
    WHERE id = ?
  `).run(
    analysis?.tags || '',
    Number.isFinite(analysis?.faceCount) ? analysis.faceCount : 0,
    personClass,
    personClass,
    personClass,
    personConfidence,
    faceIndexComplete ? 1 : 0,
    mediaId
  );
}

function normalizeEmbeddingBuffer(embedding) {
  const vector = new Float32Array(embedding.buffer, embedding.byteOffset, embedding.byteLength / 4);
  let magnitude = 0;
  for (let i = 0; i < vector.length; i += 1) magnitude += vector[i] * vector[i];
  magnitude = Math.sqrt(magnitude);
  if (magnitude === 0) return null;

  const normalized = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    normalized[i] = vector[i] / magnitude;
  }
  return normalized;
}

function findClosestPerson(db, embedding, threshold = 0.4) {
  const people = db.prepare('SELECT id, name, embedding FROM people WHERE embedding IS NOT NULL').all();

  let bestId = null;
  let bestScore = -1;

  const target = new Float32Array(embedding.buffer, embedding.byteOffset, embedding.byteLength / 4);

  // Compute target magnitude for cosine similarity
  let targetMag = 0;
  for (let i = 0; i < target.length; i++) targetMag += target[i] * target[i];
  targetMag = Math.sqrt(targetMag);
  if (targetMag === 0) return null;

  for (const person of people) {
    const source = new Float32Array(person.embedding.buffer, person.embedding.byteOffset, person.embedding.byteLength / 4);

    // Cosine similarity = dot(a,b) / (|a| * |b|)
    let dot = 0, sourceMag = 0;
    for (let i = 0; i < target.length; i++) {
      dot += target[i] * source[i];
      sourceMag += source[i] * source[i];
    }
    sourceMag = Math.sqrt(sourceMag);
    if (sourceMag === 0) continue;

    const cosine = dot / (targetMag * sourceMag);

    if (cosine > threshold && cosine > bestScore) {
      bestScore = cosine;
      bestId = person.id;
    }
  }

  if (bestId) console.log(`[Repository] Match found: ${bestId} (cosine: ${bestScore.toFixed(3)})`);
  return bestId;
}

function createPersonMatcher(db) {
  const people = db.prepare('SELECT id, embedding FROM people WHERE embedding IS NOT NULL').all();
  const entries = people
    .map((person) => ({
      id: person.id,
      vector: normalizeEmbeddingBuffer(person.embedding),
    }))
    .filter((person) => person.vector);

  return {
    findClosest(embedding, threshold = 0.4) {
      const target = normalizeEmbeddingBuffer(embedding);
      if (!target) return null;

      let bestId = null;
      let bestScore = -1;

      for (const person of entries) {
        let dot = 0;
        for (let i = 0; i < target.length; i += 1) {
          dot += target[i] * person.vector[i];
        }
        if (dot > threshold && dot > bestScore) {
          bestScore = dot;
          bestId = person.id;
        }
      }

      if (bestId) {
        console.log(`[Repository] Match found: ${bestId} (cosine: ${bestScore.toFixed(3)})`);
      }
      return bestId;
    },
    add(personId, embedding) {
      const vector = normalizeEmbeddingBuffer(embedding);
      if (!vector) return;
      entries.push({ id: personId, vector });
    },
  };
}

function createPerson(db, name, thumbnailPath, embedding) {
  const id = `person_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  db.prepare(`
    INSERT INTO people (id, name, thumbnail_path, embedding, updated_at_ms)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, thumbnailPath, embedding, Date.now());
  return id;
}

function getPeople(db) {
  return db.prepare(`
    SELECT p.*, COUNT(mf.id) as appearance_count
    FROM people p
    LEFT JOIN media_faces mf ON mf.person_id = p.id
    WHERE p.id NOT IN (${ANIMAL_ONLY_PEOPLE_SQL})
    GROUP BY p.id
    ORDER BY appearance_count DESC
  `).all();
}

function renamePerson(db, id, name) {
  return db.prepare(`
    UPDATE people
    SET name = ?, is_named = 1, updated_at_ms = ?
    WHERE id = ?
  `).run(name, Date.now(), id);
}

function deleteFacesForMediaId(db, mediaId) {
  return db.prepare('DELETE FROM media_faces WHERE media_id = ?').run(mediaId);
}

function pruneOrphanPeople(db) {
  return db.prepare(`
    DELETE FROM people
    WHERE id IN (
      SELECT p.id
      FROM people p
      LEFT JOIN media_faces mf ON mf.person_id = p.id
      GROUP BY p.id
      HAVING COUNT(mf.id) = 0
    )
  `).run();
}

function purgeAnimalFalsePositivePeople(db) {
  const rows = db.prepare(`
    SELECT
      p.id AS person_id,
      p.is_named AS is_named,
      m.id AS media_id,
      m.ai_tags AS ai_tags,
      m.media_type AS media_type
    FROM people p
    JOIN media_faces mf ON mf.person_id = p.id
    JOIN media_items m ON m.id = mf.media_id
    WHERE m.is_missing = 0
    ORDER BY p.id, m.id
  `).all();

  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.person_id)) grouped.set(row.person_id, []);
    grouped.get(row.person_id).push(row);
  }

  const personIdsToDelete = [];
  const mediaIdsToReset = new Set();

  for (const [personId, appearances] of grouped.entries()) {
    if (!appearances.length) continue;
    if (appearances[0].is_named) continue;

    const shouldDelete = appearances.every((appearance) => {
      if (appearance.media_type !== 'image') return false;
      const tags = String(appearance.ai_tags || '')
        .split(',')
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean);
      if (tags.length === 0) return false;
      const hasAnimalTag = tags.some((tag) => ANIMAL_IDENTITY_TAGS.has(tag));
      if (!hasAnimalTag) return false;
      const hasHumanTag = tags.some((tag) => tag === 'person' || tag === 'portrait' || tag === 'group');
      return !hasHumanTag;
    });

    if (!shouldDelete) continue;
    personIdsToDelete.push(personId);
    appearances.forEach((appearance) => mediaIdsToReset.add(appearance.media_id));
  }

  if (personIdsToDelete.length === 0) {
    return { deletedPeople: 0, resetMedia: 0 };
  }

  const deleteFaces = db.prepare(`DELETE FROM media_faces WHERE person_id = ?`);
  const resetMedia = db.prepare(`UPDATE media_items SET person_class = 'none', faces_indexed = 1 WHERE id = ?`);
  const tx = db.transaction(() => {
    personIdsToDelete.forEach((personId) => deleteFaces.run(personId));
    mediaIdsToReset.forEach((mediaId) => resetMedia.run(mediaId));
    pruneOrphanPeople(db);
  });
  tx();

  return {
    deletedPeople: personIdsToDelete.length,
    resetMedia: mediaIdsToReset.size,
  };
}

function deleteMediaItemsByPaths(db, paths) {
  const uniquePaths = Array.from(new Set((paths || []).filter(Boolean)));
  if (uniquePaths.length === 0) return { deletedCount: 0 };

  const selectMedia = db.prepare('SELECT id, thumbnail_path FROM media_items WHERE path = ?');
  const deleteMedia = db.prepare('DELETE FROM media_items WHERE path = ?');
  const tx = db.transaction((inputPaths) => {
    const deleted = [];
    inputPaths.forEach((filePath) => {
      const media = selectMedia.get(filePath);
      if (!media) return;
      deleteMedia.run(filePath);
      deleted.push(media);
    });
    if (deleted.length > 0) {
      pruneOrphanPeople(db);
    }
    return deleted;
  });

  const deletedItems = tx(uniquePaths);
  return {
    deletedCount: deletedItems.length,
    deletedItems,
  };
}

function quickUpsertMediaItems(db, files, runId) {
  const insert = db.prepare(`
    INSERT INTO media_items (path, ext, media_type, size, mtime_ms, resolved_time_ms, resolved_source, last_seen_run, is_missing,
      faces_indexed, visual_indexed, person_class, confidence)
    VALUES (@path, @ext, @mediaType, @size, @mtimeMs, @resolvedTimeMs, 'pending', @lastSeenRun, 0,
      0, 0, 'none', 0)
    ON CONFLICT(path) DO UPDATE SET
      last_seen_run = excluded.last_seen_run,
      is_missing = 0
  `);
  const markMissing = db.prepare('UPDATE media_items SET is_missing = 1 WHERE last_seen_run < ?');

  const tx = db.transaction((rows) => {
    for (const file of rows) {
      insert.run({
        path: file.path,
        ext: file.ext,
        mediaType: file.mediaType,
        size: file.size,
        mtimeMs: file.mtimeMs,
        resolvedTimeMs: file.mtimeMs,
        lastSeenRun: runId,
      });
    }
  });
  tx(files);

  return { markMissing };
}

function getUnprocessedMediaItems(db) {
  return db.prepare(`
    SELECT id, path, ext, media_type, size, mtime_ms, resolved_time_ms, resolved_source,
      latitude, longitude, location_source, place_name, ai_tags, face_count, embedding,
      thumbnail_path, faces_indexed, visual_indexed, person_class, confidence
    FROM media_items
    WHERE is_missing = 0 AND resolved_source = 'pending'
    ORDER BY mtime_ms ASC
  `).all();
}

function addRelationship(db, personAId, personBId, type) {
  if (personAId === personBId) {
    throw new Error('Cannot link a person to themselves.');
  }

  const existing = db.prepare(
    'SELECT id, relationship_type FROM relationships WHERE (person_a_id = ? AND person_b_id = ?) OR (person_a_id = ? AND person_b_id = ?)'
  ).get(personAId, personBId, personBId, personAId);
  if (existing) {
    throw new Error(`These two people already have a "${existing.relationship_type}" relationship.`);
  }

  if (type === 'parent-child') {
    const allRels = db.prepare('SELECT person_a_id, person_b_id, relationship_type FROM relationships').all();
    const err = validateNoAncestorCycle(personAId, personBId, allRels);
    if (err) throw new Error(err);
  }

  return db.prepare(`
    INSERT OR IGNORE INTO relationships (person_a_id, person_b_id, relationship_type, created_at_ms)
    VALUES (?, ?, ?, ?)
  `).run(personAId, personBId, type, Date.now());
}

function validateNoAncestorCycle(parentId, childId, relationships) {
  const childrenOf = new Map();
  const peerAdj = new Map();
  for (const r of relationships) {
    if (r.relationship_type === 'parent-child') {
      if (!childrenOf.has(r.person_a_id)) childrenOf.set(r.person_a_id, []);
      childrenOf.get(r.person_a_id).push(r.person_b_id);
    } else {
      if (!peerAdj.has(r.person_a_id)) peerAdj.set(r.person_a_id, []);
      if (!peerAdj.has(r.person_b_id)) peerAdj.set(r.person_b_id, []);
      peerAdj.get(r.person_a_id).push(r.person_b_id);
      peerAdj.get(r.person_b_id).push(r.person_a_id);
    }
  }

  function expandPeerGroup(id) {
    const group = new Set();
    const q = [id];
    while (q.length > 0) {
      const cur = q.pop();
      if (group.has(cur)) continue;
      group.add(cur);
      for (const peer of (peerAdj.get(cur) || [])) q.push(peer);
    }
    return group;
  }

  const parentGroup = expandPeerGroup(parentId);
  const childGroup = expandPeerGroup(childId);

  if (parentGroup.has(childId) || childGroup.has(parentId)) {
    return 'Cannot set a spouse or sibling as a parent/child.';
  }

  const visited = new Set();
  const queue = [...childrenOf.get(childId) || []];
  for (const peer of childGroup) {
    for (const kid of (childrenOf.get(peer) || [])) queue.push(kid);
  }
  while (queue.length > 0) {
    const cur = queue.pop();
    if (visited.has(cur)) continue;
    visited.add(cur);
    const curGroup = expandPeerGroup(cur);
    for (const member of curGroup) {
      if (parentGroup.has(member)) {
        return 'This link would create a circular relationship.';
      }
      for (const kid of (childrenOf.get(member) || [])) queue.push(kid);
    }
  }

  return null;
}

function removeRelationship(db, relationshipId) {
  return db.prepare('DELETE FROM relationships WHERE id = ?').run(relationshipId);
}

function clearAllRelationships(db) {
  return db.prepare('DELETE FROM relationships').run();
}

function getRelationships(db) {
  return db.prepare('SELECT * FROM relationships').all();
}

function getFamilyTree(db) {
  const people = db.prepare(`
    SELECT p.*, COUNT(mf.id) as appearance_count
    FROM people p
    LEFT JOIN media_faces mf ON mf.person_id = p.id
    WHERE p.id NOT IN (${ANIMAL_ONLY_PEOPLE_SQL})
    GROUP BY p.id
    ORDER BY appearance_count DESC
  `).all();

  const relationships = db.prepare(`
    SELECT r.*, pa.name as person_a_name, pb.name as person_b_name
    FROM relationships r
    JOIN people pa ON pa.id = r.person_a_id
    JOIN people pb ON pb.id = r.person_b_id
  `).all();

  return { people, relationships };
}

function getSharedPhotos(db, personAId, personBId) {
  return db.prepare(`
    SELECT DISTINCT mi.*
    FROM media_items mi
    JOIN media_faces mfa ON mfa.media_id = mi.id AND mfa.person_id = ?
    JOIN media_faces mfb ON mfb.media_id = mi.id AND mfb.person_id = ?
    WHERE mi.is_missing = 0
    ORDER BY mi.resolved_time_ms DESC
  `).all(personAId, personBId);
}

function replacePendingIndexJobs(db, stage, jobs = []) {
  const pendingJobs = Array.isArray(jobs) ? jobs.filter((job) => job && job.mediaId) : [];
  const deleteStage = db.prepare('DELETE FROM index_jobs WHERE stage = ?');
  const insertJob = db.prepare(`
    INSERT INTO index_jobs (media_id, stage, status, payload_json, priority, attempts, last_error, updated_at_ms)
    VALUES (?, ?, 'pending', ?, ?, 0, NULL, ?)
  `);

  const tx = db.transaction((stageName, stageJobs) => {
    deleteStage.run(stageName);
    const now = Date.now();
    for (const job of stageJobs) {
      insertJob.run(job.mediaId, stageName, JSON.stringify(job), 0, now);
    }
  });

  tx(stage, pendingJobs);
  return { stage, count: pendingJobs.length };
}

function loadPendingIndexJobs(db, stage, limit = 5000) {
  const safeLimit = Math.max(1, Math.min(10000, Number(limit) || 5000));
  return db.prepare(`
    SELECT media_id, payload_json
    FROM index_jobs
    WHERE stage = ? AND status = 'pending'
    ORDER BY priority DESC, id ASC
    LIMIT ?
  `).all(stage, safeLimit).map((row) => {
    try {
      return JSON.parse(row.payload_json);
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
}

function completeIndexJobs(db, stage, jobs = []) {
  const mediaIds = Array.from(new Set((jobs || []).map((job) => job?.mediaId).filter(Boolean)));
  if (mediaIds.length === 0) return { stage, deletedCount: 0 };

  const deleteJob = db.prepare(`DELETE FROM index_jobs WHERE stage = ? AND media_id = ?`);
  const tx = db.transaction((stageName, ids) => {
    let deletedCount = 0;
    for (const mediaId of ids) {
      deletedCount += deleteJob.run(stageName, mediaId).changes;
    }
    return deletedCount;
  });

  return {
    stage,
    deletedCount: tx(stage, mediaIds),
  };
}

function getIndexJobCounts(db) {
  return db.prepare(`
    SELECT stage, status, COUNT(*) AS count
    FROM index_jobs
    GROUP BY stage, status
    ORDER BY stage ASC, status ASC
  `).all();
}

module.exports = {
  upsertMediaItems,
  quickUpsertMediaItems,
  getActiveMediaItems,
  getUnprocessedMediaItems,
  replaceEvents,
  getEventsForRenderer,
  getEventSummaryPage,
  getClusterItems,
  getPersonCluster,
  getIndexStats,
  insertFace,
  updateMediaEmbedding,
  updateMediaVisualAnalysis,
  createPersonMatcher,
  findClosestPerson,
  createPerson,
  getPeople,
  renamePerson,
  deleteFacesForMediaId,
  pruneOrphanPeople,
  purgeAnimalFalsePositivePeople,
  deleteMediaItemsByPaths,
  addRelationship,
  removeRelationship,
  clearAllRelationships,
  getRelationships,
  getFamilyTree,
  getSharedPhotos,
  replacePendingIndexJobs,
  loadPendingIndexJobs,
  completeIndexJobs,
  getIndexJobCounts,
};
