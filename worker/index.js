/**
 * MediaGrab - Cloudflare Worker
 * Architecture: Stream-through (zero storage, zero cost)
 * User → Worker → Platform API → Direct download URL → User
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
  'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

const err = (msg, status = 400) => json({ error: msg, ok: false }, status);

// ─── PLATFORM HANDLERS ──────────────────────────────────────────────────────

/**
 * YouTube: Thumbnails + oEmbed metadata (no API key needed)
 * These thumbnail URLs are always publicly accessible
 */
async function handleYouTube(url) {
  const id = extractYouTubeId(url);
  if (!id) return { error: 'Invalid YouTube URL' };

  // Fetch oEmbed for title/author (public endpoint)
  let meta = {};
  try {
    const r = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (r.ok) meta = await r.json();
  } catch (_) {}

  // Check which resolutions actually exist (maxres isn't always available)
  const candidates = [
    { key: 'maxres', label: 'Max Resolution', url: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg` },
    { key: 'sd', label: 'Standard (640×480)', url: `https://i.ytimg.com/vi/${id}/sddefault.jpg` },
    { key: 'hq', label: 'High Quality (480×360)', url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` },
    { key: 'mq', label: 'Medium Quality (320×180)', url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` },
    { key: 'default', label: 'Default (120×90)', url: `https://i.ytimg.com/vi/${id}/default.jpg` },
  ];

  // Verify maxres exists (returns 120x90 placeholder if not)
  const checked = await Promise.all(
    candidates.map(async (c) => {
      try {
        const r = await fetch(c.url, { method: 'HEAD' });
        // maxresdefault returns 200 even with placeholder, check content-length
        if (c.key === 'maxres') {
          const cl = parseInt(r.headers.get('content-length') || '0');
          return cl > 5000 ? c : null; // placeholder is ~1KB, real is >5KB
        }
        return r.ok ? c : null;
      } catch (_) {
        return null;
      }
    })
  );

  return {
    ok: true,
    platform: 'youtube',
    type: 'thumbnails',
    id,
    title: meta.title || 'YouTube Video',
    author: meta.author_name || '',
    thumbnails: checked.filter(Boolean),
  };
}

/**
 * Twitter/X: Videos via syndication API (no auth)
 */
async function handleTwitter(url) {
  const id = extractTwitterId(url);
  if (!id) return { error: 'Invalid Twitter/X URL' };

  const apiUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&features=tfw_timeline_list%3A%3Btfw_follower_count_sunset%3Atrue%3Btfw_tweet_edit_backend%3Aon%3Btfw_refsrc_session%3Aon%3Btfw_show_blue_verified_badge%3Aon%3Btfw_mixed_media_15897%3Atreatment%3Btfw_experiments_cookie_expiration%3A1209600%3Btfw_show_birdwatch_pivots_enabled%3Aon%3Btfw_duplicate_scribes_to_settings%3Aon%3Btfw_use_profile_image_shape_enabled%3Aon%3Btfw_video_hls_dynamic_manifests_15082%3Atrue_bitrate%3Btfw_legacy_timeline_sunset%3Atrue%3Btfw_tweet_edit_frontend%3Aon&token=4c2mmul6mnh`;

  try {
    const r = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible)',
        'Accept': 'application/json',
        'Origin': 'https://platform.twitter.com',
        'Referer': 'https://platform.twitter.com/',
      },
    });

    if (!r.ok) return { error: 'Tweet not found or private' };
    const data = await r.json();

    const variants = data?.video?.variants || [];
    const mp4 = variants
      .filter((v) => v.type === 'video/mp4' && v.src)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
      .map((v) => ({
        label: v.bitrate >= 2176000 ? '1080p' : v.bitrate >= 832000 ? '720p' : v.bitrate >= 256000 ? '360p' : 'Low',
        bitrate: v.bitrate,
        url: v.src,
      }));

    // Also grab photos
    const photos = (data?.photos || []).map((p) => ({ url: p.url, label: 'Photo' }));

    if (!mp4.length && !photos.length) {
      return { error: 'No downloadable media found in this tweet' };
    }

    return {
      ok: true,
      platform: 'twitter',
      type: mp4.length ? 'video' : 'images',
      id,
      text: data.text?.slice(0, 100) || '',
      author: data.user?.name || '',
      videos: mp4,
      photos,
    };
  } catch (e) {
    return { error: 'Failed to fetch tweet: ' + e.message };
  }
}

/**
 * Instagram: Public posts via embed/oEmbed (no API key for public posts)
 */
async function handleInstagram(url) {
  const id = extractInstagramId(url);
  if (!id) return { error: 'Invalid Instagram URL' };

  try {
    // oEmbed is public and doesn't need auth
    const r = await fetch(
      `https://api.instagram.com/oembed/?url=https://www.instagram.com/p/${id}/&maxwidth=1080`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );

    if (!r.ok) return { error: 'Post not found or is private' };
    const data = await r.json();

    return {
      ok: true,
      platform: 'instagram',
      type: 'image',
      id,
      title: data.title || 'Instagram Post',
      author: data.author_name || '',
      thumbnail: data.thumbnail_url,
      thumbnailWidth: data.thumbnail_width,
      thumbnailHeight: data.thumbnail_height,
      embedUrl: `https://www.instagram.com/p/${id}/embed/`,
      note: 'Instagram restricts direct downloads. Use the embed URL to view the full post.',
    };
  } catch (e) {
    return { error: 'Failed to fetch Instagram post' };
  }
}

/**
 * TikTok: Via oEmbed API (no auth needed for public videos)
 */
