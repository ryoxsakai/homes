import test from 'node:test';
import assert from 'node:assert/strict';
import { startScanner } from '../public/books/scanner.mjs';

test('a delayed camera stream from a cancelled attempt never takes over the active scanner', async () => {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const controller = new AbortController();
  const video = { srcObject: 'a newer stream' };
  const onIsbn = () => assert.fail('cancelled scanner performed a lookup');
  let resolvePending;
  let stops = 0;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true, value: { getUserMedia: () => new Promise(resolve => { resolvePending = resolve; }) },
  });
  try {
    const pending = startScanner(video, { onIsbn, signal: controller.signal });
    controller.abort();
    resolvePending({ getTracks: () => [{ stop: () => { stops++; } }] });
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(stops, 1);
    assert.equal(video.srcObject, 'a newer stream');
  } finally {
    if (previous) Object.defineProperty(navigator, 'mediaDevices', previous);
    else delete navigator.mediaDevices;
  }
});

test('cancelling while the video is starting stops its tracks and leaves other streams alone', async () => {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const controller = new AbortController();
  let stops = 0, startedPlayback, resolvePlayback;
  const stream = { getTracks: () => [{ stop: () => { stops++; } }] };
  const playbackStarted = new Promise(resolve => { startedPlayback = resolve; });
  const video = { srcObject: null, setAttribute() {}, play() {
    startedPlayback();
    return new Promise(resolve => { resolvePlayback = resolve; });
  } };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true, value: { getUserMedia: async () => stream },
  });
  try {
    const pending = startScanner(video, { onIsbn() { assert.fail('cancelled scanner read an ISBN'); }, signal: controller.signal });
    await playbackStarted;
    assert.equal(video.srcObject, stream);
    video.srcObject = 'a newer stream';
    controller.abort();
    resolvePlayback();
    const stop = await pending;
    stop();
    assert.equal(stops, 1);
    assert.equal(video.srcObject, 'a newer stream');
  } finally {
    if (previous) Object.defineProperty(navigator, 'mediaDevices', previous);
    else delete navigator.mediaDevices;
  }
});
