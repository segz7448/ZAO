/**
 * ZAO - Save Image to Gallery
 *
 * Thin wrapper around expo-media-library for the one thing the chat UI
 * needs: take a local file:// image (a user-attached photo, saved
 * on-device via chatStore.js's copyAttachmentLocally - image generation/
 * FLUX has been removed, so this no longer handles AI-generated images)
 * and put it in the device's Photos/Gallery, in its own "ZAO" album so
 * these don't get mixed in with the rest of the camera roll.
 */

import * as MediaLibrary from 'expo-media-library';

const ALBUM_NAME = 'ZAO';

/**
 * Saves a local image file to the device gallery, creating (or reusing)
 * a "ZAO" album. Requests permission if not already granted.
 *
 * @param {string} localUri - file:// URI of the image to save
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
export async function saveImageToGallery(localUri) {
  try {
    const { status, canAskAgain } = await MediaLibrary.requestPermissionsAsync();

    if (status !== 'granted') {
      return {
        success: false,
        error: canAskAgain
          ? 'Photos permission is needed to save this image.'
          : 'Photos permission was denied. Enable it in your device Settings to save images.',
      };
    }

    const asset = await MediaLibrary.createAssetAsync(localUri);

    // Group saved images into a "ZAO" album rather than dropping them
    // loose into the camera roll - getAlbumAsync/createAlbumAsync is the
    // documented way to add-to-or-create an album for an existing asset.
    const existingAlbum = await MediaLibrary.getAlbumAsync(ALBUM_NAME);
    if (existingAlbum) {
      await MediaLibrary.addAssetsToAlbumAsync([asset], existingAlbum, false);
    } else {
      await MediaLibrary.createAlbumAsync(ALBUM_NAME, asset, false);
    }

    return { success: true, error: null };
  } catch (err) {
    console.error('[Gallery] saveImageToGallery failed:', err);
    return { success: false, error: 'Could not save image to your photos.' };
  }
}
