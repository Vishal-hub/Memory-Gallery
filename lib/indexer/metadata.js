const exifr = require('exifr');


function toNumber(value) {
    if (Array.isArray(value)) {
        return value.map(toNumber);
    }
    if (value && typeof value === 'object') {
        if ('numerator' in value && 'denominator' in value && value.denominator !== 0) {
            return value.numerator / value.denominator;
        }
        if ('value' in value) {
            const parsed = parseFloat(value.value);
            return Number.isFinite(parsed) ? parsed : null;
        }
    }
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseDmsString(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/(-?\d+(?:\.\d+)?)°\s*(\d+(?:\.\d+)?)'\s*(\d+(?:\.\d+)?)"/);
    if (!match) return null;
    const deg = parseFloat(match[1]);
    const min = parseFloat(match[2]);
    const sec = parseFloat(match[3]);
    if ([deg, min, sec].some((v) => Number.isNaN(v))) return null;
    return deg + min / 60 + sec / 3600;
}

function convertCoordinate(value, ref) {
    if (Array.isArray(value) && value.length === 3) {
        const [deg, min, sec] = value;
        const numbers = [deg, min, sec].map((v) => Array.isArray(v) || (v && typeof v === 'object') ? toNumber(v) : toNumber(v));
        if (numbers.some((n) => typeof n !== 'number' || Number.isNaN(n))) {
            return null;
        }
        value = numbers[0] + numbers[1] / 60 + numbers[2] / 3600;
    } else if (typeof value === 'string' && value.includes('°')) {
        const parsed = parseDmsString(value);
        if (parsed !== null) value = parsed;
    } else {
        value = toNumber(value);
    }

    if (value === null || Number.isNaN(value)) return null;

    if (ref === 'S' || ref === 'W') {
        return value * -1;
    }

    return value;
}

async function resolveMediaMetadata(file) {
    if (file.mediaType === 'video') {
        return {
            resolvedTimeMs: file.mtimeMs,
            source: 'filesystem_mtime',
            latitude: null,
            longitude: null,
            locationSource: null,
            confidence: 0.6,
        };
    }

    try {
        const meta = await exifr.parse(file.path, ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef']);
        const candidate = meta?.DateTimeOriginal || meta?.CreateDate || meta?.ModifyDate;
        const latitude = convertCoordinate(meta?.GPSLatitude, meta?.GPSLatitudeRef);
        const longitude = convertCoordinate(meta?.GPSLongitude, meta?.GPSLongitudeRef);
        let finalLat = latitude;
        let finalLon = longitude;
        let locationSource = 'exif_gps';

        if (typeof latitude !== 'number' || typeof longitude !== 'number') {
            const gpsBackup = await exifr.gps(file.path);
            if (typeof gpsBackup?.latitude === 'number' && typeof gpsBackup?.longitude === 'number') {
                finalLat = gpsBackup.latitude;
                finalLon = gpsBackup.longitude;
                locationSource = 'exif_gps_helper';
            }
        }

        const hasGps = typeof finalLat === 'number' && typeof finalLon === 'number';
        const gps = hasGps
            ? { latitude: finalLat, longitude: finalLon, locationSource }
            : { latitude: null, longitude: null, locationSource: null };

        if (hasGps) {
            console.log(`[Metadata] EXIF GPS detected for ${file.path}: ${finalLat.toFixed(6)},${finalLon.toFixed(6)} via ${locationSource}`);
        } else {
            const details = {
                GPSLatitude: meta?.GPSLatitude,
                GPSLongitude: meta?.GPSLongitude,
                GPSLatitudeRef: meta?.GPSLatitudeRef,
                GPSLongitudeRef: meta?.GPSLongitudeRef,
            };
            console.log(`[Metadata] No GPS coordinates in EXIF for ${file.path} (${JSON.stringify(details)})`);
        }

        if (candidate) {
            const ts = new Date(candidate).getTime();
            if (!Number.isNaN(ts)) {
                return {
                    resolvedTimeMs: ts,
                    source: meta?.DateTimeOriginal ? 'exif_datetime_original' : 'exif_fallback',
                    ...gps,
                    confidence: meta?.DateTimeOriginal ? 0.95 : 0.85,
                };
            }
        }

        return {
            resolvedTimeMs: file.mtimeMs,
            source: 'filesystem_mtime',
            ...gps,
            confidence: 0.6,
        };
    } catch (error) {
        return {
            resolvedTimeMs: file.mtimeMs,
            source: 'filesystem_mtime',
            latitude: null,
            longitude: null,
            locationSource: null,
            confidence: 0.6,
        };
    }
}

module.exports = {
    resolveMediaMetadata,
};
