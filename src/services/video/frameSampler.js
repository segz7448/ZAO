/**
 * ZAO - Video Frame Sampler
 *
 * Extracts frames from a local video file at even intervals using
 * expo-video-thumbnails.
 *
 * HONEST NOTE ON A DEPRECATED DEPENDENCY: expo-video-thumbnails is
 * officially deprecated by Expo in favor of expo-video's
 * generateThumbnailsAsync. It is used here anyway, deliberately, because:
 * (1) it is still published and functional as of this writing (v56.0.3,
 * recent release, works on Expo SDK 57), (2) the replacement API is
 * meaningfully more complex for zero functional benefit in this use case -
 * it requires an active VideoPlayer instance (player.generateThumbnailsAsync)
 * plus expo-image-manipulator post-processing just to get a usable file URI,
 * whereas expo-video-thumbnails is a single direct call on a video URI with
 * no player lifecycle to manage. If a future Expo SDK actually removes this
 * package (not just deprecates it), this file is the only place that needs
 * to change - swap getThumbnailAsync here for the expo-video-based
 * equivalent once forced to.
 */

import * as VideoThumbnails from 'expo-video-thumbnails';
import * as FileSystem from 'expo-file-system/legacy';

const MAX_FRAMES = 8;

/**
 * @param {string} videoUri - local file:// URI of the video
 * @param {number} durationMs - video duration in milliseconds (caller must
 * supply this - expo-video-thumbnails doesn't probe duration itself)
 * @returns {Promise<{success: boolean, frameDataUrls: string[], error: string|null}>}
 */
export async function sampleVideoFrames(videoUri, durationMs) {
  try {
    if (!durationMs || durationMs <= 0) {
      return {
        success: false,
        frameDataUrls: [],
        error: 'Could not determine video duration - cannot sample frames.',
      };
    }

    const frameCount = Math.min(MAX_FRAMES, Math.max(1, Math.floor(durationMs / 2000)));
    const intervalMs = durationMs / (frameCount + 1);

    const frameDataUrls = [];
    for (let i = 1; i <= frameCount; i++) {
      const timeMs = Math.round(intervalMs * i);
      try {
        const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, { time: timeMs, quality: 0.6 });
        const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
        frameDataUrls.push(`data:image/jpeg;base64,${base64}`);
        FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      } catch (frameErr) {
        console.error(`[VideoFrameSampler] failed to extract frame at ${timeMs}ms:`, frameErr);
      }
    }

    if (frameDataUrls.length === 0) {
      return {
        success: false,
        frameDataUrls: [],
        error: 'Could not extract any frames from this video. It may be corrupted or in an unsupported format.',
      };
    }

    return { success: true, frameDataUrls, error: null };
  } catch (err) {
    console.error('[VideoFrameSampler] sampleVideoFrames failed:', err);
    return {
      success: false,
      frameDataUrls: [],
      error: 'Could not process this video file.',
    };
  }
}
