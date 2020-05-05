/* global CodeMirror, AudioWorkletNode */

import { Scope } from "./Scope.js";

let audio;
// Map of id => {customNode, channel, editor, elements, scopes}
let players = {me: {elements: []}};
let CustomAudioNode;
let processorCount = 0;
// This is replaced when we connect to the server.
let startTime = Date.now() / 1000;
let clockUpdate = null;
let outputNode = null;

let socket = null;
let merger = null;


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
  {
    name: "c o m p u t e r m u s i c",
    code: `(sin(2*pi*y*t)+sin(2*pi*z*t))/2*(t<x?(t-x):(x=t+.2,y=rand()*500+500,z=rand()*1000+500,0))`
  }
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
    };

    document.body.addEventListener("touchend", resume, false);
    document.body.addEventListener("click", resume, false);
    document.body.addEventListener("keydown", resume, false);
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

  return `
  let t = 0;
  let pi = Math.PI;
  let sin = Math.sin;
  let rand = Math.random;
  let x = 0, y = 0, z = 0;

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
        out[i] = ${userCode};
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
    customNode.connect(outputNode);
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
  const onMouseUp = () => {
    button.classList.remove("down");
    document.removeEventListener("mouseup", onMouseUp, false);
  };
  const onMouseDown = () => {
    button.classList.add("down");
    document.addEventListener("mouseup", onMouseUp, false);
  };

  button.addEventListener("mousedown", onMouseDown);
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

  console.log("runCode", id, players[id].code, processorName);
  runAudioWorklet(id, url, processorName);
}

function createEditor() {
  const isMac = CodeMirror.keyMap.default === CodeMirror.keyMap.macDefault;

  const runKeys = isMac ? "Cmd-Enter" : "Ctrl-Enter";
  const runButton = createButton("Run: ");
  runButton.classList.add("run");
  addKeyCommandToButton(runButton, runKeys);

  function runEditorCode(editor) {
    const userCode = editor.getDoc().getValue();
    players["me"].code = userCode;
    socket.emit("code", userCode);
    runCode("me");
  }

  function playAudio(editor) {
    runEditorCode(editor);
  }

  // code mirror
  const editorWrap = document.getElementById("editor");
  if (editorWrap === null) { return; }
  const editor = CodeMirror(editorWrap, {
    mode: "javascript",
    value: presets[0].code,
    lineNumbers: false,
    lint: { esversion: 6 },
    viewportMargin: Infinity,
    tabSize: 2,
    scrollbarStyle: null
  });

  document.addEventListener("keydown", event => {
    const isModDown = isMac ? event.metaKey : event.ctrlKey;

    if (!isModDown) { return; }

    const isEnter = event.code === "Enter";
    const isPeriod = event.code === "Period";

    if (isEnter || isPeriod) { event.preventDefault(); }

    if (isEnter)  {
      playAudio(editor);
      runButton.classList.add("down");
      setTimeout(() => {
        if (runButton.classList.contains("down")) {
          runButton.classList.remove("down");
        }
      }, 200);
    }
  });

  const controlsEl = document.getElementById("controls");
  if (controlsEl !== null) {
    controlsEl.appendChild(runButton);
    runButton.addEventListener("click", () => playAudio(editor));

    presets.forEach(preset => {
      const button = createButton(preset.name);
      button.addEventListener("click", () => editor.getDoc().setValue(preset.code));
      const presetsEl = document.getElementById("presets");
      if (presetsEl !== null) { presetsEl.appendChild(button); }
    });
  }

  let resetButton = createButton("Reset");
  // Currently will *not* reset the timers in AudioWorkers.
  resetButton.addEventListener("click", () => socket.emit("reset"));
  document.getElementById("clock").appendChild(resetButton);
}

function createViewer(id) {
  let parent = document.getElementById("main");
  let id_box = document.createElement('div');
  id_box.id = `p${id}-id`
  id_box.classList.add('player-id');
  id_box.innerHTML = `Player ${id}`;
  let view = document.createElement('div');
  view.id = `p${id}-code`;
  const editor = CodeMirror(view, {
    mode: "javascript",
    value: players[id].code,
    lineNumbers: false,
    lint: { esversion: 6 },
    viewportMargin: Infinity,
    tabSize: 2,
    readOnly: true,
    scrollbarStyle: null,
  });
  setTimeout(() => editor.refresh(), 0);
  console.log(players);
  players[id].editor = editor;
  let copy = createButton("Copy 📄");
  copy.addEventListener('click', () => navigator.clipboard.writeText(players[id].code));

  let scopes = document.createElement('div')
  scopes.id = `p${id}-scopes`
  scopes.classList.add('scopes');
  players[id].elements = [id_box, view, copy, scopes];
  parent.appendChild(id_box);
  parent.appendChild(view);
  parent.appendChild(copy);
  parent.appendChild(scopes);
};

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

function main() {
  socket = io();
  socket.on('connect', function() {
      console.log("connected!");
      socket.on('hello', ({id, players: current_players, time}) => {
        startTime = Date.now() / 1000 - time;
        console.log('hello: I am', id, 'and there are', current_players);
        players[id] = players["me"];
        document.getElementById("status").innerHTML = `You are player ${id}.`
        document.getElementById("player-id").innerHTML = `You (${id})`
        console.log(current_players);
        for (let [id, code] of Object.entries(current_players)) {
          players[id] = {code: code};
          console.log(id, players);
          createViewer(id);
          createScopes(id);
          runCode(id);
        }
      })

      socket.on('join', (id) => {
        console.log('join', id)
        players[id] = {code: "0"};
        createViewer(id);
        createScopes(id);
      });

      socket.on('leave', (id) => {
        console.log('leave', id)
        stopAudio(id);
        for (let element of players[id].elements) {
          element.remove();
        }
        delete players[id];
      });

      socket.on('code', ({id, code}) => {
        players[id].code = code;
        players[id].editor.getDoc().setValue(code);
        runCode(id);
      })

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
      })
  });

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
    // Later, might want to create a new merger to grow input channels dynamically,
    // rather than commiting to a max size here.
    merger = audio.createChannelMerger(8);
    outputNode = audio.createGain(0.1);
    outputNode.connect(audio.destination);
    createScopes("me");
    createEditor();
  }

  updateClock();
}

function ready(fn) {
  if (document.attachEvent ? document.readyState === "complete" : document.readyState !== "loading") {
    fn();
  } else {
    document.addEventListener("DOMContentLoaded", fn);
  }
}

ready(main);
