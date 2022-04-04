/* global CodeMirror, AudioWorkletNode */
// Starter code and styling from https://github.com/acarabott/audio-dsp-playground by Arthur Carabott (MIT License).
import { Scope } from "./Scope.js";

let audio;
// Map of id => {customNode, panner, channel, editor, editorContainer, lastEditorState, elements, scopes, isLocal, speaker, lastSpeakerState}
// (Maybe it's time to make a real class?)
let players = {};
let CustomAudioNode;
let processorCount = 0;
// This is replaced when we connect to the server.
let startTime = Date.now() / 1000;
let clockUpdate;
let outputNode;

let socket = null;
let merger, delay;

let field;
let localIDs = 0;
let isRecording = false;
let isPlaying = false;
let recordLog;
let handlers = {};

let selectedPlayer = 0;

let statusText = {
  offline: "You are offline. To play with others, join a server.",
  connecting: "Connecting to server...",
  connected: id => `Connected. You are player ${id}.`,
  timeout: "Connection timeout.",
  error: "Connection error.",
}

// For using Cmd vs. Ctrl keys:
const isMac = CodeMirror.keyMap.default === CodeMirror.keyMap.macDefault;

// Wrappers that deal with the server in online mode, AND deal with recordings in recording/playback mode.

function on(event, callback) {
  handlers[event] = callback;
}

function emit(id, event, obj) {
  console.log('emit', id, event, obj);
  handleEvent(event, {id: id, state: obj});
  if (id === "me" && socket !== null) {
    socket.emit(event, obj);
  }
}

function handleEvent(event, obj) {
  console.log('handleEvent', event, obj);
  if (isRecording) {
    recordLog.push([getTime(), event, obj]);
  }
  handlers[event](obj);
}

function download(filename, text) {
  var element = document.createElement('a');
  element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text));
  element.setAttribute('download', filename);

  element.style.display = 'none';
  document.body.appendChild(element);

  element.click();

  document.body.removeChild(element);
}

function getTime() {
  return Date.now() / 1000 - startTime;
}

function updateClock() {
  document.getElementById("clock-display").value = Math.floor(getTime());
  clockUpdate = setTimeout(updateClock, 500);
}

const presets = [
  {
    name: "Silence",
    code: `0`
  },
  {
    name: "Noise",
    code: `(rand()*2-1)`
  },
  {
    name: "Sine",
    code: `sin(2*pi*400*t)`
  },
  // Note that Sawtooth and Square here have DC bias.
  {
    name: "Saw",
    code: `(t%.005)/.005`
  },
  {
    name: "Square",
    code: `((t%.005)>.0025)`
  },
  {
    name: "AM",
    code: `sin(2*pi*400*t)*sin(2*pi*200*t)`
  },
  {
    name: "PM",
    code: `sin(2*pi*400*t+sin(2*pi*200*t))`
  },
  {
    name: "Chord",
    code: `[300,500,800].map(f=>sin(2*pi*f*t)).reduce((a,b)=>a+b)/3`
  },
  {
    name: "Sequence",
    code: `[.3,.4,.5][floor(t % 3)]`
  },
  {
    name: "Rhythm",
    code: `(t<x?(t-x):(x=t+choice(.6,.3,.2,.1),0))`
  },
  {
    name: "Timer",
    code: `(t-now<5)`
  },
  {
    name: "Ramp",
    code: `min(t-now,1)`
  },
];

function resumeContextOnInteraction(audioContext) {
  // from https://github.com/captbaritone/winamp2-js/blob/a5a76f554c369637431fe809d16f3f7e06a21969/js/media/index.js#L8-L27
  if (audioContext.state === "suspended") {
    const resume = async () => {
      await audioContext.resume();
      if (audioContext.state === "running") {
        document.body.removeEventListener("touchend", resume, false);
        document.body.removeEventListener("click", resume, false);
        document.body.removeEventListener("keydown", resume, false);
      }
      audio_ready();
    };
    document.body.addEventListener("touchend", resume, false);
    document.body.addEventListener("click", resume, false);
    document.body.addEventListener("keydown", resume, false);
  } else {
    audio_ready();
  }
}

