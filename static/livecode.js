/* global CodeMirror, AudioWorkletNode */

import { Scope } from "./Scope.js";

let audio;
// Map of id => {customNode, editor, elements, scopes}
let players = {me: {elements: []}};
let CustomAudioNode;
let processorCount = 0;
// TODO: get this from the server.
let startTime = Date.now() / 1000;
let clockUpdate = null;

let socket = null;
let player_id = null;


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
    name: "White Noise",
    code: `random() * 2 - 1`
  },
  {
    name: "Sine Wave",
    code: `sin(2 * pi * 666 * t)`
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

function stopAudio(id) {
  if (players[id].customNode !== undefined) {
    players[id].customNode.disconnect();
    players[id].customNode = undefined;
  }
}

function getCode(userCode, processorName) {
  // Ad-hoc (definitely not frame-precise) synchronization method.
  return `
  let t = ${getTime()};
  let pi = Math.PI;
  let sin = Math.sin;
  let random = Math.random;
  let x = 0, y = 0, z = 0;

  function loop(numFrames, out, sampleRate) {
    const amp = 0.1;
    for (let i = 0; i < numFrames; i++) {
      //const noise = Math.random() * 2 - 1;
      let val = ${userCode};
      out[i] = val * amp;
      t += 1 / sampleRate;
    }
  }

  class CustomProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
    }

    process(inputs, outputs, parameters) {
      const out = outputs[0][0];
      const numFrames = out.length;

      loop(numFrames, out, sampleRate);

      return true;
    }
  }

  registerProcessor("${processorName}", CustomProcessor);`;
}

function runAudioWorklet(id, workletUrl, processorName) {
  audio.audioWorklet.addModule(workletUrl).then(() => {
    stopAudio(id);

    let customNode = new CustomAudioNode(audio, processorName);

    customNode.connect(audio.destination);
    customNode.connect(players[id].analyser);
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
  resetButton.addEventListener("click", () => {
    startTime = Date.now() / 1000;
    clearTimeout(clockUpdate);
    updateClock();
  });
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
  let copy = document.createElement('div')
  copy.id = `p${id}-copy`
  copy.innerHTML = "TODO";

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

function getTime() {
  return Date.now() / 1000 - startTime;
}

function main() {

  socket = io();
  socket.on('connect', function() {
      console.log("connected!");
      socket.on('hello', ({id, players: current_players}) => {
        console.log('hello: I am', id, 'and there are', current_players);
        player_id = id;
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

    createScopes("me");

    createEditor();
  }

  updateClock();
}

function ready(fn) {
  if (document.attachEvent ? document.readyState === "complete" : document.readyState !== "loading"){
    fn();
  } else {
    document.addEventListener("DOMContentLoaded", fn);
  }
}

ready(main);
