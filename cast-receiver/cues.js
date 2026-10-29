/* Skip-intro and next-episode cues of the receiver: which one applies at a playback position. */
(function (root) {
  'use strict';

  // An intro ends a second early so a cue never lingers onto content already playing.
  const INTRO_SLACK_S = 1;

  /** `cues` is the sender's `cues` message; null unless it describes the file now loaded. */
  function activeCue(cues, fileId, position) {
    if (!cues || cues.fileId !== fileId) return null;
    const { intro, outro } = cues;
    if (intro && position >= intro.startSeconds && position < intro.endSeconds - INTRO_SLACK_S) return 'intro';
    if (outro && cues.hasNext && position >= outro.startSeconds) return 'next';
    return null;
  }

  /** Text of a cue: the action once the receiver has seen a remote key, else where to do it. */
  function cueText(cues, cue, remoteKeys) {
    const l = cues.labels || {};
    if (cue === 'intro') return (remoteKeys ? l.intro : l.introHint) || '';
    return (remoteKeys ? l.next : l.nextHint) || '';
  }

  const api = { activeCue, cueText, INTRO_SLACK_S };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FliksCues = api;
})(typeof self !== 'undefined' ? self : this);
