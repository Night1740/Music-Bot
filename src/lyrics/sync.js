'use strict';

// Sync engine for Phase 5. Maps playback position → lyric line and drives
// ONE Discord message per lyrics session.
//
// Design (no "timer per line"): a single 1s interval per guild polls the
// current playback position, binary-searches the active line, and edits
// the Discord message ONLY when the rendered window actually changes.
//
// Stale-session protection is layered:
//   1. one session per guild — starting a new one stops the old loop;
//   2. every tick revalidates an injected isValid() (queue epoch + current
//      track identity), so /skip, /stop, /leave, /play and natural
//      advances all terminate old sessions even if stop was missed;
//   3. stopped sessions are marked dead: a late timer firing afterwards is
//      a no-op and can never edit for a new song.

const TICK_MS = 1000;
const MAX_EDIT_FAILURES = 3;
const CONTEXT_BEFORE = 1;
const CONTEXT_AFTER = 3;

// Last line with startMs <= positionMs; -1 when playback hasn't reached
// the first line yet.
function lineIndexAt(lines, positionMs) {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].startMs <= positionMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function renderLyrics({ title, channel, lines, index, ended = false }) {
  const out = [`🎤 **${title || 'Unknown song'}**`];
  if (channel) out.push(channel);
  out.push('');
  if (lines.length === 0) {
    out.push('(no lyric lines)');
  } else if (ended) {
    const start = Math.max(0, Math.min(index, lines.length - 1));
    for (const l of lines.slice(start, start + CONTEXT_AFTER + 1)) out.push(l.text);
    out.push('');
    out.push('`⏹ Lyrics ended.`');
    return out.join('\n').slice(0, 1900);
  } else if (index < 0) {
    for (const l of lines.slice(0, CONTEXT_AFTER + 1)) out.push(l.text);
    out.push('');
    out.push('`• starting…`');
    return out.join('\n').slice(0, 1900);
  } else {
    for (const l of lines.slice(Math.max(0, index - CONTEXT_BEFORE), index)) out.push(l.text);
    out.push(`▶ ${lines[index].text}`);
    for (const l of lines.slice(index + 1, index + 1 + CONTEXT_AFTER)) out.push(l.text);
  }
  out.push('');
  out.push(`\`${Math.min(index + 1, lines.length)}/${lines.length} • synced live\``);
  return out.join('\n').slice(0, 1900);
}

const sessions = new Map(); // guildId -> session

function getSession(guildId) {
  return sessions.get(guildId) || null;
}

function stopSession(guildId) {
  const s = sessions.get(guildId);
  if (!s) return false;
  s.dead = true;
  if (s.timer) clearInterval(s.timer);
  sessions.delete(guildId);
  return true;
}

async function tickSession(s) {
  if (s.dead || sessions.get(s.guildId) !== s) return;
  let valid = false;
  try {
    valid = s.isValid();
  } catch {
    valid = false;
  }
  if (!valid) {
    await finalizeSession(s.guildId, s);
    return;
  }
  let positionMs = null;
  try {
    positionMs = s.getPositionMs();
  } catch {
    positionMs = null;
  }
  if (typeof positionMs !== 'number' || positionMs < 0) return; // can't place: wait
  const index = lineIndexAt(s.lines, positionMs);
  s.lastIndex = index;
  const text = renderLyrics({ title: s.title, channel: s.channel, lines: s.lines, index });
  if (text === s.lastText) return; // unchanged: no Discord edit
  s.lastText = text;
  try {
    await s.editMessage(text);
    s.failures = 0;
  } catch {
    s.failures += 1;
    if (s.failures >= MAX_EDIT_FAILURES) stopSession(s.guildId); // message gone: give up quietly
  }
}

async function finalizeSession(guildId, s) {
  stopSession(guildId);
  if (s.finalized) return;
  s.finalized = true;
  const index = s.lastIndex >= 0 ? s.lastIndex : 0;
  const text = renderLyrics({ title: s.title, channel: s.channel, lines: s.lines, index, ended: true });
  if (text === s.lastText) return;
  try {
    await s.editMessage(text);
  } catch {
    // Message may be deleted; ending silently is fine.
  }
}

// Start (or reuse) a lyrics session. Returns { created, session }.
// A second /lyrics for the SAME track generation returns the existing
// session (created:false) instead of spawning another loop.
function startSession({ guildId, epoch, trackKey, title, channel, lines, getPositionMs, isValid, editMessage }) {
  const existing = sessions.get(guildId);
  if (existing && !existing.dead && existing.trackKey === trackKey && existing.epoch === epoch) {
    return { created: false, session: existing };
  }
  stopSession(guildId);
  const s = {
    guildId,
    epoch,
    trackKey,
    title,
    channel,
    lines,
    getPositionMs,
    isValid,
    editMessage,
    lastText: null,
    lastIndex: -1,
    failures: 0,
    finalized: false,
    dead: false,
    running: false,
    timer: null,
  };
  sessions.set(guildId, s);
  const tick = () => {
    if (s.running) return; // never overlap slow edits
    s.running = true;
    tickSession(s)
      .catch(() => {})
      .finally(() => {
        s.running = false;
      });
  };
  s.tick = tick;
  s.timer = setInterval(tick, TICK_MS);
  tick(); // render immediately instead of waiting a second
  return { created: true, session: s };
}

module.exports = {
  lineIndexAt,
  renderLyrics,
  startSession,
  stopSession,
  getSession,
};
