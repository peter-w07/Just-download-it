// Generates what the e2e tests serve: a self-signed certificate and small
// media files shaped like Instagram's (JPEG photos, a VP9 video-only track, an
// AAC audio-only track, a progressive H.264+AAC MP4). Cached in test/e2e/.work.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().slice(-800) : '';
    throw new Error(`${cmd} failed: ${err.message}\n${stderr}`);
  }
}

export function prepare(workDir) {
  const media = join(workDir, 'media');
  const certs = join(workDir, 'certs');
  mkdirSync(media, { recursive: true });
  mkdirSync(certs, { recursive: true });

  const key = join(certs, 'key.pem');
  const cert = join(certs, 'cert.pem');
  if (!existsSync(cert)) {
    run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=jdi-test']);
  }

  const ffmpeg = (out, args) => {
    const path = join(media, out);
    if (!existsSync(path)) run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, path]);
    return path;
  };

  // Photos: distinct hues so a wrong file is visibly wrong.
  const photos = {
    'photo.jpg': [800, 1000, 0],
    'slide0.jpg': [800, 1000, 60],
    'slide1.jpg': [800, 1000, 120],
    'slide2.jpg': [800, 1000, 180],
    'cover.jpg': [720, 1280, 240],
    'video-cover.jpg': [720, 1280, 300],
    'avatar.jpg': [320, 320, 30],
    'ratelimited.jpg': [800, 1000, 90],
    'pic-400.jpg': [400, 300, 150],
    'pic-1200.jpg': [1200, 900, 210],
    'pic-1600.jpg': [1600, 1200, 270],
    'linked-full.jpg': [2000, 1500, 330],
    'poster.jpg': [320, 180, 20],
  };
  for (const [name, [w, h, hue]] of Object.entries(photos)) {
    ffmpeg(name, ['-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}`, '-vf', `hue=h=${hue}`, '-frames:v', '1', '-q:v', '4']);
  }

  // Instagram's DASH tracks are fragmented MP4s with a sidx.
  const frag = ['-movflags', '+frag_keyframe+empty_moov+default_base_moof+global_sidx'];
  ffmpeg('video-1080.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30', '-t', '2', '-c:v', 'libvpx-vp9', '-b:v', '400k', '-deadline', 'realtime', '-cpu-used', '8', '-an', ...frag]);
  ffmpeg('video-720.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30', '-t', '2', '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-an', ...frag]);
  ffmpeg('video-360.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30', '-t', '2', '-c:v', 'libvpx-vp9', '-b:v', '150k', '-deadline', 'realtime', '-cpu-used', '8', '-an', ...frag]);
  ffmpeg('audio.mp4', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', '-b:a', '64k', '-vn', ...frag]);
  ffmpeg('progressive-720.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
    '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart',
  ]);
  // YouTube-style adaptive tracks: H.264 video-only MP4, VP9 video-only WebM, Opus WebM.
  ffmpeg('yt-video-avc.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', ...frag,
  ]);
  ffmpeg('yt-video-vp9.webm', [
    '-f', 'lavfi', '-i', 'testsrc2=size=854x480:rate=25', '-t', '3', '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-an',
  ]);
  ffmpeg('yt-audio-opus.webm', ['-f', 'lavfi', '-i', 'sine=frequency=523:duration=3', '-c:a', 'libopus', '-b:a', '96k', '-vn']);
  ffmpeg('yt-audio-aac.mp4', ['-f', 'lavfi', '-i', 'sine=frequency=392:duration=3', '-c:a', 'aac', '-b:a', '128k', '-vn', ...frag]);
  ffmpeg('clip.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an',
  ]);

  return { media, key, cert };
}
