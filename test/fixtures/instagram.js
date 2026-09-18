// Media objects shaped like www.instagram.com/api/v1/media/<pk>/info/ responses
// (field names and candidate lists copied from live responses in September 2026;
// URLs and ids are fake). `cdn` lets the e2e test point media at a local server.

const SQUARES = [1080, 750, 640, 480, 320, 240, 150];

function candidates(cdn, file, w, h, widths) {
  const list = widths.map((cw) => ({ width: cw, height: Math.round((cw * h) / w), url: `${cdn}/v/t51.82787-15/${file}?stp=dst-jpg_e35_p${cw}x${cw}&oh=abc&oe=68D0` }));
  // Instagram also lists square center crops of every photo.
  for (const s of SQUARES) list.push({ width: s, height: s, url: `${cdn}/v/t51.82787-15/${file}?stp=c0.240.1440.1440a_dst-jpg_s${s}x${s}&oh=def&oe=68D0` });
  return list;
}

export function photo(cdn, { pk = '3987643744926460007', code = 'DdW9NvLJmhn', file = '550001_4961394081366993_n.jpg' } = {}) {
  return {
    pk,
    id: `${pk}_1234`,
    code,
    media_type: 1,
    taken_at: 1789500000,
    original_width: 1440,
    original_height: 1800,
    user: { pk: '1234', username: 'some.user' },
    image_versions2: { candidates: candidates(cdn, file, 1440, 1800, [1440, 1080, 720, 640, 480, 320, 240]) },
  };
}

export function dashManifest(cdn) {
  return `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" minBufferTime="PT1.500S" type="static" mediaPresentationDuration="PT0H0M15.2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period duration="PT0H0M15.2S">
    <AdaptationSet segmentAlignment="true" maxWidth="1080" maxHeight="1920" maxFrameRate="30" par="9:16" lang="und" subsegmentAlignment="true" subsegmentStartsWithSAP="1">
      <Representation id="1" mimeType="video/mp4" codecs="vp09.00.30.08" width="360" height="640" frameRate="30" sar="1:1" startWithSAP="1" bandwidth="618000" FBQualityClass="sd" FBQualityLabel="360w">
        <BaseURL>${cdn}/o1/v/t2/f2/m78/video-360.mp4?efg=x&amp;oh=1</BaseURL>
        <SegmentBase indexRangeExact="true" indexRange="908-1011" FBFirstSegmentRange="1012-80000"><Initialization range="0-907"/></SegmentBase>
      </Representation>
      <Representation id="2" mimeType="video/mp4" codecs="vp09.00.40.08" width="1080" height="1920" frameRate="30" sar="1:1" startWithSAP="1" bandwidth="4400000" FBQualityClass="hd" FBQualityLabel="1080w">
        <BaseURL>${cdn}/o1/v/t2/f2/m78/video-1080.mp4?efg=x&amp;oh=2</BaseURL>
        <SegmentBase indexRangeExact="true" indexRange="908-1011"><Initialization range="0-907"/></SegmentBase>
      </Representation>
      <Representation id="3" mimeType="video/mp4" codecs="vp09.00.31.08" width="720" height="1280" frameRate="30" sar="1:1" startWithSAP="1" bandwidth="2762000" FBQualityClass="hd" FBQualityLabel="720w">
        <BaseURL>${cdn}/o1/v/t2/f2/m78/video-720.mp4?efg=x&amp;oh=3</BaseURL>
        <SegmentBase indexRangeExact="true" indexRange="908-1011"><Initialization range="0-907"/></SegmentBase>
      </Representation>
    </AdaptationSet>
    <AdaptationSet segmentAlignment="true" lang="und" subsegmentAlignment="true" subsegmentStartsWithSAP="1">
      <Representation id="4" mimeType="audio/mp4" codecs="mp4a.40.5" audioSamplingRate="44100" startWithSAP="1" bandwidth="59000">
        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>
        <BaseURL>${cdn}/o1/v/t2/f2/m69/audio.mp4?efg=y&amp;oh=4</BaseURL>
        <SegmentBase indexRangeExact="true" indexRange="824-915"><Initialization range="0-823"/></SegmentBase>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
}

export function reel(cdn, { pk = '3987012397518883815', code = 'DdUtqbFMQvn', cover = '812133324_18191130355397912_3084360459491823383_n.jpg' } = {}) {
  const video = `${cdn}/o1/v/t16/f2/m86/progressive-720.mp4`;
  return {
    pk,
    id: `${pk}_5678`,
    code,
    media_type: 2,
    product_type: 'clips',
    taken_at: 1789400000,
    has_audio: true,
    original_width: 720,
    original_height: 1280,
    user: { pk: '5678', username: 'reel_maker' },
    image_versions2: { candidates: candidates(cdn, cover, 720, 1280, [720, 640, 480, 320, 240]) },
    // Three entries, one file: Instagram repeats it with different query strings.
    video_versions: [101, 102, 103].map((type) => ({ type, width: 720, height: 1280, url: `${video}?efg=${type}&oh=9`, id: String(type) })),
    video_dash_manifest: dashManifest(cdn),
  };
}

export function carousel(cdn, { pk = '3986194019465083888', code = 'DdRzldIALvw' } = {}) {
  const slides = [];
  for (let i = 0; i < 3; i++) {
    const p = photo(cdn, { pk: `398619401946508${3900 + i}`, code: undefined, file: `77000${i}_0818699158354293_n.jpg` });
    delete p.code;
    delete p.user;
    delete p.taken_at;
    p.original_width = 3273;
    p.original_height = 4096;
    p.image_versions2 = { candidates: candidates(cdn, `77000${i}_0818699158354293_n.jpg`, 3273, 4096, [3273, 1080, 720, 640, 480, 320, 240]) };
    slides.push(p);
  }
  // A video slide in the middle of a carousel.
  const v = reel(cdn, { pk: '3986194019465083950', cover: '770009_video_cover_n.jpg' });
  delete v.code;
  delete v.user;
  slides.splice(1, 0, v);
  return {
    pk,
    id: `${pk}_4321`,
    code,
    media_type: 8,
    taken_at: 1789300000,
    user: { pk: '4321', username: 'jack.example' },
    original_width: 3273,
    original_height: 4096,
    image_versions2: slides[0].image_versions2,
    carousel_media: slides,
  };
}
