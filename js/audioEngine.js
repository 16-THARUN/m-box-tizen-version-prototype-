/**
 * audioEngine.js
 *
 * Single Web Audio graph shared by the player AND every visualizer.
 * Real playback:   <audio> -> MediaElementSource -> AnalyserNode -> destination
 * Demo playback:    Oscillator+Noise -> Gain      -> AnalyserNode -> destination
 *
 * Later, an EQ (BiquadFilterNode chain) drops in between source and analyser
 * without anything downstream needing to change — that's the whole point of
 * centralizing this here instead of letting each screen touch WebAudio.
 */
var AudioEngine = (function () {
  var ctx = null;
  var analyser = null;
  var sourceNode = null;
  var freqData, timeData;

  var demoOsc = null, demoGain = null, demoNoise = null;
  var usingDemo = false;

  function ensureContext() {
    if (ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.8;
    analyser.connect(ctx.destination);
    freqData = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.frequencyBinCount);
  }

  /** Wire the real <audio> element into the graph. Safe to call more than
   *  once — only actually connects the first time. Called lazily by
   *  player.js right before real playback starts, NOT at boot, since
   *  opening the audio stream eagerly (even with nothing loaded/playing)
   *  is the suspected source of a startup noise artifact on some Tizen
   *  audio backends. */
  var attached = false;
  function attachAudioElement(audioEl) {
    ensureContext();
    if (attached) return;
    attached = true;
    sourceNode = ctx.createMediaElementSource(audioEl);
    sourceNode.connect(analyser);
  }

  /**
   * No track loaded yet (or running in the emulator with no media files) —
   * generate a soft evolving tone so the visualizer has something real to
   * react to. Only called lazily, the moment a demo track actually needs
   * it (see player.js) — never at boot — so on real hardware with real
   * tracks these nodes are never created and can't bleed into playback.
   */
  function startDemoSignal() {
    ensureContext();
    if (usingDemo) return;
    usingDemo = true;

    demoGain = ctx.createGain();
    demoGain.gain.value = 0.0;
    demoGain.connect(analyser);

    demoOsc = ctx.createOscillator();
    demoOsc.type = 'sine';
    demoOsc.frequency.value = 110;
    demoOsc.connect(demoGain);
    demoOsc.start();

    // gentle low-frequency wobble so bars/waves aren't static
    var lfo = ctx.createOscillator();
    lfo.frequency.value = 0.15;
    var lfoGain = ctx.createGain();
    lfoGain.gain.value = 40;
    lfo.connect(lfoGain);
    lfoGain.connect(demoOsc.frequency);
    lfo.start();

    // filtered noise layer for high-frequency content
    var bufferSize = 2 * ctx.sampleRate;
    var noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    var output = noiseBuffer.getChannelData(0);
    for (var i = 0; i < bufferSize; i++) output[i] = Math.random() * 2 - 1;

    demoNoise = ctx.createBufferSource();
    demoNoise.buffer = noiseBuffer;
    demoNoise.loop = true;
    var noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 2000;
    noiseFilter.Q.value = 0.5;
    var noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.05;
    demoNoise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(analyser);
    demoNoise.start();

    setDemoPlaying(false);
  }

  function setDemoPlaying(playing) {
    if (!demoGain) return;
    var target = playing ? 0.12 : 0.0;
    var now = ctx.currentTime;
    // Anchor the current value before scheduling the ramp — some WebKit
    // versions handle a bare linearRampToValueAtTime() inconsistently if
    // there's no prior automation event to ramp *from*.
    demoGain.gain.cancelScheduledValues(now);
    demoGain.gain.setValueAtTime(demoGain.gain.value, now);
    demoGain.gain.linearRampToValueAtTime(target, now + 0.4);
  }

  function resume() {
    ensureContext();
    if (ctx.state === 'suspended') ctx.resume();
  }

  // Safe before any Web Audio graph exists (e.g. the first track played is
  // Dolby via AVPlay, so attachAudioElement() never ran): return silence.
  var EMPTY_FREQ = new Uint8Array(512);          // silence = all zeros
  var EMPTY_TIME = new Uint8Array(512).fill(128); // silence = flat midline
  function getFrequencyData() {
    if (!analyser) return EMPTY_FREQ;
    analyser.getByteFrequencyData(freqData);
    return freqData;
  }

  function getTimeDomainData() {
    if (!analyser) return EMPTY_TIME;
    analyser.getByteTimeDomainData(timeData);
    return timeData;
  }

  return {
    ensureContext: ensureContext,
    attachAudioElement: attachAudioElement,
    startDemoSignal: startDemoSignal,
    setDemoPlaying: setDemoPlaying,
    resume: resume,
    getFrequencyData: getFrequencyData,
    getTimeDomainData: getTimeDomainData,
    isUsingDemo: function () { return usingDemo; },
    getState: function () { return ctx ? ctx.state : 'none'; }   // 'running' | 'suspended' | 'closed' | 'none'
  };
})();