function getUsedChannels() {
  return Object.values(players).map(({channel}) => channel).filter(c => c !== null && c !== undefined);
}

function getNextChannel() {
  let channels = getUsedChannels().sort();
  let prev = -1;
  for (let i = 0; i < channels.length; i++) {
    if (channels[i] - prev > 1)
      return prev + 1;
    prev = channels[i];
  }
  return prev + 1;
}

function stopAudio(id) {
  if (players[id].customNode !== undefined) {
    delay.disconnect(players[id].customNode);
    players[id].channel = null;
    players[id].customNode.disconnect();
    players[id].customNode = null;
  }
}

function getCode(userCode, processorName) {
  function generateNames() {
    // Note that this includes "me" to refer to current player.
    return Object.entries(players).map(([id, {channel}]) => {
      if (channel === null || channel === undefined)
        return '';
      let varName = (id == "me") ? "me" : `p${id}`;
      return `let ${varName} = inputs[0][${channel}]?.[i];`
    }).join('\n');
  }

  function exportMath() {
    // sin is omitted; see below for explanation.
    let names = ['abs', 'cbrt', 'clz32', 'imul', 'max', 'min', 'pow', 'sign', 'sqrt',
                 'exp', 'expm1', 'log', 'log1p', 'log10', 'log2',
                 'ceil', 'floor', 'fround', 'round', 'trunc',
                 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atanh', 'atan2',
                 'cos', 'cosh', 'hypot', /*'sin',*/ 'sinh', 'tan', 'tanh'];
    let aliases = {"rand": "random", "e": "E", "pi": "PI"};
    return names.map(name => `let ${name} = Math.${name}`)
                .concat(Object.entries(aliases).map(([alias, name]) => `let ${alias} = Math.${name}`))
                .join(';');
  }

  return `
  let t = 0;
  ${exportMath()}
  // Variables for the player to use and however they like.
  let i = 0, x = 0, y = 0, z = 0;
  let now = ${getTime()};

  let sr = sampleRate;
  let dt = 1/sampleRate;

  // Wrap Math.sin so we're not monkey-patching globally.
  let sin = Math.sin.bind({});

  // Phase accumulation.
  // Usage: acc[i](delta) accumulates its argument. Each acc[i] is a separate accumulator.
  //        sin[i](phase) is like sin(phase), but with phase-accumulation between calls (like osc~ in Pd/MSP).
  let acc = new Array(8).fill(0);
  for (let i = 0; i < acc.length; i++) {
    sin[i] = (phase) => sin(acc[i] += phase);
  }

  function choice(...choices) {
    var index = Math.floor(Math.random() * choices.length);
    return choices[index];
  }

  class CustomProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.port.onmessage = (m) => t = m.data;
    }

    process(inputs, outputs, parameters) {
      const out = outputs[0][0];
      const numFrames = out.length;
      for (let i = 0; i < numFrames; i++) {
        ${generateNames()}
        let sample = ${userCode};
        out[i] = Math.max(-1, Math.min(1, sample)) || 0;
        t += 1 / sampleRate;
      }
      return true;
    }
  }

  registerProcessor("${processorName}", CustomProcessor);`;
}

function runAudioWorklet(id, workletUrl, processorName) {
  audio.audioWorklet.addModule(workletUrl).then(() => {
    stopAudio(id);

    let customNode = new CustomAudioNode(audio, processorName);
    // TODO: I think we could get sample-accurate sync (within worklets on one client)
    // by using currentFrame and giving every worklet the same offset from it.
    customNode.port.postMessage(getTime());

    delay.connect(customNode);
    customNode.connect(players[id].panner);
    customNode.connect(players[id].analyser);
    // TODO: may wish to do this earlier (or otherwise rethink this)
    // to guarantee that worklet code (generated earlier) matches channel map.
    players[id].channel = getNextChannel();
    customNode.connect(merger, 0, players[id].channel);
    players[id].customNode = customNode;
  }).catch(error => {
    console.log("Error in user code:", error);
    // Trigger CSS animation.
    players[id].editorContainer.classList.add("error");
    setTimeout(() => {
      players[id].editorContainer.classList.remove("error");
    }, 200);
  });
}

