/* global CodeMirror, AudioWorkletNode */

import { Scope } from "./Scope.js";

let audio;
// Map of id => {customNode, panner, channel, editor, editorContainer, elements, scopes}
// (Maybe it's time to make a real class?)
let players = {};
let CustomAudioNode;
let processorCount = 0;
// This is replaced when we connect to the server.
let startTime = Date.now() / 1000;
let clockUpdate;
let outputNode;

let socket = null;
let lastSent;
let merger;

let lastSentSpeakerPos;
let field;
let localIDs = 0;

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
    code: `rand() * 2 - 1`
  },
  {
    name: "Sine",
    code: `sin(2 * pi * 400 * t)`
  },
  // Note that Sawtooth and Square here have DC bias.
  {
    name: "Sawtooth",
    code: `(t % .005) / .005`
  },
  {
    name: "Square",
    code: `(t % .005) > .0025`
  },
  {
    name: "Chord",
    code: `[300,500,800].map(f=>sin(2*pi*f*t)).reduce((a,b)=>a+b)/3`
  },
  {
    name: "Rhythm",
    code: `t < x ? (t - x) : (x = t + choice(.6,.3,.2,.1), 0)`
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
    merger.disconnect(players[id].customNode);
    players[id].channel = null;
    players[id].customNode.disconnect();
    players[id].customNode = undefined;
  }
}

