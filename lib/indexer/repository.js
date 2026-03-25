function upsertMediaItems(db, files, runId) {
  const selectByPath = db.prepare('SELECT * FROM media_items WHERE path = ?');
  const upsert = db.prepare(`
    INSERT INTO media_items (path, ext, media_type, size, mtime_ms, resolved_time_ms, resolved_source, latitude, longitude, location_source, place_name, ai_tags, face_count, embedding, thumbnail_path, faces_indexed, visual_indexed, confidence, last_seen_run, is_missing)
    VALUES (@path, @ext, @mediaType, @size, @mtimeMs, @resolvedTimeMs, @resolvedSource, @latitude, @longitude, @locationSource, @placeName, @aiTags, @faceCount, @embedding, @thumbnailPath, @facesIndexed, @visualIndexed, @confidence, @lastSeenRun, 0)
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
      faces_indexed = CASE WHEN mtime_ms != excluded.mtime_ms THEN 0 ELSE faces_indexed END,
      visual_indexed = CASE WHEN mtime_ms != excluded.mtime_ms THEN 0 ELSE visual_indexed END,
      confidence = excluded.confidence,
      last_seen_run = excluded.last_seen_run,
      is_missing = 0
  `);
  const markMissing = db.prepare('UPDATE media_items SET last_seen_run = -1 WHERE 0'); // placeholder
  const realMarkMissing = db.prepare('UPDATE media_items SET is_missing = 1 WHERE last_seen_run < ?');
  const updateLastSeen = db.prepare('UPDATE media_items SET last_seen_run = ?, is_missing = 0 WHERE path = ?');
  return { selectByPath, upsert, markMissing: realMarkMissing, updateLastSeen };
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
  const clearEvents = db.prepare('DELETE FROM events');
  const clearEventItems = db.prepare('DELETE FROM event_items');
  const insertEvent = db.prepare(`
    INSERT INTO events (id, start_time_ms, end_time_ms, item_count, center_lat, center_lon, location_count, place_name, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEventItem = db.prepare(`
    INSERT INTO event_items (event_id, media_id, sort_index)
    VALUES (?, ?, ?)
  `);

  const tx = db.transaction((eventRows) => {
    clearEventItems.run();
    clearEvents.run();
    eventRows.forEach((event) => {
      insertEvent.run(
        event.id,
        event.startTimeMs,
        event.endTimeMs,
        event.items.length,
        event.centerLat,
        event.centerLon,
        event.locationCount,
        event.placeName || null,
        Date.now()
      );
      event.items.forEach((item, idx) => {
        insertEventItem.run(event.id, item.id, idx);
      });
    });
  });
  tx(events);
}

function getEventsForRenderer(db, groupBy = 'date') {
  const itemRowsStmt = db.prepare(`
    SELECT
      m.path,
      m.media_type,
      m.resolved_time_ms,
      m.latitude,
      m.longitude,
      m.place_name,
      m.ai_tags,
      m.face_count,
      m.thumbnail_path,
      GROUP_CONCAT(p.name, ', ') AS person_names
    FROM event_items ei
    JOIN media_items m ON m.id = ei.media_id
    LEFT JOIN media_faces mf ON mf.media_id = m.id
    LEFT JOIN people p ON p.id = mf.person_id
    WHERE ei.event_id = ?
    GROUP BY m.id
    ORDER BY ei.sort_index ASC
  `);

  const eventRows = db.prepare(`
    SELECT id, start_time_ms, end_time_ms, item_count, center_lat, center_lon, location_count, place_name
    FROM events
    ORDER BY start_time_ms ASC, id ASC
  `).all();

  const baseClusters = eventRows.map((event) => ({
    id: event.id,
    items: itemRowsStmt.all(event.id).map((item) => ({
      path: item.path,
      thumbnailPath: item.thumbnail_path,
      type: item.media_type,
      createdAt: item.resolved_time_ms,
      latitude: item.latitude,
      longitude: item.longitude,
      placeName: item.place_name,
      aiTags: item.ai_tags,
      faceCount: item.face_count,
      personNames: item.person_names,
    })),
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
          type: item.media_type,
          createdAt: item.resolved_time_ms,
          latitude: item.latitude,
          longitude: item.longitude,
          placeName: item.place_name,
          aiTags: item.ai_tags,
          faceCount: item.face_count,
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
    const allItems = db.prepare(`
      SELECT m.*, mf.person_id, p2.name as person_name, GROUP_CONCAT(p.name, ', ') AS person_names
      FROM media_items m
      JOIN media_faces mf ON mf.media_id = m.id
      JOIN people p2 ON p2.id = mf.person_id
      LEFT JOIN media_faces mf2 ON mf2.media_id = m.id
      LEFT JOIN people p ON p.id = mf2.person_id
      WHERE m.is_missing = 0
      GROUP BY m.id, mf.person_id
    `).all();

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
          type: item.media_type,
          createdAt: item.resolved_time_ms,
          latitude: item.latitude,
          longitude: item.longitude,
          placeName: item.place_name,
          aiTags: item.ai_tags,
          faceCount: item.face_count,
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

  return {
    activeMedia: totals?.active_count || 0,
    missingMedia: totals?.missing_count || 0,
    totalMedia: totals?.total_count || 0,
    events: eventCountRow?.count || 0,
    geotaggedMedia: geotaggedRow?.count || 0,
    sourceBreakdown,
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

function updateMediaVisualAnalysis(db, mediaId, analysis, options = {}) {
  const {
    faceIndexComplete = false,
  } = options;
  return db.prepare(`
    UPDATE media_items
    SET ai_tags = ?,
        face_count = ?,
        visual_indexed = 1,
        faces_indexed = CASE WHEN ? THEN 1 ELSE faces_indexed END
    WHERE id = ?
  `).run(
    analysis?.tags || '',
    Number.isFinite(analysis?.faceCount) ? analysis.faceCount : 0,
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

module.exports = {
  upsertMediaItems,
  getActiveMediaItems,
  replaceEvents,
  getEventsForRenderer,
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
  deleteMediaItemsByPaths,
};