function createButton(text) {
  const button = document.createElement("button");
  button.textContent = text;
  return button;
}

function addKeyCommandToButton(button, keyCommand) {
  keyCommand.split("-").forEach(key => {
    const el = document.createElement("kbd");
    el.classList.add("key");
    el.textContent = key.toLowerCase();
    button.appendChild(el);
  });
}

function runCode(id) {
  // Trigger CSS animation.
  players[id].editorContainer.classList.add("ran");
  setTimeout(() => {
    players[id].editorContainer.classList.remove("ran");
  }, 100);

  const processorName = `processor-${id}-${processorCount++}`;
  const code = getCode(players[id].code, processorName);
  // console.log("Generated code", code);
  const blob = new Blob([code], { type: "application/javascript" });
  const url = window.URL.createObjectURL(blob);

  runAudioWorklet(id, url, processorName);
}

function createEditor(id, isLocal) {
  let parent = document.getElementById("main");
  // Create containing elements.
  let nameBox = document.createElement('div');
  nameBox.id = `p${id}-id`
  nameBox.classList.add('player-id');
  if (id === "me") {
    nameBox.innerText = "You (p0)";
  } else {
    nameBox.innerText = `p${id}`;
    if (isLocal) {
      const removeBtn = document.createElement("span");
      removeBtn.classList.add("remove-process");
      removeBtn.innerText = "❌";
      removeBtn.addEventListener("click", () => deletePlayer(id));
      nameBox.prepend(removeBtn);
    }
  }
  let editorWrap = document.createElement('div')
  editorWrap.id = `p${id}-code`;
  editorWrap.classList.add("editor");

  // Create CodeMirror editor.
  const editor = CodeMirror(editorWrap, {
    mode: "javascript",
    value: players[id].code,
    lineNumbers: false,
    lint: { esversion: 6 },
    viewportMargin: Infinity,
    tabSize: 2,
    readOnly: !isLocal,
    scrollbarStyle: null,
    matchBrackets: true,
  });
  // TODO: Check if this is still necessary.
  setTimeout(() => editor.refresh(), 0);

  let button;
  if (isLocal) {
    // For local editors, create a Run button.
    const runKeys = isMac ? "Cmd-Enter" : "Ctrl-Enter";
    const runButton = createButton("Run ");
    runButton.classList.add("run");
    addKeyCommandToButton(runButton, runKeys);

    function runEditorCode(editor) {
      const userCode = editor.getDoc().getValue();
      emit(id, "code", userCode);
    }

    button = runButton;
    runButton.addEventListener("click", () => runEditorCode(editor));
  } else {
    // For remote editors, create a Copy button.
    let copy = createButton("Copy 📄");
    copy.addEventListener('click', () => navigator.clipboard.writeText(players[id].code));
    copy.classList.add("run");
    button = copy;
  }

  let scopes = document.createElement('div')
  scopes.id = `p${id}-scopes`
  scopes.classList.add('scopes');
  players[id].editor = editor;
  players[id].editorContainer = editorWrap;
  players[id].elements = [nameBox, editorWrap, button, scopes];
  parent.appendChild(nameBox);
  parent.appendChild(editorWrap);
  parent.appendChild(button);
  parent.appendChild(scopes);

  if (isLocal) {
    for (let element of players[id].elements) {
      element.addEventListener('click', () => {
        if (players[selectedPlayer])
          players[selectedPlayer].editorContainer.classList.remove('selected');
        selectedPlayer = id;
        editorWrap.classList.add('selected');
      });
    }
  }
}

