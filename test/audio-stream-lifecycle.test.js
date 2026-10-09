'use strict';

// Real AudioPlayer lifecycle tests: what the media stream actually looks
// like at the moment AudioPlayerStatus.Idle is delivered, for the three
// ways playback ends (genuine EOF, starvation, stream error), and how the
// completion classifier reads that state.
//
// This is the architecture the fix depends on: resource.playStream is the
// last stage of the pipeline (opus encoder), @discordjs/voice destroys it
// BEFORE emitting Idle, so only its end/error flags survive as evidence.
// Uses a real createAudioPlayer + prism opus encoder, no Discord, no
// network. Run: npm test.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} = require('@discordjs/voice');
const prism = require('prism-media');
const { classifyIdleEnd } = require('../src/music/playback');

const FRAME_BYTES = 960 * 2 * 2; // frameSize(960 samples/ch) * 2ch * 16-bit
const pcm = (frames) => Buffer.alloc(FRAME_BYTES * frames); // silence
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TRACK = { title: 'lifecycle', youtubeUrl: 'https://www.youtube.com/watch?v=lifecycle' };

// Play a synthetic stream until the player reports Idle, then snapshot the
// completion evidence the classifier will read.
function playUntilIdle({ maxMissedFrames, scenario }) {
  return new Promise((resolve, reject) => {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames },
    });
    const encoder = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
    const resource = createAudioResource(encoder);
    const guard = setTimeout(() => {
      try {
        player.stop(true);
      } catch {}
      reject(new Error('player never reported Idle'));
    }, 15000);

    player.on('error', () => {}); // expected in the error scenario
    player.on(AudioPlayerStatus.Idle, () => {
      clearTimeout(guard);
      const stream = resource.playStream;
      const snapshot = {
        stream,
        streamIsPlayStream: stream === encoder,
        readableEnded: stream.readableEnded === true,
        stateEnded: !!(stream._readableState && stream._readableState.ended === true),
        errored: stream.errored || null,
        playbackDuration: resource.playbackDuration,
      };
      try {
        player.stop(true);
      } catch {}
      resolve(snapshot);
    });

    player.play(resource);
    scenario(encoder, player, resource);
  });
}

describe('stream lifecycle at Idle', () => {
  it('genuine end of media: readableEnded is true and counts as completion', { timeout: 30000 }, async () => {
    const snapshot = await playUntilIdle({
      maxMissedFrames: 50,
      scenario: async (encoder) => {
        for (let i = 0; i < 5; i += 1) encoder.write(pcm(1));
        await sleep(300); // let the player leave Buffering and consume
        for (let i = 0; i < 5; i += 1) encoder.write(pcm(1));
        await sleep(100);
        encoder.end(); // clean EOF
      },
    });

    assert.equal(snapshot.streamIsPlayStream, true, 'playStream must be the pipeline tail');
    assert.equal(snapshot.errored, null, 'a finished stream is not an error');
    assert.equal(snapshot.readableEnded, true, 'EOF evidence must survive to Idle');
    assert.ok(snapshot.playbackDuration > 0, 'something was actually heard');

    const record = {
      key: TRACK.youtubeUrl,
      resource: { playStream: snapshot.stream, playbackDuration: snapshot.playbackDuration },
      eof: false,
      errored: false,
    };
    const dur = snapshot.playbackDuration;
    assert.equal(classifyIdleEnd(record, TRACK, dur, null), 'natural-complete');
    assert.equal(classifyIdleEnd(record, TRACK, dur, dur), 'natural-complete');
    // Duration only ever vetoes: 0.2s of a 5-minute track is truncated.
    assert.equal(classifyIdleEnd(record, TRACK, dur, 300000), 'truncated-eof');
  });

  it('starvation: stream never ended, so Idle is NOT a completion', { timeout: 30000 }, async () => {
    const snapshot = await playUntilIdle({
      maxMissedFrames: 5,
      scenario: (encoder) => {
        encoder.write(pcm(5));
        // never end: this is the FFmpeg-stall / dead-googlevideo case
      },
    });

    assert.equal(snapshot.streamIsPlayStream, true);
    assert.equal(snapshot.readableEnded, false, 'no EOF: the stream was still alive');
    assert.equal(snapshot.stateEnded, false, 'no upstream EOF either');
    assert.equal(snapshot.errored, null, 'starvation is silent: no error is raised');

    const record = {
      key: TRACK.youtubeUrl,
      resource: { playStream: snapshot.stream, playbackDuration: snapshot.playbackDuration },
      eof: false,
      errored: false,
    };
    assert.equal(classifyIdleEnd(record, TRACK, snapshot.playbackDuration, null), 'stream-starved');
    // The old duration-only heuristic had no idea here: it saw a number.
    assert.equal(
      classifyIdleEnd(record, TRACK, snapshot.playbackDuration, snapshot.playbackDuration + 60000),
      'stream-starved',
    );
  });

  it('stream error: errored is set and beats every other signal', { timeout: 30000 }, async () => {
    const snapshot = await playUntilIdle({
      maxMissedFrames: 50,
      scenario: async (encoder) => {
        encoder.write(pcm(5));
        await sleep(200);
        encoder.destroy(new Error('simulated ffmpeg/pipe failure'));
      },
    });

    assert.equal(snapshot.streamIsPlayStream, true);
    assert.ok(snapshot.errored instanceof Error, 'errored must be preserved to Idle');
    assert.equal(snapshot.readableEnded, false, 'a failed stream never reaches EOF');

    const record = {
      key: TRACK.youtubeUrl,
      resource: { playStream: snapshot.stream, playbackDuration: snapshot.playbackDuration },
      eof: false,
      errored: false,
    };
    assert.equal(classifyIdleEnd(record, TRACK, snapshot.playbackDuration, null), 'stream-error');
    // Even with a forged EOF flag, an errored stream is never a completion.
    assert.equal(
      classifyIdleEnd({ ...record, eof: true }, TRACK, snapshot.playbackDuration, 300000),
      'stream-error',
    );
  });
});
