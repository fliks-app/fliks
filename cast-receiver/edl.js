/**
 * Port of client/src/app/core/utils/edl-policy.ts (plain JS, no build step): keep in sync.
 * Ranges are `{start, end, action}` in seconds on the playback clock, sorted and disjoint.
 */
(function (root) {
  const EOF_SLACK = 0.05;
  const COMMERCIAL_TAIL = 1.0;
  const MUTE_MERGE_GAP = 0.2;
  const MUTE_LEAD = 0.03;
  const EDGE_EPS = 0.01;
  const WIRE_ACTIONS = ['cut', 'mute', 'commercial'];

  /** Inverse of encodeEdlWire in edl-policy.ts: d = [gapMs, durMs * 4 + actionCode, ...]. */
  function decodeWire(wire) {
    if (Array.isArray(wire)) return wire;
    if (!wire || !Array.isArray(wire.d)) return [];
    const out = [];
    let t = 0;
    for (let i = 0; i + 1 < wire.d.length; i += 2) {
      const start = t + wire.d[i];
      t = start + Math.floor(wire.d[i + 1] / 4);
      out.push({ start: start / 1000, end: t / 1000, action: WIRE_ACTIONS[wire.d[i + 1] % 4] });
    }
    return out;
  }

  class EdlSkipPolicy {
    /** opts.autoSkipCommercials false: commercials are only skipped through skipCommercialAt(). */
    constructor(ranges, opts) {
      this.skipped = new Set();
      this.auto = !opts || opts.autoSkipCommercials !== false;
      this.setRanges(ranges);
    }

    setAutoSkipCommercials(on) {
      this.auto = on;
    }

    setRanges(ranges) {
      this.ranges = (ranges || []).filter((r) => r.action !== 'mute').sort((a, b) => a.start - b.start);
      this.ordinals = new Map();
      for (const r of this.ranges) if (r.action === 'commercial') this.ordinals.set(r, this.ordinals.size);
    }

    /** New ranges for the same session: skipped commercials stay skipped while the count matches. */
    replaceRanges(ranges) {
      const before = this.ordinals.size;
      this.setRanges(ranges);
      if (this.ordinals.size !== before) this.skipped.clear();
    }

    done(r) {
      return r.action === 'commercial' && this.skipped.has(this.ordinals.get(r));
    }

    skips(r, pos, force) {
      if (!(r.start <= pos && pos < r.end - EDGE_EPS)) return false;
      if (r.action === 'cut') return true;
      return (this.auto || !!force) && !this.done(r) && pos < r.end - COMMERCIAL_TAIL;
    }

    /** {kind:'none'} | {kind:'seek', to, action} | {kind:'end'} */
    resolve(t, duration) {
      return this.run(t, duration, null);
    }

    /** The unskipped commercial the playhead is in, outside its tail: {index, start, end} or null. */
    commercialAt(t) {
      const r = this.ranges.find((c) => c.action === 'commercial' && this.skips(c, t, true));
      return r ? { index: this.ordinals.get(r), start: r.start, end: r.end } : null;
    }

    /** Skips the commercial at `t`, then any cut or commercial chained at its end. */
    skipCommercialAt(t, duration) {
      const c = this.commercialAt(t);
      if (!c) return { kind: 'none' };
      this.skipped.add(c.index);
      return this.run(c.end, duration, 'commercial');
    }

    run(t, duration, chained) {
      let pos = t;
      let first = chained;
      for (let moved = true; moved; ) {
        moved = false;
        for (const r of this.ranges) {
          if (!this.skips(r, pos, chained !== null)) continue;
          if (r.action === 'commercial') this.skipped.add(this.ordinals.get(r));
          first = first || r.action;
          pos = r.end;
          moved = true;
        }
      }
      if (first && Number.isFinite(duration) && duration > 0 && pos >= duration - EOF_SLACK) {
        return { kind: 'end', action: first };
      }
      return first ? { kind: 'seek', to: pos, action: first } : { kind: 'none' };
    }

    /** Next time after `t` at which a skip fires, or Infinity. */
    nextBoundary(t) {
      let best = Infinity;
      for (const r of this.ranges) {
        if (this.done(r) || (!this.auto && r.action === 'commercial')) continue;
        if (r.start > t && r.start < best) best = r.start;
      }
      return best;
    }
  }

  function mergeMuteRanges(ranges) {
    const sorted = (ranges || [])
      .filter((x) => x.action === 'mute' && x.end > x.start)
      .map((x) => ({ start: x.start, end: x.end }))
      .sort((a, b) => a.start - b.start);
    const out = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last && r.start - last.end <= MUTE_MERGE_GAP) last.end = Math.max(last.end, r.end);
      else out.push(r);
    }
    return out;
  }

  const MEDIA_EVENTS = ['seeking', 'seeked', 'play', 'pause', 'ratechange', 'timeupdate', 'loadedmetadata'];

  /** Sets `media.muted` while the media clock is inside a merged mute range. */
  class MuteGate {
    constructor(media, ranges, onChange) {
      this.media = media;
      this.ranges = mergeMuteRanges(
        mergeMuteRanges(ranges).map((r) => ({ action: 'mute', start: Math.max(0, r.start - MUTE_LEAD), end: r.end })),
      );
      this.onChange = onChange;
      this.timer = null;
      this.silent = false;
      this.handler = () => this.update();
      MEDIA_EVENTS.forEach((e) => media.addEventListener(e, this.handler));
      this.update();
    }

    update() {
      clearTimeout(this.timer);
      const m = this.media;
      const t = m.currentTime;
      let silent = false;
      let edge = Infinity;
      for (const r of this.ranges) {
        if (t >= r.start && t < r.end) {
          silent = true;
          edge = r.end;
          break;
        }
        if (r.start > t) {
          edge = r.start;
          break;
        }
      }
      this.set(silent);
      const rate = m.playbackRate || 1;
      if (!m.paused && Number.isFinite(edge) && rate > 0) {
        this.timer = setTimeout(() => this.update(), Math.max(0, ((edge - t) / rate) * 1000));
      }
    }

    set(silent) {
      if (silent === this.silent && this.media.muted === silent) return;
      this.silent = silent;
      this.media.muted = silent;
      if (this.onChange) this.onChange(silent);
    }

    destroy() {
      clearTimeout(this.timer);
      MEDIA_EVENTS.forEach((e) => this.media.removeEventListener(e, this.handler));
      this.set(false);
    }
  }

  const api = { EdlSkipPolicy, MuteGate, mergeMuteRanges, EOF_SLACK, COMMERCIAL_TAIL, MUTE_MERGE_GAP, EDGE_EPS, decodeWire };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FliksEdl = api;
})(typeof self !== 'undefined' ? self : this);