function createScopes(id) {
  const scopesContainer = document.getElementById(`p${id}-scopes`);

  let analyser = audio.createAnalyser();
  window.analyser = analyser;
  analyser.fftSize = Math.pow(2, 11);
  analyser.minDecibels = -96;
  analyser.maxDecibels = 0;
  analyser.smoothingTimeConstant = 0.85;

  const scopeOsc = new Scope();

  const toRender = [
    {
      analyser: analyser,
      style: "rgb(212, 100, 100)",
      edgeThreshold: 0.09,
    }
  ];

  scopeOsc.appendTo(scopesContainer);

  const scopeSpectrum = new Scope();
  scopeSpectrum.appendTo(scopesContainer);

  players[id].analyser = analyser;
  players[id].scopeOsc = scopeOsc;
  players[id].scopeSpectrum = scopeSpectrum;

  function loop() {
    scopeOsc.renderScope(toRender);
    scopeSpectrum.renderSpectrum(analyser);
    requestAnimationFrame(loop);
  }

  loop();
}

function createPlayer(id, isLocal) {
  players[id] = {
    code: "0",
    isLocal: isLocal,
    lastEditorState: null,
    speaker: {x: 0, y: 0, angle: 0},
    lastSpeakerState: null,
  };
  createEditor(id, isLocal);
  createScopes(id);

  const panner = audio.createPanner();
  panner.panningModel = 'HRTF';
  panner.coneOuterGain = 0.1;
  panner.coneOuterAngle = 180;
  panner.coneInnerAngle = 0;

  panner.connect(outputNode);
  players[id].speaker = {x: 0, y: 0, angle: 0};
  players[id].panner = panner;
}

function deletePlayer(id) {
  stopAudio(id);
  players[id].panner.disconnect();
  for (let element of players[id].elements) {
    element.remove();
  }
  delete players[id];
}

function main() {
  if (window.AudioContext !== undefined && window.AudioWorkletNode !== undefined) {
    const unsupportedEl = document.getElementById("unsupported");
    if (unsupportedEl !== null) { unsupportedEl.remove(); }

    CustomAudioNode = class CustomAudioNode extends AudioWorkletNode {
      constructor(audioContext, processorName) {
        super(audioContext, processorName, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1]
        });
      }
    };

    document.getElementById("connect-btn").addEventListener("click", connect);
    document.getElementById("disconnect-btn").addEventListener("click", disconnect);

    audio = new AudioContext();
    resumeContextOnInteraction(audio);
  }

  updateClock();
}

function resetClock() {
  startTime = Date.now() / 1000;
  clearTimeout(clockUpdate);
  updateClock();
  for (let player of Object.values(players)) {
    // I wonder if there's a way to broadcast to all AudioWorkletNodes at once?
    // Maybe they could all have a reference to one SharedArrayBuffer?
    if (player.customNode)
      player.customNode.port.postMessage(getTime());
  }
}

function resetPlayers() {
  for (let [id, player] of Object.entries(players)) {
    if (player !== players["me"]) {
      deletePlayer(id);
    } else if (id !== "me") {
      delete players[id];
    }
  }
  deletePlayer("me");
  createPlayer("me", true);
}

function playRecording(recording) {
  // For now we'll just schedule everything in advance.
  resetClock();
  resetPlayers();
  isPlaying = true;
  document.getElementById("play-input").disabled = true;
  players[recording.players[0]] = players["me"];
  for (let id of recording.players.slice(1)) {
    createPlayer(id, true);
  }

  let t = 0;
  for (let [timestamp, event, obj] of recording.events) {
    t = timestamp * 1000;
    setTimeout(() => handleEvent(event, obj), t);
  }
  setTimeout(() => {
    console.log("playback finished");
    document.getElementById("play-input").value = '';
    isPlaying = false;
    document.getElementById("play-input").disabled = false;
    resetPlayers();
    localIDs = 0;
    players[localIDs++] = players["me"];
  }, t);
}

