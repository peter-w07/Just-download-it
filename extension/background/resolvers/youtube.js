/*
 * YouTube links (youtube.com, youtu.be, Shorts, embeds): resolved straight from
 * the service worker with the same player data the watch page button uses.
 */
import '../../shared/util.js';
import '../../content/handlers/youtube.js';
import { resolveVideo } from '../youtube.js';

const { youtube } = globalThis.JDI;

export default {
  id: 'youtube',
  matches: (url) => /(^|\.)(youtube\.com|youtube-nocookie\.com)$|^youtu\.be$/i.test(url.hostname) && url.hostname !== 'music.youtube.com' && !!youtube.videoIdFromUrl(url.href),
  resolve: (url) => resolveVideo(youtube.videoIdFromUrl(url.href)),
};
