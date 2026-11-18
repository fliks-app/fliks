/* Lyrics of the receiver: the sender's chunked document, the active line and its words. */
(function (root) {
  'use strict';

  /** Joins the `lyrics` messages of one `seq`; returns the document once every part arrived. */
  function createAssembler() {
    let seq = -1;
    let parts = [];
    let got = 0;
    return function add(msg) {
      if (!(msg.seq >= seq) || !(msg.parts > 0) || !(msg.part >= 0 && msg.part < msg.parts)) return null;
      if (msg.seq !== seq || parts.length !== msg.parts) {
        seq = msg.seq;
        parts = new Array(msg.parts);
        got = 0;
      }
      if (parts[msg.part] === undefined) got++;
      parts[msg.part] = String(msg.data);
      if (got < parts.length) return null;
      try {
        const doc = JSON.parse(parts.join(''));
        return Array.isArray(doc.rows) ? { itemId: msg.itemId, seq, ...doc } : null;
      } catch {
        return null;
      }
    };
  }

  /** The last line started at `posMs`; -1 before the first or when a line is untimed. */
  function activeIndex(rows, posMs, offset) {
    const t = posMs + (offset || 0);
    let found = -1;
    for (let i = 0; i < rows.length; i++) {
      const s = rows[i].start;
      if (s === undefined || s === null) return -1;
      if (s <= t) found = i;
      else break;
    }
    return found;
  }

  /** A line cut at its cues' UTF-8 byte ranges: `{text, cue}` where `cue` is the cue index or null. */
  function segments(text, cues) {
    const bytes = new TextEncoder().encode(text);
    const dec = new TextDecoder();
    const out = [];
    let at = 0;
    cues.forEach((c, k) => {
      const from = Math.min(Math.max(c.byteStart, at), bytes.length);
      const to = Math.min(Math.max(c.byteEnd, from), bytes.length);
      if (from > at) out.push({ text: dec.decode(bytes.slice(at, from)), cue: null });
      out.push({ text: dec.decode(bytes.slice(from, to)), cue: k });
      at = to;
    });
    if (at < bytes.length) out.push({ text: dec.decode(bytes.slice(at)), cue: null });
    return out;
  }

  /** The media position from its reports, which jitter about 100 ms on a Cast device: wall time moves it,
      each report pulls it a tenth of the way, and a jump (seek, stall) or a pause resets it. */
  function createClock(jumpMs) {
    let media = 0;
    let at = null;
    return function read(reported, now, playing) {
      const predicted = at === null ? reported : media + (now - at);
      const err = reported - predicted;
      media = !playing || Math.abs(err) > jumpMs ? reported : predicted + err / 10;
      at = now;
      return media;
    };
  }

  /** The sender of the current LOAD owns the lyrics; true when another sender held them (its document is stale). */
  function claim(state, senderId) {
    const replaced = !!state.sender && state.sender !== senderId;
    state.sender = senderId;
    return replaced;
  }

  /** Whether `senderId` may send lyrics: nobody owns them yet, or it does. */
  function owns(state, senderId) {
    return !state.sender || state.sender === senderId;
  }

  const api = { createAssembler, activeIndex, segments, createClock, claim, owns };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FliksLyrics = api;
})(typeof self !== 'undefined' ? self : this);