function connect() {
  document.getElementById("status").innerText = statusText.connecting;
  socket = io(document.getElementById("server-address").value);
  socket.on('connect', () => {
      document.getElementById("connect-box").hidden = true;
      document.getElementById("add-process-btn").hidden = true;
      document.getElementById("disconnect-box").hidden = false;
      console.log("connected!");
  });

  socket.on('connect_error', () => {
    document.getElementById("status").innerText = statusText.error;
    socket.close();
    socket = null;
  });

  socket.on('connect_timeout', () => {
    document.getElementById("status").innerText = statusText.timeout;
    socket.close();
    socket = null;
  });

  // TODO refactor so that we can retrigger these events in replay.
  socket.on('hello', ({id, players: current_players, time}) => {
    resetPlayers();
    localIDs = 0;
    selectedPlayer = id;

    startTime = Date.now() / 1000 - time;
    console.log('hello: I am', id, 'and there are', current_players);
    players[id] = players["me"];
    document.getElementById("status").innerText = statusText.connected(id);
    document.getElementById("pme-id").innerText = `You (p${id})`;
    console.log(current_players);
    for (let {id, code, speaker} of current_players) {
      createPlayer(id, false);
      players[id].code = code;
      players[id].editor.getDoc().setValue(code);
      runCode(id);
      players[id].panner.setPosition(speaker.x, speaker.y, -0.5);
      players[id].panner.setOrientation(Math.cos(speaker.angle), Math.sin(speaker.angle), 1);
    }
  });

  socket.on('join', (id) => {
    console.log('join', id)
    createPlayer(id);
    field.render();
  });

  socket.on('leave', (id) => {
    console.log('leave', id)
    deletePlayer(id);
    field.render();
  });

  socket.on('reset', resetClock);

  // Register any other handlers (which are also used for playback).
  for (let [event, callback] of Object.entries(handlers)) {
    socket.on(event, callback);
  }
}

function disconnect() {
  socket.disconnect(true);
  socket = null;
  resetPlayers();
  resetClock();
  localIDs = 0;
  document.getElementById("status").innerText = statusText.offline;
  document.getElementById("disconnect-box").hidden = true;
  document.getElementById("connect-box").hidden = false;
  document.getElementById("add-process-btn").hidden = false;
}

function setVolume(frac) {
  // Expects input in range [0, 1].
  // Maps 0 to -72 dB, 1 to 0 dB.
  const db = 72 * (frac - 1);
  const gain = 10**(db/20)
  outputNode.gain.value = gain;
}