async function handleTikTok(url) {
  try {
    const r = await fetch(
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );

    if (!r.ok) return { error: 'TikTok video not found or private' };
    const data = await r.json();

    return {
      ok: true,
      platform: 'tiktok',
      type: 'info',
      title: data.title || 'TikTok Video',
      author: data.author_name || '',
      thumbnail: data.thumbnail_url,
      embedUrl: data.embed_url,
      note: 'TikTok restricts direct downloads via public APIs. Thumbnail is available for download.',
    };
  } catch (e) {
    return { error: 'Failed to fetch TikTok info' };
  }
}

/**
 * Reddit: Direct image/video/gallery posts
 */
async function handleReddit(url) {
  try {
    // Use Reddit's JSON API (append .json to any post URL)
    const postUrl = url.replace(/\/?$/, '.json');
    const r = await fetch(postUrl, {
      headers: {
        'User-Agent': 'MediaGrab/1.0 (compatible)',
        'Accept': 'application/json',
      },
    });

    if (!r.ok) return { error: 'Reddit post not found' };
    const data = await r.json();
    const post = data?.[0]?.data?.children?.[0]?.data;
    if (!post) return { error: 'Could not parse Reddit post' };

    const results = { ok: true, platform: 'reddit', title: post.title, author: post.author };

    // Direct image
    if (post.url_overridden_by_dest?.match(/\.(jpg|jpeg|png|gif|webp)/i)) {
      results.type = 'image';
      results.url = post.url_overridden_by_dest;
      return results;
    }

    // Reddit video
    if (post.is_video && post.media?.reddit_video) {
      const vid = post.media.reddit_video;
      results.type = 'video';
      results.url = vid.fallback_url?.replace('?source=fallback', '');
      results.width = vid.width;
      results.height = vid.height;
      results.duration = vid.duration;
      results.note = 'Audio and video are separate on Reddit. This is the video-only stream.';
      return results;
    }

    // Gallery
    if (post.is_gallery && post.media_metadata) {
      const images = Object.values(post.media_metadata)
        .filter((m) => m.status === 'valid')
        .map((m) => {
          const src = m.s;
          return {
            url: src?.u?.replace(/&amp;/g, '&') || src?.gif,
            width: src?.x,
            height: src?.y,
          };
        });
      results.type = 'gallery';
      results.images = images;
      results.count = images.length;
      return results;
    }

    return { error: 'No downloadable media found in this post' };
  } catch (e) {
    return { error: 'Failed to fetch Reddit post: ' + e.message };
  }
}

/**
 * Pinterest: Public image via oEmbed
 */
async function handlePinterest(url) {
  try {
    const r = await fetch(
      `https://www.pinterest.com/oembed/?url=${encodeURIComponent(url)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!r.ok) return { error: 'Pinterest pin not found' };
    const data = await r.json();
    return {
      ok: true,
      platform: 'pinterest',
      type: 'image',
      title: data.title || 'Pinterest Pin',
      author: data.author_name || '',
      thumbnail: data.thumbnail_url,
    };
  } catch (e) {
    return { error: 'Failed to fetch Pinterest pin' };
  }
}

// ─── URL PARSERS ─────────────────────────────────────────────────────────────

function extractYouTubeId(url) {
  const patterns = [
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i,
    /youtube\.com\/shorts\/([^"&?\/\s]{11})/i,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

function extractTwitterId(url) {
  const m = url.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/i);
  return m?.[1] || null;
}

function extractInstagramId(url) {
  const m = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i);
  return m?.[1] || null;
}

function detectPlatform(url) {
  if (/youtu\.be|youtube\.com/i.test(url)) return 'youtube';
  if (/twitter\.com|x\.com/i.test(url)) return 'twitter';
  if (/instagram\.com/i.test(url)) return 'instagram';
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  if (/reddit\.com/i.test(url)) return 'reddit';
  if (/pinterest\.(com|co)/i.test(url)) return 'pinterest';
  return null;
}

// ─── RATE LIMITING ────────────────────────────────────────────────────────────

async function checkRateLimit(env, ip) {
  if (!env?.KV) return true; // skip if KV not configured
  const key = `rl:${ip}`;
  const count = parseInt((await env.KV.get(key)) || '0');
  if (count >= 60) return false; // 60 req/hour per IP
  await env.KV.put(key, String(count + 1), { expirationTtl: 3600 });
  return true;
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return json({ ok: true, version: '1.0.0', ts: Date.now() });
    }

    // API route
    if (url.pathname === '/api/info' || url.pathname === '/api/download') {
      const mediaUrl = url.searchParams.get('url');
      if (!mediaUrl) return err('Missing ?url parameter');

      // Rate limiting
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const allowed = await checkRateLimit(env, ip);
      if (!allowed) return err('Rate limit exceeded. Try again in an hour.', 429);

      // Detect platform
      let platform = url.searchParams.get('platform') || detectPlatform(mediaUrl);
      if (!platform) return err('Unsupported platform. Supported: YouTube, Twitter/X, Instagram, TikTok, Reddit, Pinterest');

      // Dispatch
      let result;
      switch (platform.toLowerCase()) {
        case 'youtube': result = await handleYouTube(mediaUrl); break;
        case 'twitter': result = await handleTwitter(mediaUrl); break;
        case 'instagram': result = await handleInstagram(mediaUrl); break;
        case 'tiktok': result = await handleTikTok(mediaUrl); break;
        case 'reddit': result = await handleReddit(mediaUrl); break;
        case 'pinterest': result = await handlePinterest(mediaUrl); break;
        default: return err(`Unknown platform: ${platform}`);
      }

      if (result.error) return json({ ok: false, error: result.error }, 422);
      return json(result);
    }

    return err('Not found', 404);
  },
};
