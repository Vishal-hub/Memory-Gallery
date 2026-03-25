const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Set the path to the statically compiled ffmpeg and ffprobe binaries
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

/**
 * Extracts a single frame from the middle of a video file.
 * @param {string} videoPath - Absolute path to the video file.
 * @returns {Promise<string>} - Absolute path to the extracted temporary image, or null if failed.
 */
async function extractFrame(videoPath) {
  return new Promise((resolve, reject) => {
    const tempDir = path.join(os.homedir(), '.memory-desktop', 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const outputFilename = `frame_${Date.now()}_${path.basename(videoPath)}.jpg`;
    const outputPath = path.join(tempDir, outputFilename);

    // Extract a frame at the 1-second mark (or 50% if the video is shorter)
    ffmpeg(videoPath)
      .screenshots({
        timestamps: ['50%'],
        filename: outputFilename,
        folder: tempDir,
        size: '300x?' // Scale down for faster AI processing
      })
      .on('end', () => {
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error(`Error extracting frame from ${videoPath}:`, err);
        resolve(null); // Resolve to null instead of rejecting to gracefully skip
      });
  });
}

module.exports = {
  extractFrame
};