function audio_ready() {
  document.getElementById("status").innerText = statusText.offline;

  // Later, might want to create a new merger to grow input channels dynamically,
  // rather than commiting to a max size here.
  merger = audio.createChannelMerger(8);
  delay = audio.createDelay(128 / audio.sampleRate);
  merger.connect(delay);
  outputNode = audio.createGain();
  outputNode.gain.value = 0.2;
  outputNode.connect(audio.destination);
  const volumeSlider = document.getElementById("volume-slider");
  volumeSlider.value = 50;
  setVolume(0.5);
  volumeSlider.addEventListener('input', () => setVolume(volumeSlider.value / 100));
  // Position the listener at the origin.
  audio.listener.setPosition(0, 0, 0);

  // Create the default player.
  // In offline mode, this is just the first of potentially many local players.
  // In online mode, this is the only local player.
  createPlayer("me", true);
  players[localIDs++] = players["me"];
  const panner = players["me"].panner;

  let callback = ({x, y, angle}) => {
    // This method of choosing which speaker to move is a little annoying,
    // but it'll do for now.
    if (!players[selectedPlayer]) return;
    let panner = players[selectedPlayer].panner;
    panner.setPosition(x, y, -0.5);
    panner.setOrientation(Math.cos(angle), Math.sin(angle), 1);
    players[selectedPlayer].speaker = {x, y, angle};
  }
  field = new Field(document.getElementById("space-canvas"), callback);

  // Setup presets.
  presets.forEach(preset => {
    const button = createButton(preset.name);
    button.addEventListener("click", () => {
      if (!players[selectedPlayer]) return;
      let doc = players[selectedPlayer].editor.getDoc();
      doc.setValue(preset.code);
    });
    document.getElementById("presets").appendChild(button);
  });

  // Setup reset button.
  let resetButton = createButton("Reset");
  // Currently will *not* reset the timers in AudioWorkers.
  resetButton.addEventListener("click", () => {
    if (socket)
      socket.emit("reset")
    else
      resetClock();
  });
  document.getElementById("clock").appendChild(resetButton);

  // Setup add process button.
  let addProcessBtn = document.getElementById("add-process-btn");
  addProcessBtn.addEventListener("click", () => createPlayer(localIDs++, true));

  // Setup play, recording buttons.
  let playBtn = document.getElementById("play-btn");
  let playInput = document.getElementById("play-input");
  let recordingBtn = document.getElementById("toggle-recording-btn");
  playBtn.addEventListener("click", () => {
    playInput.click();
  });
  playInput.addEventListener("change", () => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result;
      console.log(text);
      playRecording(JSON.parse(text));
    };
    reader.readAsText(playInput.files[0]);
  })
  recordingBtn.addEventListener("click", () => {
    isRecording = !isRecording;
    recordingBtn.textContent = isRecording ? "Stop Recording" : "Start Recording";
    if (isRecording) {
      resetClock();
      resetPlayers();
      localIDs = 0;
      players[localIDs++] = players["me"];
      recordLog = [];
    } else {
      // Indicate which player is "me" by sticking it in the list first.
      let ids = [];
      for (let [id, player] of Object.entries(players)) {
        if (id === "me") continue;
        if (player == players["me"])
          ids.unshift(id);
        else
          ids.push(id);
      }
      const recording = {players: ids, events: recordLog};
      download("recording.kb", JSON.stringify(recording));
    }
  });

  on('code', ({id, state}) => {
    players[id].code = state;
    if (!players[id].isLocal || isPlaying)
      players[id].editor.getDoc().setValue(state);
    runCode(id);
  });

  on('editor', ({id, state: {cursor, selections, content}}) => {
    // For local events that aren't in playback, don't mess with the doc - it just gave us these values.
    if (!players[id].isLocal || isPlaying) {
      let doc = players[id].editor.getDoc();
      doc.setValue(content);
      doc.setCursor(cursor, null, {scroll: false});
      doc.setSelections(selections, 0, {scroll: false});
    }
  });

  on('speaker', ({id, state: {x, y, angle}}) => {
    // Debatable whether this `if` is good here.
    // We probably want a more general framework for these sort of intermittent updates.
    if (!players[id].isLocal || isPlaying) {
      players[id].panner.setPosition(x, y, -0.5);
      players[id].panner.setOrientation(Math.cos(angle), Math.sin(angle), 1);
      players[id].speaker = {x, y, angle};
      field.render();
    }
  });

  // Minor optimization: only set this off after seeing cursorActivity.
  function sendEditorState() {
    if (isPlaying)
      return;
    for (let [id, player] of Object.entries(players)) {
      if (!player.isLocal) continue;
      if (player == players["me"] && id !== "me") continue;
      let doc = player.editor.getDoc();
      // Might want to strip out irrelevant info, like selection stickiness and xRel.
      let editorState = {
        cursor: doc.getCursor(),
        selections: doc.listSelections(),
        content: doc.getValue()
      };
      // It is amazing that there is no reasonable way to compare objects (or maps) built-in to this language.
      if (JSON.stringify(editorState) !== JSON.stringify(player.lastEditorState)) {
        emit(id, 'editor', editorState);
        player.lastEditorState = editorState;
      }
    }
    setTimeout(sendEditorState, 200);
  }

  sendEditorState();

  function sendSpeakerState() {
    if (isPlaying)
      return;
    for (let [id, player] of Object.entries(players)) {
      if (!player.isLocal) continue;
      if (player == players["me"] && id !== "me") continue;
      const speaker = player.speaker;
      // It is amazing that there is no reasonable way to compare objects (or maps) built-in to this language.
      if (JSON.stringify(speaker) !== JSON.stringify(player.lastSpeakerState)) {
        emit(id, 'speaker', speaker);
        player.lastSpeakerState = speaker;
      }
    }
    setTimeout(sendSpeakerState, 200);
  }

  sendSpeakerState();

  // Run shortcut: run the selected player's snippet.
  document.addEventListener("keydown", event => {
    if (!players[selectedPlayer]) return;
    const isModDown = isMac ? event.metaKey : event.ctrlKey;
    if (!isModDown) { return; }
    const isEnter = event.code === "Enter";
    if (isEnter)  {
      event.preventDefault();
      emit(selectedPlayer, "code", players[selectedPlayer].editor.getDoc().getValue());
      // TODO no magic indices
      const runButton = players[selectedPlayer].elements[2];
      runButton.classList.add("down");
      setTimeout(() => {
        if (runButton.classList.contains("down")) runButton.classList.remove("down");
      }, 200);
    }
  });
}

