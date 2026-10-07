'use strict';

// Phase 4A manual test: prove yt-dlp YouTube search works from Node.js.
// No Discord, no voice, no downloads.
//
// Usage:
//   node src/youtube/search-test.js ["song name"]

const { searchYouTube, binaryVersion } = require('./search');

function formatCount(n) {
  if (typeof n !== 'number') return 'n/a';
  return n.toLocaleString('en-US');
}

async function main() {
  const query = process.argv[2] || 'Die With A Smile';

  const { binary, version, error } = await binaryVersion();
  console.log(`[yt-test] binary: ${binary}`);
  console.log(`[yt-test] version: ${version || `UNAVAILABLE (${error})`}`);
  console.log(`[yt-test] query: "${query}"`);
  console.log('');

  const results = await searchYouTube(query, { limit: 5 });
  console.log(`[yt-test] got ${results.length} candidate(s):`);
  console.log('');

  results.forEach((r, i) => {
    console.log(`${i + 1}. ${r.title || '(no title)'}`);
    console.log(`   Channel: ${r.channel || 'n/a'}`);
    console.log(`   ID: ${r.id || 'n/a'}`);
    console.log(`   URL: ${r.url || 'n/a'}`);
    console.log(`   Duration: ${r.duration || (r.durationSeconds ?? 'n/a')}`);
    console.log(`   Views: ${formatCount(r.viewCount)}`);
  });
}

main().catch((err) => {
  console.error('[yt-test] FAILED:', err.message || err);
  if (err.stderr) console.error('[yt-test] stderr:', String(err.stderr).slice(0, 2000));
  process.exit(1);
});
