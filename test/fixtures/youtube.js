// A /youtubei/v1/player response shaped like the VISIONOS client's answer
// (field names and format list from live responses in September 2026; URLs
// are fake). `gvs` lets the e2e test point streams at a local server.

function url(gvs, itag, extra = '') {
  return `${gvs}/videoplayback?expire=1789633515&ei=x&ip=1.2.3.4&id=o-test&itag=${itag}&source=youtube&mime=video%2Fmp4&c=VISIONOS${extra}`;
}

export function player(gvs, { videoId = 'dQw4w9WgXcQ', title = 'Never Gonna Give You Up', length = 213 } = {}) {
  const v = (itag, codec, container, w, h, label, fps, bitrate, len) => ({
    itag,
    url: url(gvs, itag),
    mimeType: `video/${container}; codecs="${codec}"`,
    bitrate,
    width: w,
    height: h,
    fps,
    quality: label,
    qualityLabel: label,
    contentLength: String(len),
    approxDurationMs: String(length * 1000),
  });
  const a = (itag, codec, container, bitrate, len, extra = {}) => ({
    itag,
    url: url(gvs, itag, extra.isDrc ? '&xtags=drc' : ''),
    mimeType: `audio/${container}; codecs="${codec}"`,
    bitrate,
    averageBitrate: bitrate - 2000,
    audioQuality: bitrate > 100000 ? 'AUDIO_QUALITY_MEDIUM' : 'AUDIO_QUALITY_LOW',
    audioSampleRate: '48000',
    audioChannels: 2,
    contentLength: String(len),
    approxDurationMs: String(length * 1000),
    ...extra,
  });
  return {
    playabilityStatus: { status: 'OK', playableInEmbed: true },
    videoDetails: {
      videoId,
      title,
      lengthSeconds: String(length),
      author: 'Rick Astley',
      isLiveContent: false,
      thumbnail: {
        thumbnails: [
          { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg?sqp=abc`, width: 168, height: 94 },
          { url: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, width: 1280, height: 720 },
        ],
      },
    },
    streamingData: {
      expiresInSeconds: '21540',
      adaptiveFormats: [
        v(313, 'vp9', 'webm', 3840, 2160, '2160p', 25, 18000000, 359000000),
        v(401, 'av01.0.12M.08', 'mp4', 3840, 2160, '2160p', 25, 12000000, 240000000),
        v(271, 'vp9', 'webm', 2560, 1440, '1440p', 25, 9000000, 151000000),
        v(137, 'avc1.640028', 'mp4', 1920, 1080, '1080p', 25, 4400000, 81000000),
        v(248, 'vp9', 'webm', 1920, 1080, '1080p', 25, 2600000, 31000000),
        v(399, 'av01.0.08M.08', 'mp4', 1920, 1080, '1080p', 25, 2100000, 30000000),
        v(136, 'avc1.4d401f', 'mp4', 1280, 720, '720p', 25, 1500000, 26000000),
        v(247, 'vp9', 'webm', 1280, 720, '720p', 25, 1100000, 18000000),
        v(134, 'avc1.4d401e', 'mp4', 640, 360, '360p', 25, 400000, 8000000),
        a(139, 'mp4a.40.5', 'mp4', 49000, 1300000),
        a(140, 'mp4a.40.2', 'mp4', 130000, 3400000, { isDrc: true, xtags: 'CggKA2RyYxIBMQ' }),
        a(140, 'mp4a.40.2', 'mp4', 129000, 3450000),
        a(251, 'opus', 'webm', 136000, 3500000),
      ],
      serverAbrStreamingUrl: `${gvs}/sabr`,
    },
  };
}