function ready(fn) {
  if (document.attachEvent ? document.readyState === "complete" : document.readyState !== "loading") {
    fn();
  } else {
    document.addEventListener("DOMContentLoaded", fn);
  }
}


// Draws a canvas and tracks mouse click/drags on the canvas.
function Field(canvas, callback) {
  this.ANGLE_STEP = 0.2;
  this.canvas = canvas;
  this.center = {x: canvas.width/2, y: canvas.height/2};
  // TODO: just one here.
  this.speakers = [{x: 0, y: 0, angle: 0}];

  var obj = this;
  // Setup mouse listeners.
  canvas.addEventListener('mousemove', function() {
    obj.handleMouseMove.apply(obj, arguments)
  });
  canvas.addEventListener('wheel', function() {
    obj.handleMouseWheel.apply(obj, arguments);
  });

  this.listenerIcon = new Image();
  this.listenerIcon.src = 'headphones.svg';

  this.speakerIcon = new Image();
  this.speakerIcon.src = 'speaker.svg';

  // Render the scene when the icon has loaded.
  var ctx = this;
  this.listenerIcon.onload = function() {
    ctx.render();
  }
  this.callback = callback;
}

function getSpeakers() {
  let foo = [];
  for (let [id, player] of Object.entries(players)) {
    // Don't push this player twice.
    if (player !== players["me"] || id === "me")
      foo.push([id, player.speaker]);
  }
  return foo;
}

Field.prototype.render = function() {
  // Draw points onto the canvas element.
  var ctx = this.canvas.getContext('2d');
  ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

  ctx.save();
  ctx.translate(this.center.x - this.listenerIcon.width/2, this.center.y - this.listenerIcon.height/2)
  ctx.scale(2, 2);
  ctx.drawImage(this.listenerIcon, 0, 0);
  ctx.restore();
  ctx.fill();

  let speakers = getSpeakers();
  for (let [id, speaker] of speakers) {
    let x = speaker.x / 2 * this.canvas.width + this.center.x;
    let y = speaker.y / 2 * this.canvas.height + this.center.y;
    // Draw it rotated.
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(speaker.angle);
    ctx.font = '16px sans-serif';
    ctx.fillText(id, -20, -10);
    ctx.translate(-this.speakerIcon.width/2, -this.speakerIcon.height/2);
    ctx.drawImage(this.speakerIcon, 0, 0);
    ctx.restore();
  }
  ctx.fill();
};

Field.prototype.handleMouseMove = function(e) {
  if (e.buttons) {
    // Update the position.
    this.speakers[0].x = e.offsetX == undefined ? (e.layerX - e.currentTarget.offsetLeft) : e.offsetX;
    this.speakers[0].y = e.offsetY == undefined ? (e.layerY - e.currentTarget.offsetTop) : e.offsetY;

    this.render();
    this.callbackHelper();
  }
};

Field.prototype.handleMouseWheel = function(e) {
  e.preventDefault();
  this.speakers[0].angle += e.deltaY / 100;
  this.callbackHelper();
  this.render();
};

Field.prototype.callbackHelper = function() {
  if (this.callback) {
    // Position coordinates are in normalized canvas coordinates
    // with -0.5 < x, y < 0.5
    let x = (this.speakers[0].x - this.center.x) / this.canvas.width * 2;
    let y = (this.speakers[0].y - this.center.y) / this.canvas.height * 2;
    this.callback({x, y, angle: this.speakers[0].angle});
  }
}

ready(main);