function getCode(userCode, processorName) {
  function generateNames() {
    // Note that this includes "me" to refer to current player.
    return Object.entries(players).map(([id, {channel}]) => {
      if (channel === null || channel === undefined)
        return '';
      let varName = (id == "me") ? "me" : `p${id}`;
      return `let ${varName} = inputs[0][${channel}][i];`
    }).join('\n');
  }

  function exportMath() {
    let names = ['abs', 'cbrt', 'clz32', 'imul', 'max', 'min', 'pow', 'sign', 'sqrt',
                 'exp', 'expm1', 'log', 'log1p', 'log10', 'log2',
                 'ceil', 'floor', 'fround', 'round', 'trunc',
                 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atanh', 'atan2',
                 'cos', 'cosh', 'hypot', 'sin', 'sinh', 'tan', 'tanh'];
    let aliases = {"rand": "random", "e": "E", "pi": "PI"};
    return names.map(name => `let ${name} = Math.${name}`)
                .concat(Object.entries(aliases).map(([alias, name]) => `let ${alias} = Math.${name}`))
                .join(';');
  }

  return `
  let t = 0;
  ${exportMath()}
  let x = 0, y = 0, z = 0;
  let now = ${getTime()};

  // These are still up for debate.
  let s = x => sin(2*pi*x);
  let r = rand;

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
        out[i] = Math.max(-1, Math.min(1, sample));
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

    merger.connect(customNode);
    customNode.connect(players[id].panner);
    customNode.connect(players[id].analyser);
    // TODO: may wish to do this earlier (or otherwise rethink this)
    // to guarantee that worklet code (generated earlier) matches channel map.
    players[id].channel = getNextChannel();
    customNode.connect(merger, 0, players[id].channel);
    players[id].customNode = customNode;
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
  const processorName = `processor-${id}-${processorCount++}`;
  const code = getCode(players[id].code, processorName);
  console.log("Generated code", code);
  const blob = new Blob([code], { type: "application/javascript" });
  const url = window.URL.createObjectURL(blob);

  // Trigger CSS animation.
  players[id].editorContainer.classList.add("ran");
  setTimeout(() => players[id].editorContainer.classList.remove("ran"), 100);
  console.log("runCode", id, players[id].code, processorName);
  runAudioWorklet(id, url, processorName);
}

function createEditor(id, isLocal) {
  let parent = document.getElementById("main");
  // Create containing elements.
  let nameBox = document.createElement('div');
  nameBox.id = `p${id}-id`
  nameBox.classList.add('player-id');
  // TODO alternate string for 'You' case, perhaps.
  nameBox.innerHTML = `Player ${id}`;
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
  });
  // TODO: Check if this is still necessary.
  setTimeout(() => editor.refresh(), 0);

  let button;
  if (isLocal) {
    // For local editors, create a Run button.
    const isMac = CodeMirror.keyMap.default === CodeMirror.keyMap.macDefault;

    const runKeys = isMac ? "Cmd-Enter" : "Ctrl-Enter";
    const runButton = createButton("Run ");
    runButton.classList.add("run");
    addKeyCommandToButton(runButton, runKeys);

    function runEditorCode(editor) {
      const userCode = editor.getDoc().getValue();
      players[id].code = userCode;
      if (id === "me" && socket != null)
        socket.emit("code", userCode);
      runCode(id);
    }

    button = runButton;
    runButton.addEventListener("click", () => runEditorCode(editor));

    if (id === "me") {
      // For the moment, the Run shortcut always runs the "player's" snippet.
      // TODO: Revisit this behavior for offline mode.
      document.addEventListener("keydown", event => {
        const isModDown = isMac ? event.metaKey : event.ctrlKey;
        if (!isModDown) { return; }
        const isEnter = event.code === "Enter";
        if (isEnter)  {
          event.preventDefault();
          runEditorCode(editor);
          runButton.classList.add("down");
          setTimeout(() => {
            if (runButton.classList.contains("down")) runButton.classList.remove("down");
          }, 200);
        }
      });
    }
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
  players[id] = {code: "0"};
  createEditor(id, isLocal);
  createScopes(id);

  let panner = audio.createPanner();
  panner.panningModel = 'HRTF';
  panner.coneOuterGain = 0.1;
  panner.coneOuterAngle = 180;
  panner.coneInnerAngle = 0;

  panner.connect(audio.destination);
  players[id].speaker = {x: 0, y: 0, angle: 0};
  players[id].panner = panner;
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

    audio = new AudioContext();
    resumeContextOnInteraction(audio);
  }

  updateClock();
}

function connect() {
  document.getElementById("status").innerHTML = "Connecting to server...";
  socket = io(); // TODO add destination here
  socket.on('connect', () => {
      document.getElementById("connect-box").hidden = true;
      document.getElementById("disconnect-box").hidden = false;
      console.log("connected!");
  });

  // TODO refactor so that we can retrigger these events in replay.
  socket.on('hello', ({id, players: current_players, time}) => {
    // TODO destroy any extra offline players that are hanging around; reset localIDs.
    startTime = Date.now() / 1000 - time;
    console.log('hello: I am', id, 'and there are', current_players);
    players[id] = players["me"];
    document.getElementById("status").innerHTML = `You are player ${id}.`
    document.getElementById("player-id").innerHTML = `You (${id})`
    console.log(current_players);
    for (let {id, code, speaker} of current_players) {
      createPlayer(id, false);
      players[id].editor.getDoc().setValue(code);
      runCode(id);
      players[id].panner.setPosition(speaker.x, speaker.y, -0.5);
      players[id].panner.setOrientation(Math.cos(speaker.angle), -Math.sin(speaker.angle), 1);
    }
  });

  socket.on('join', (id) => {
    console.log('join', id)
    createPlayer(id);
    field.render();
  });

  socket.on('leave', (id) => {
    console.log('leave', id)
    stopAudio(id);
    players[id].panner.disconnect();
    for (let element of players[id].elements) {
      element.remove();
    }
    delete players[id];
    field.render();
  });

  socket.on('code', ({id, code}) => {
    players[id].code = code;
    players[id].editor.getDoc().setValue(code);
    runCode(id);
  });

  socket.on('reset', () => {
    startTime = Date.now() / 1000;
    clearTimeout(clockUpdate);
    updateClock();
    for (let player of Object.values(players)) {
      // I wonder if there's a way to broadcast to all AudioWorkletNodes at once?
      // Maybe they could all have a reference to one SharedArrayBuffer?
      if (player.customNode)
        player.customNode.port.postMessage(getTime());
    }
  });

  socket.on('editor', ({id, state: {cursor, selections, content}}) => {
    let doc = players[id].editor.getDoc();
    doc.setValue(content);
    doc.setCursor(cursor);
    doc.setSelections(selections);
  });

  socket.on('speaker', ({id, state: {x, y, angle}}) => {
    players[id].panner.setPosition(x, y, -0.5);
    players[id].panner.setOrientation(Math.cos(angle), -Math.sin(angle), 1);
    players[id].speaker = {x, y, angle};
    field.render();
  });

  function sendSpeakerState() {
    const speaker = players["me"].speaker;
    // It is amazing that there is no reasonable way to compare objects (or maps) built-in to this language.
    if (JSON.stringify(speaker) !== JSON.stringify(lastSentSpeakerPos)) {
      console.log("sending speaker updates", speaker);
      socket.emit('speaker', speaker);
      lastSentSpeakerPos = speaker;
    }
    setTimeout(sendSpeakerState, 200);
  }

  sendSpeakerState();

  // TODO fix
  // Minor optimization: only set this off after seeing cursorActivity.
  function sendEditorState() {
    // Might want to strip out irrelevant info, like selection stickiness and xRel.
    let editorState = {
      cursor: doc.getCursor(),
      selections: doc.listSelections(),
      content: doc.getValue()
    };
    // It is amazing that there is no reasonable way to compare objects (or maps) built-in to this language.
    if (JSON.stringify(editorState) !== JSON.stringify(lastSent)) {
      console.log("sending updates", editorState);
      socket.emit('editor', editorState);
      lastSent = editorState;
    }
    setTimeout(sendEditorState, 200);
  }

  sendEditorState();
}

function audio_ready() {
  document.getElementById("status").innerHTML = "You are offline. To play with others, join a server.";

  // Later, might want to create a new merger to grow input channels dynamically,
  // rather than commiting to a max size here.
  merger = audio.createChannelMerger(8);
  outputNode = audio.createGain(0.1);
  outputNode.connect(audio.destination);
  // Position the listener at the origin.
  audio.listener.setPosition(0, 0, 0);

  // Create the default player.
  // In offline mode, this is just the first of potentially many local players.
  // In online mode, this is the only local player.
  createPlayer("me", true);
  players[localIDs++] = players["me"];
  const panner = players["me"].panner;

  let callback = ({x, y, angle}) => {
    panner.setPosition(x, y, -0.5);
    panner.setOrientation(Math.cos(angle), -Math.sin(angle), 1);
    players["me"].speaker = {x, y, angle};
  }
  field = new Field(document.getElementById("test-canvas"), callback);

  document.getElementById("connect-btn").addEventListener("click", connect);

  // Setup presets.
  presets.forEach(preset => {
    const button = createButton(preset.name);
    const doc = players["me"].editor.getDoc();
    button.addEventListener("click", () => doc.setValue(preset.code));
    document.getElementById("presets").appendChild(button);
  });

  // Setup reset button.
  let resetButton = createButton("Reset");
  // Currently will *not* reset the timers in AudioWorkers.
  resetButton.addEventListener("click", () => socket.emit("reset"));
  document.getElementById("clock").appendChild(resetButton);

  // Setup add process button.
  let addProcessBtn = document.getElementById("add-process-btn");
  addProcessBtn.addEventListener("click", () => createPlayer(localIDs++, true));
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
  this.listenerIcon.src = 'static/headphones.svg';

  this.speakerIcon = new Image();
  this.speakerIcon.src = 'static/speaker.svg';

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